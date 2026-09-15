import { describe, expect, it } from "vitest";
import { newId, type ChannelLearned, type VideoMetrics } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T01:00:00.000Z";

function videoMetrics(overrides: Partial<VideoMetrics> = {}): VideoMetrics {
  return {
    schema_version: "harness.video-metrics/v1",
    metric_id: newId("video_metrics"),
    publication_job_id: newId("publication_job"),
    channel_id: "channel-a",
    video_id: "yt-video-1",
    collected_at: now,
    age_hours: 72,
    source: "studio",
    views: 1000,
    impressions: 20000,
    ctr_pct: 5,
    avg_view_sec: 120,
    retention30_pct: 40,
    ...overrides,
  };
}

function channelLearned(overrides: Partial<ChannelLearned> = {}): ChannelLearned {
  return {
    schema_version: "harness.channel-learned/v1",
    channel_id: "channel-a",
    updated_at: now,
    sample_size: 1,
    metric: "ctr",
    medians: { views_72h: 5000, ctr_pct: 4.5, avg_view_pct: 40 },
    winners: { angles: [], title_patterns: [], overlay: [] },
    standard: { note: "" },
    history: [],
    ...overrides,
  };
}

describe("migration 0005", () => {
  it("adds video_metrics and channel_learned tables", () => {
    const { store } = openTempStore();
    expect(store.listAppliedMigrations()).toContain("0005_learning.sql");
    expect(store.tableNames()).toEqual(expect.arrayContaining(["video_metrics", "channel_learned"]));
  });
});

describe("video_metrics", () => {
  it("insert and list, ordered by collected_at, filtered by publication_job_id", () => {
    const { store } = openTempStore();
    const jobId = newId("publication_job");
    const earlier = videoMetrics({ publication_job_id: jobId, collected_at: now });
    const later_ = videoMetrics({ publication_job_id: jobId, collected_at: later });
    // Insert out of order to prove the list is sorted by collected_at, not insertion order.
    store.insertVideoMetrics(later_);
    store.insertVideoMetrics(earlier);
    const other = videoMetrics({ publication_job_id: newId("publication_job") });
    store.insertVideoMetrics(other);

    expect(store.listVideoMetrics({ publication_job_id: jobId }).map((m) => m.metric_id)).toEqual([earlier.metric_id, later_.metric_id]);
  });

  it("filters by channel_id", () => {
    const { store } = openTempStore();
    const a = videoMetrics({ channel_id: "channel-a" });
    const b = videoMetrics({ channel_id: "channel-b" });
    store.insertVideoMetrics(a);
    store.insertVideoMetrics(b);
    expect(store.listVideoMetrics({ channel_id: "channel-a" }).map((m) => m.metric_id)).toEqual([a.metric_id]);
  });

  it("returns everything when no filter is given", () => {
    const { store } = openTempStore();
    store.insertVideoMetrics(videoMetrics());
    store.insertVideoMetrics(videoMetrics());
    expect(store.listVideoMetrics({})).toHaveLength(2);
  });
});

describe("channel_learned", () => {
  it("upsert inserts a new row and get returns it", () => {
    const { store } = openTempStore();
    const learned = channelLearned();
    store.upsertChannelLearned(learned);
    expect(store.getChannelLearned("channel-a")).toEqual(learned);
  });

  it("upsert overwrites the existing row for the same channel", () => {
    const { store } = openTempStore();
    store.upsertChannelLearned(channelLearned({ sample_size: 1 }));
    store.upsertChannelLearned(channelLearned({ sample_size: 5, updated_at: later }));
    const got = store.getChannelLearned("channel-a");
    expect(got?.sample_size).toBe(5);
    expect(got?.updated_at).toBe(later);
  });

  it("returns undefined for an unknown channel", () => {
    const { store } = openTempStore();
    expect(store.getChannelLearned("nope")).toBeUndefined();
  });
});
