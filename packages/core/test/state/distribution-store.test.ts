import { describe, expect, it } from "vitest";
import { ChannelPackageSchema, isHarnessError, newId, PublicationJobSchema, type ChannelPackage, type EventInput, type PublicationJob } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T01:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1",
  hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market", note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png" },
  rejected: [{ title: "Alt Title", why: "weaker hook" }],
  expected: { metric: "ctr", target: 0.05, horizon_hours: 72 },
  created_at: now,
};

function channelPackage(overrides: Record<string, unknown> = {}): ChannelPackage {
  return ChannelPackageSchema.parse({
    schema_version: "harness.channel-package/v1",
    package_id: newId("channel_package"),
    channel_id: "channel-a",
    variant_id: newId("content_variant"),
    content_id: newId("content_item"),
    library_item_id: newId("library_item"),
    run_id: newId("run"),
    episode_no: 1,
    episode_dir: "episode-01",
    manifest_digest: sha("a"),
    video_artifact_id: newId("artifact"),
    thumbnail_artifact_id: newId("artifact"),
    video_checksum: sha("b"),
    thumbnail_checksum: sha("c"),
    metadata: { title: "Episode 1" },
    hypothesis: SAMPLE_HYPOTHESIS,
    metadata_revision: 1,
    channel_config_revision: sha("9"),
    status: "draft",
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function publicationJob(overrides: Record<string, unknown> = {}): PublicationJob {
  return PublicationJobSchema.parse({
    schema_version: "harness.publication-job/v1",
    publication_job_id: newId("publication_job"),
    package_id: newId("channel_package"),
    channel_id: "channel-a",
    library_item_id: newId("library_item"),
    run_id: newId("run"),
    idempotency_key: sha("d"),
    state: "READY",
    youtube_video_id: null,
    operation_id: null,
    scheduled_at: null,
    published_at: null,
    last_verified_at: null,
    note: null,
    receipt: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function publicationEvent(run_id: string, event_type: string): EventInput {
  return {
    run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: null, content_id: null,
    variant_id: null, workflow_release: null, severity: "info", event_type, payload: {},
  };
}

describe("migration 0004", () => {
  it("adds channel_package, publication_job and channel_sequence tables", () => {
    const { store } = openTempStore();
    expect(store.listAppliedMigrations()).toContain("0004_distribution.sql");
    expect(store.tableNames()).toEqual(expect.arrayContaining(["channel_package", "publication_job", "channel_sequence"]));
  });
});

describe("allocateEpisodeNo", () => {
  it("starts a channel's sequence at the given start, then increments on each call", () => {
    const { store } = openTempStore();
    expect(store.allocateEpisodeNo("c1", 15)).toBe(15);
    expect(store.allocateEpisodeNo("c1", 15)).toBe(16);
  });
  it("keeps sequences independent per channel", () => {
    const { store } = openTempStore();
    store.allocateEpisodeNo("c1", 15);
    expect(store.allocateEpisodeNo("c2", 1)).toBe(1);
  });
});

describe("channel_package", () => {
  it("inserts, gets and lists filtered by run_id and status", () => {
    const { store } = openTempStore();
    const runId = newId("run");
    const pkg = channelPackage({ run_id: runId, status: "draft" });
    store.insertChannelPackage(pkg);
    expect(store.getChannelPackage(pkg.package_id)).toEqual(pkg);
    const other = channelPackage({ status: "draft" });
    store.insertChannelPackage(other);
    expect(store.listChannelPackages({ run_id: runId })).toEqual([pkg]);
    expect(store.listChannelPackages({ status: "draft" })).toHaveLength(2);
    expect(store.listChannelPackages({ status: "committed" })).toHaveLength(0);
  });
  it("updateChannelPackage overwrites status and is visible to listChannelPackages", () => {
    const { store } = openTempStore();
    const pkg = channelPackage({ status: "draft" });
    store.insertChannelPackage(pkg);
    store.updateChannelPackage({ ...pkg, status: "committed", updated_at: later });
    expect(store.listChannelPackages({ status: "committed" }).map((p) => p.package_id)).toEqual([pkg.package_id]);
    expect(store.getChannelPackage(pkg.package_id)?.status).toBe("committed");
  });
});

describe("publication_job transitions", () => {
  it("transition moves state and appends an event", () => {
    const { store } = openTempStore();
    const runId = newId("run");
    const job = publicationJob({ run_id: runId, state: "READY" });
    store.insertPublicationJob(job);
    store.transition("publication_job", job.publication_job_id, "READY", "UPLOADING", publicationEvent(runId, "publication.uploading"));
    expect(store.getPublicationJob(job.publication_job_id)?.state).toBe("UPLOADING");
    expect(store.listEvents({ run_id: runId }).map((e) => e.event_type)).toEqual(["publication.uploading"]);
  });
  it("rejects an invalid transition", () => {
    const { store } = openTempStore();
    const runId = newId("run");
    const job = publicationJob({ run_id: runId, state: "READY" });
    store.insertPublicationJob(job);
    const attempt = () => store.transition("publication_job", job.publication_job_id, "READY", "PUBLISHED", publicationEvent(runId, "publication.published"));
    expect(attempt).toThrow();
    try { attempt(); } catch (e) { expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true); }
  });
  it("rejects a transition with the wrong expected-from state", () => {
    const { store } = openTempStore();
    const runId = newId("run");
    const job = publicationJob({ run_id: runId, state: "READY" });
    store.insertPublicationJob(job);
    store.transition("publication_job", job.publication_job_id, "READY", "UPLOADING", publicationEvent(runId, "publication.uploading"));
    const attempt = () => store.transition("publication_job", job.publication_job_id, "READY", "UPLOADING", publicationEvent(runId, "publication.uploading"));
    expect(attempt).toThrow();
    try { attempt(); } catch (e) { expect(isHarnessError(e, "STALE_STATE")).toBe(true); }
  });
});

describe("updatePublicationJob", () => {
  it("refuses when the passed state differs from the stored column", () => {
    const { store } = openTempStore();
    const job = publicationJob({ state: "READY" });
    store.insertPublicationJob(job);
    store.transition("publication_job", job.publication_job_id, "READY", "UPLOADING", publicationEvent(job.run_id, "publication.uploading"));
    const attempt = () => store.updatePublicationJob({ ...job, state: "PUBLISHED" });
    expect(attempt).toThrow();
    try { attempt(); } catch (e) { expect(isHarnessError(e, "STALE_STATE")).toBe(true); }
  });
  it("writes fields other than state when the state matches the stored column", () => {
    const { store } = openTempStore();
    const channelId = "channel-scoped";
    const job = publicationJob({ channel_id: channelId, state: "READY", scheduled_at: null });
    store.insertPublicationJob(job);
    store.updatePublicationJob({ ...job, scheduled_at: later, updated_at: later });
    expect(store.getPublicationJob(job.publication_job_id)?.scheduled_at).toBe(later);
    expect(store.listPublicationJobs({ channel_id: channelId, state: "READY" }).map((j) => j.publication_job_id)).toEqual([job.publication_job_id]);
  });
});

describe("publication_job.idempotency_key uniqueness", () => {
  it("refuses a second live job with the same key, and allows one once the first is FAILED (spec §2.5)", () => {
    const { store } = openTempStore();
    const key = sha("7");
    const first = publicationJob({ idempotency_key: key, state: "READY" });
    store.insertPublicationJob(first);

    const second = publicationJob({ idempotency_key: key, state: "READY" });
    expect(() => store.insertPublicationJob(second)).toThrow();

    // `publish cancel` (READY -> FAILED) frees the key: the partial index only covers live rows.
    store.transition("publication_job", first.publication_job_id, "READY", "FAILED", publicationEvent(first.run_id, "publication.cancelled"));
    expect(() => store.insertPublicationJob(second)).not.toThrow();
    expect(store.listPublicationJobs({ idempotency_key: key }).map((j) => j.state).sort()).toEqual(["FAILED", "READY"]);
  });
});

describe("listPublicationJobs", () => {
  it("filters by idempotency_key", () => {
    const { store } = openTempStore();
    const key = sha("e");
    const job = publicationJob({ idempotency_key: key });
    store.insertPublicationJob(job);
    store.insertPublicationJob(publicationJob({ idempotency_key: sha("f") }));
    expect(store.listPublicationJobs({ idempotency_key: key }).map((j) => j.publication_job_id)).toEqual([job.publication_job_id]);
  });
});
