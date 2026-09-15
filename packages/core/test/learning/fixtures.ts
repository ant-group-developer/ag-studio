import { newId, ChannelConfigSchema, type ChannelPackage, type Hypothesis, type PublicationJob, type VideoMetrics } from "@harness/contracts";
import { ChannelRegistry, type LoadedChannel, type SqliteStateStore } from "../../src/index.js";

export const sha = (c: string) => "sha256:" + c.repeat(64);
export const T0 = "2026-09-11T00:00:00.000Z";

let idempotencyCounter = 0;
/** A distinct sha256-shaped checksum per call, so fixtures can insert several PublicationJobs without
 * colliding on `publication_job.idempotency_key`'s UNIQUE index. */
function uniqueChecksum(): string {
  idempotencyCounter += 1;
  return "sha256:" + idempotencyCounter.toString(16).padStart(64, "0");
}

export function makeChannel(o: {
  channel_id?: string;
  learning?: Partial<{ horizon_hours: number; recollect_hours: number[]; min_impressions: number; min_samples: number }>;
} = {}): LoadedChannel {
  const config = ChannelConfigSchema.parse({
    schema_version: "harness.channel-config/v1",
    channel_id: o.channel_id ?? "channel-a",
    display_name: "Channel A",
    portfolio_id: "portfolio-main",
    repo_dir: "D:/legacy-channel-a",
    youtube: { expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", account_email_ref: "secret://youtube/channel-a-email" },
    publication: { timezone: "America/New_York", publish_times: ["13:00"] },
    learning: o.learning,
  });
  return { config, dir: "D:/legacy-channel-a", config_revision: sha("e") };
}

export function makeRegistry(channels: LoadedChannel[]): ChannelRegistry {
  return new ChannelRegistry(channels);
}

export function insertPublishedJob(store: SqliteStateStore, o: {
  channel_id?: string; published_at: string; youtube_video_id?: string | null; package_id?: string; run_id?: string; receipt?: Record<string, unknown> | null;
}): PublicationJob {
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1",
    publication_job_id: newId("publication_job"),
    package_id: o.package_id ?? newId("channel_package"),
    idempotency_key: uniqueChecksum(),
    state: "PUBLISHED",
    youtube_video_id: o.youtube_video_id === undefined ? "yt-1" : o.youtube_video_id,
    receipt: o.receipt ?? null,
    created_at: T0, updated_at: T0,
    channel_id: o.channel_id ?? "channel-a",
    library_item_id: newId("library_item"),
    run_id: o.run_id ?? newId("run"),
    operation_id: null,
    scheduled_at: null,
    published_at: o.published_at,
    last_verified_at: null,
    note: null,
  };
  store.insertPublicationJob(job);
  return job;
}

export function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    schema_version: "harness.hypothesis/v1",
    hypothesis_id: newId("hypothesis"),
    basis: [{ kind: "market", note: "competitors post at 9am" }],
    chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png", overlay_text: [], angle: "" },
    rejected: [{ title: "Alt Title", angle: "", why: "weaker hook" }],
    expected: { metric: "views_72h", target: 100, horizon_hours: 72 },
    status: "open",
    created_at: T0,
    ...overrides,
  };
}

export function makeCommittedPackage(o: {
  channel_id?: string; package_id?: string; content_id?: string; variant_id?: string; library_item_id?: string; run_id?: string;
  episode_no?: number; hypothesis?: Hypothesis;
} = {}): ChannelPackage {
  return {
    schema_version: "harness.channel-package/v1",
    package_id: o.package_id ?? newId("channel_package"),
    channel_id: o.channel_id ?? "channel-a",
    variant_id: o.variant_id ?? newId("content_variant"),
    manifest_digest: sha("1"),
    video_artifact_id: newId("artifact"),
    thumbnail_artifact_id: newId("artifact"),
    metadata_revision: 1,
    channel_config_revision: sha("e"),
    created_at: T0,
    content_id: o.content_id ?? newId("content_item"),
    library_item_id: o.library_item_id ?? newId("library_item"),
    run_id: o.run_id ?? newId("run"),
    episode_no: o.episode_no ?? 1,
    episode_dir: "D:/legacy-channel-a/episode-01",
    metadata: { title: "Episode 1", description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" },
    hypothesis: o.hypothesis ?? makeHypothesis(),
    video_checksum: sha("2"),
    thumbnail_checksum: sha("3"),
    status: "committed",
    updated_at: T0,
  };
}

export function makeMetric(o: {
  publication_job_id: string; channel_id?: string; video_id?: string; collected_at?: string; age_hours: number; source?: "studio" | "manual";
  views?: number; impressions?: number | null; ctr_pct?: number | null; avg_view_sec?: number | null; retention30_pct?: number | null;
}): VideoMetrics {
  return {
    schema_version: "harness.video-metrics/v1",
    metric_id: newId("video_metrics"),
    publication_job_id: o.publication_job_id,
    channel_id: o.channel_id ?? "channel-a",
    video_id: o.video_id ?? "yt-1",
    collected_at: o.collected_at ?? T0,
    age_hours: o.age_hours,
    source: o.source ?? "studio",
    views: o.views ?? 100,
    impressions: o.impressions === undefined ? 500 : o.impressions,
    ctr_pct: o.ctr_pct === undefined ? 5 : o.ctr_pct,
    avg_view_sec: o.avg_view_sec === undefined ? 60 : o.avg_view_sec,
    retention30_pct: o.retention30_pct === undefined ? null : o.retention30_pct,
  };
}

export const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
export const durationOf = (): number => 600;
