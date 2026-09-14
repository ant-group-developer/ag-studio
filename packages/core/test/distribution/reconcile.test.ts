import { describe, expect, it } from "vitest";
import { ChannelConfigSchema, isHarnessError, newId, type ChannelPackage, type ExternalOperation, type LookupOutcome, type PublicationJob, type Publisher, type PublisherChannel } from "@harness/contracts";
import { ChannelRegistry, ExternalOperationJournal, Planner, reconcilePublication, type LoadedChannel } from "../../src/index.js";
import { openTempStore, seedStage } from "../helpers.js";

const sha = "sha256:" + "a".repeat(64);

class TestPublisher implements Publisher {
  readonly name = "test-publisher";
  calls: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }[] = [];
  constructor(private readonly outcome: LookupOutcome) {}
  async upload(): Promise<never> { throw new Error("not used in reconcile tests"); }
  async schedule(): Promise<never> { throw new Error("not used in reconcile tests"); }
  async lookup(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome> {
    this.calls.push(p);
    return this.outcome;
  }
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

function world(store: ReturnType<typeof openTempStore>["store"], clock: ReturnType<typeof openTempStore>["clock"]) {
  const { runId, stage } = seedStage(store, { key: "upload", state: "NEEDS_RECONCILIATION" });
  const now = clock.now();
  const pkg: ChannelPackage = {
    schema_version: "harness.channel-package/v1", package_id: newId("channel_package"), channel_id: "channel-a",
    variant_id: newId("content_variant"), content_id: newId("content_item"), library_item_id: newId("library_item"),
    run_id: runId, episode_no: 5, episode_dir: "D:/legacy-channel-a/outputs/project-01/episodes/episode-05",
    manifest_digest: sha, video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"),
    video_checksum: sha, thumbnail_checksum: sha,
    metadata: { title: "Episode 5", description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" },
    hypothesis: {
      schema_version: "harness.hypothesis/v1", hypothesis_id: newId("hypothesis"),
      basis: [{ kind: "market", note: "n" }], chosen: { title: "Episode 5", thumbnail_candidate: "t.png", overlay_text: [], angle: "" },
      rejected: [{ title: "Alt", angle: "", why: "weaker" }], expected: { metric: "ctr", target: 0.05, horizon_hours: 72 },
      status: "open", created_at: now,
    },
    metadata_revision: 1, channel_config_revision: sha, status: "committed", created_at: now, updated_at: now,
  };
  store.insertChannelPackage(pkg);

  const op: ExternalOperation = {
    schema_version: "harness.external-operation/v1", operation_id: newId("external_operation"),
    run_id: runId, stage_run_id: stage.stage_run_id, attempt_id: newId("attempt"),
    provider: "youtube", kind: "upload", target: "channel-a", idempotency_key: sha,
    status: "NEEDS_RECONCILIATION", provider_ref: null, receipt: null, cost_usd: 0, created_at: now, updated_at: now,
  };
  store.insertExternalOperation(op);

  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: pkg.package_id,
    channel_id: "channel-a", library_item_id: pkg.library_item_id, run_id: runId,
    idempotency_key: sha, state: "NEEDS_RECONCILIATION", youtube_video_id: null, operation_id: op.operation_id,
    scheduled_at: null, published_at: null, last_verified_at: null, note: null, receipt: null, created_at: now, updated_at: now,
  };
  store.insertPublicationJob(job);

  return { runId, stage, pkg, op, job };
}

describe("reconcilePublication", () => {
  it("moves a job found private (no future publish_at) to PROCESSING, confirms the operation, and releases the upload stage", async () => {
    const { store, clock } = openTempStore();
    const { stage, op, job } = world(store, clock);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: true, video_id: "yt-99", visibility: "private" });

    const report = await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, job.publication_job_id);

    expect(report).toEqual({ job_id: job.publication_job_id, from: "NEEDS_RECONCILIATION", to: "PROCESSING", video_id: "yt-99", stage_state: "READY" });
    expect(publisher.calls).toEqual([{ channel: expect.objectContaining({ channel_id: "channel-a" }), title: "Episode 5", since: op.created_at }]);

    const updatedJob = store.getPublicationJob(job.publication_job_id)!;
    expect(updatedJob.state).toBe("PROCESSING");
    expect(updatedJob.youtube_video_id).toBe("yt-99");

    expect(store.getExternalOperation(op.operation_id)!.status).toBe("CONFIRMED");
    expect(store.getStageRun(stage.stage_run_id)!.state).toBe("READY");
  });

  it("moves a job not found on the provider to READY, marks the operation FAILED, and releases the upload stage", async () => {
    const { store, clock } = openTempStore();
    const { stage, op, job } = world(store, clock);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: false, reason: "no matching video" });

    const report = await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, job.publication_job_id);

    expect(report).toEqual({ job_id: job.publication_job_id, from: "NEEDS_RECONCILIATION", to: "READY", video_id: null, stage_state: "READY" });

    const updatedJob = store.getPublicationJob(job.publication_job_id)!;
    expect(updatedJob.state).toBe("READY");
    expect(updatedJob.youtube_video_id).toBeNull();

    expect(store.getExternalOperation(op.operation_id)!.status).toBe("FAILED");
    expect(store.getStageRun(stage.stage_run_id)!.state).toBe("READY");
  });

  it("throws on an error:true lookup and leaves the job and operation exactly as they were -- a failed lookup must never trigger a re-upload", async () => {
    const { store, clock } = openTempStore();
    const { stage, op, job } = world(store, clock);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: false, error: true, reason: "studio DOM changed" });

    await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, job.publication_job_id)
      .then(() => { throw new Error("expected reconcilePublication to throw"); }, (e) => {
        expect(isHarnessError(e, "CONNECTION_LOST")).toBe(true);
        expect((e as Error).message).toContain("studio DOM changed");
      });

    const unchanged = store.getPublicationJob(job.publication_job_id)!;
    expect(unchanged.state).toBe("NEEDS_RECONCILIATION");
    expect(unchanged.youtube_video_id).toBeNull();
    expect(store.getExternalOperation(op.operation_id)!.status).toBe("NEEDS_RECONCILIATION");
    expect(store.getStageRun(stage.stage_run_id)!.state).toBe("NEEDS_RECONCILIATION");
  });

  it("clears youtube_video_id when a job with one is definitively not found and goes back to READY", async () => {
    const { store, clock } = openTempStore();
    const { job } = world(store, clock);
    store.updatePublicationJob({ ...job, youtube_video_id: "yt-gone" });
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: false, reason: "no matching video" });

    const report = await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, job.publication_job_id);
    expect(report.to).toBe("READY");
    expect(report.video_id).toBeNull();
    expect(store.getPublicationJob(job.publication_job_id)!.youtube_video_id).toBeNull();
  });

  it("notes that nothing will book the slot when a PROCESSING job's run has no live upload/schedule stage", async () => {
    const { store, clock } = openTempStore();
    const { job } = world(store, clock);
    // A job whose run has no upload/schedule stage row left to move it along (the run is long gone, or the
    // video was put up by hand): PROCESSING would otherwise look healthy while nothing ever schedules it.
    const orphan: PublicationJob = { ...job, publication_job_id: newId("publication_job"), run_id: newId("run"), operation_id: null, idempotency_key: "sha256:" + "b".repeat(64) };
    store.insertPublicationJob(orphan);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: true, video_id: "yt-99", visibility: "private" });

    const report = await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, orphan.publication_job_id);
    expect(report.to).toBe("PROCESSING");
    expect(report.note).toContain("run has no live stage");
    expect(store.getPublicationJob(orphan.publication_job_id)!.note).toBe(report.note);
  });

  it("adds no note when the run still has a live stage to carry the job on", async () => {
    const { store, clock } = openTempStore();
    const { job } = world(store, clock);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: true, video_id: "yt-99", visibility: "private" });

    const report = await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, job.publication_job_id);
    expect(report.to).toBe("PROCESSING");
    expect(report.note).toBeUndefined();
  });

  it("throws INVALID_TRANSITION when the job is not NEEDS_RECONCILIATION", async () => {
    const { store, clock } = openTempStore();
    const { job } = world(store, clock);
    // reconcilePublication only accepts a NEEDS_RECONCILIATION job; insert a second job that starts life
    // already PROCESSING to exercise the guard without an invalid state transition.
    // (a distinct idempotency_key: only one live job per key, enforced by a partial unique index)
    const processingJob: PublicationJob = { ...job, publication_job_id: newId("publication_job"), state: "PROCESSING", idempotency_key: "sha256:" + "c".repeat(64) };
    store.insertPublicationJob(processingJob);
    const journal = new ExternalOperationJournal(store, { name: "unused", dispatch: async () => { throw new Error("unused"); }, lookup: async () => ({ found: false }) }, clock);
    const planner = new Planner(store);
    const publisher = new TestPublisher({ found: false });

    await reconcilePublication({ store, publisher, channels: makeChannels(), journal, planner, clock }, processingJob.publication_job_id)
      .then(() => { throw new Error("expected reconcilePublication to throw"); }, (e) => { expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true); });
  });
});
