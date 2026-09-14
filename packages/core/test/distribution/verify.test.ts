import { describe, expect, it } from "vitest";
import { ChannelConfigSchema, newId, type LookupOutcome, type PublicationJob, type Publisher, type PublisherChannel } from "@harness/contracts";
import { ChannelRegistry, verifyScheduled, type LoadedChannel } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const sha = "sha256:" + "a".repeat(64);

class TestPublisher implements Publisher {
  readonly name = "test-publisher";
  calls: { channel: PublisherChannel; video_id?: string; title?: string }[] = [];
  constructor(private readonly outcome: LookupOutcome | (() => LookupOutcome)) {}
  async upload(): Promise<never> { throw new Error("not used in verify tests"); }
  async schedule(): Promise<never> { throw new Error("not used in verify tests"); }
  async lookup(p: { channel: PublisherChannel; video_id?: string; title?: string }): Promise<LookupOutcome> {
    this.calls.push(p);
    return typeof this.outcome === "function" ? this.outcome() : this.outcome;
  }
}

class ThrowingPublisher implements Publisher {
  readonly name = "throwing-publisher";
  calls = 0;
  async upload(): Promise<never> { throw new Error("not used in verify tests"); }
  async schedule(): Promise<never> { throw new Error("not used in verify tests"); }
  async lookup(): Promise<LookupOutcome> { this.calls += 1; throw new Error("provider unreachable"); }
}

function makeChannels(): ChannelRegistry {
  const config = ChannelConfigSchema.parse({
    schema_version: "harness.channel-config/v1", channel_id: "channel-a", display_name: "Channel A", portfolio_id: "portfolio-main",
    repo_dir: "D:/legacy-channel-a", youtube: { expected_channel_id: "UCfake000000000000000001", account_email_ref: "secret://youtube-c1/email" },
    publication: { timezone: "America/New_York", publish_times: ["13:00"] },
  });
  const loaded: LoadedChannel = { config, dir: "D:/legacy-channel-a", config_revision: sha };
  return new ChannelRegistry([loaded]);
}

function sampleJob(store: ReturnType<typeof openTempStore>["store"], overrides: Partial<PublicationJob> = {}): PublicationJob {
  const now = "2026-09-14T00:00:00.000Z";
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: newId("channel_package"),
    channel_id: "channel-a", library_item_id: newId("library_item"), run_id: newId("run"),
    idempotency_key: sha, state: "SCHEDULED", youtube_video_id: "yt-1", operation_id: null,
    scheduled_at: "2026-09-13T00:00:00.000Z", published_at: null, last_verified_at: null, note: null, receipt: null,
    created_at: now, updated_at: now, ...overrides,
  };
  store.insertPublicationJob(job);
  return job;
}

describe("verifyScheduled", () => {
  it("moves a job to PUBLISHED when the provider reports it public", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const job = sampleJob(store);
    const publisher = new TestPublisher({ found: true, video_id: "yt-1", visibility: "public" });
    const report = await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 0 });
    expect(report.published).toEqual([job.publication_job_id]);
    expect(report.checked).toEqual([job.publication_job_id]);
    const updated = store.getPublicationJob(job.publication_job_id)!;
    expect(updated.state).toBe("PUBLISHED");
    expect(updated.published_at).toBe(clock.now());
    expect(updated.last_verified_at).toBe(clock.now());
  });

  it("moves a job to NEEDS_RECONCILIATION when the provider reports it private with no publish_at", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const job = sampleJob(store);
    const publisher = new TestPublisher({ found: true, video_id: "yt-1", visibility: "private" });
    const report = await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 0 });
    expect(report.reconcile).toEqual([job.publication_job_id]);
    const updated = store.getPublicationJob(job.publication_job_id)!;
    expect(updated.state).toBe("NEEDS_RECONCILIATION");
  });

  it("keeps a job SCHEDULED when the provider still reports a future publish_at", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const job = sampleJob(store);
    const futurePublishAt = "2026-09-20T00:00:00.000Z";
    const publisher = new TestPublisher({ found: true, video_id: "yt-1", visibility: "scheduled", publish_at: futurePublishAt });
    const report = await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 0 });
    expect(report.checked).toEqual([job.publication_job_id]);
    expect(report.published).toEqual([]);
    expect(report.reconcile).toEqual([]);
    const updated = store.getPublicationJob(job.publication_job_id)!;
    expect(updated.state).toBe("SCHEDULED");
    expect(updated.scheduled_at).toBe(futurePublishAt);
  });

  it("does not call lookup when scheduled_at + graceHours has not yet passed", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    sampleJob(store, { scheduled_at: "2026-09-14T01:00:00.000Z" });
    const publisher = new TestPublisher({ found: false });
    const report = await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 2 });
    expect(publisher.calls).toHaveLength(0);
    expect(report.checked).toEqual([]);
  });

  it("records an error on the first lookup failure, then reconciles after a second consecutive failure", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const job = sampleJob(store);
    const publisher = new ThrowingPublisher();
    const deps = { store, publisher, channels: makeChannels(), clock, graceHours: 0 };

    const first = await verifyScheduled(deps);
    expect(first.errors).toEqual([{ job_id: job.publication_job_id, message: expect.stringContaining("provider unreachable") }]);
    expect(first.reconcile).toEqual([]);
    expect(store.getPublicationJob(job.publication_job_id)!.state).toBe("SCHEDULED");

    const second = await verifyScheduled(deps);
    expect(second.reconcile).toEqual([job.publication_job_id]);
    expect(second.errors).toEqual([]);
    expect(store.getPublicationJob(job.publication_job_id)!.state).toBe("NEEDS_RECONCILIATION");
    expect(publisher.calls).toBe(2);
  });

  it("resets the verify_failures counter in the receipt after a successful lookup", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const job = sampleJob(store, { receipt: { verify_failures: 1 } });
    const publisher = new TestPublisher({ found: true, video_id: "yt-1", visibility: "public" });
    await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 0 });
    const updated = store.getPublicationJob(job.publication_job_id)!;
    expect(updated.receipt).toMatchObject({ verify_failures: 0 });
  });

  it("warns on a PROCESSING job older than 24 hours", async () => {
    const { store, clock } = openTempStore("2026-09-14T00:00:00.000Z");
    const staleJob = sampleJob(store, {
      state: "PROCESSING", scheduled_at: null, updated_at: "2026-09-12T00:00:00.000Z", created_at: "2026-09-12T00:00:00.000Z",
    });
    const publisher = new TestPublisher({ found: false });
    const report = await verifyScheduled({ store, publisher, channels: makeChannels(), clock, graceHours: 0 });
    expect(report.warnings).toEqual([{ job_id: staleJob.publication_job_id, message: expect.any(String) }]);
  });
});
