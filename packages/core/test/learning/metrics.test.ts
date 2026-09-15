import { describe, expect, it } from "vitest";
import { FakeStatsCollector } from "@harness/adapter-fake";
import { addSeconds, ageHours, collectDue, collectStats, importMetrics } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, durationOf, insertPublishedJob, makeChannel, makeMetric, makeRegistry, noopLogger } from "./fixtures.js";

describe("ageHours", () => {
  it("is the whole-hour-fractional gap between publishedAt and now", () => {
    expect(ageHours(T0, addSeconds(T0, 72 * 3600))).toBe(72);
    expect(ageHours(T0, T0)).toBe(0);
  });
});

describe("collectDue", () => {
  it("returns nothing before the horizon", () => {
    const { store } = openTempStore(T0);
    const channel = makeChannel();
    insertPublishedJob(store, { published_at: T0 });
    expect(collectDue(store, channel, addSeconds(T0, 10 * 3600), 5)).toEqual([]);
  });

  it("is due once the horizon passes", () => {
    const { store } = openTempStore(T0);
    const channel = makeChannel();
    const job = insertPublishedJob(store, { published_at: T0 });
    const due = collectDue(store, channel, addSeconds(T0, 72 * 3600), 5);
    expect(due).toEqual([{ job, target_age_hours: 72 }]);
  });

  it("is not due at the horizon once a ~70h studio snapshot exists, but becomes due for the next recollect target", () => {
    const { store } = openTempStore(T0);
    const channel = makeChannel({ learning: { recollect_hours: [168] } });
    const job = insertPublishedJob(store, { published_at: T0 });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 70, source: "studio" }));

    expect(collectDue(store, channel, addSeconds(T0, 72 * 3600), 5)).toEqual([]);
    expect(collectDue(store, channel, addSeconds(T0, 168 * 3600), 5)).toEqual([{ job, target_age_hours: 168 }]);
  });

  it("a manual snapshot does not count toward satisfying a target", () => {
    const { store } = openTempStore(T0);
    const channel = makeChannel();
    const job = insertPublishedJob(store, { published_at: T0 });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, source: "manual" }));
    expect(collectDue(store, channel, addSeconds(T0, 72 * 3600), 5)).toEqual([{ job, target_age_hours: 72 }]);
  });

  it("sorts by due time ascending and caps to batch", () => {
    const { store } = openTempStore(T0);
    const channel = makeChannel({ learning: { recollect_hours: [] } });
    const jobA = insertPublishedJob(store, { published_at: addSeconds(T0, -100 * 3600) }); // due earliest
    const jobB = insertPublishedJob(store, { published_at: addSeconds(T0, -80 * 3600) });

    const all = collectDue(store, channel, T0, 5);
    expect(all.map((d) => d.job.publication_job_id)).toEqual([jobA.publication_job_id, jobB.publication_job_id]);

    const capped = collectDue(store, channel, T0, 1);
    expect(capped).toEqual([{ job: jobA, target_age_hours: 72 }]);
  });
});

describe("collectStats", () => {
  it("ok: inserts a studio video_metrics row and fires stats.collected", async () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const channels = makeRegistry([channel]);
    const job = insertPublishedJob(store, { published_at: T0, youtube_video_id: "v1" });
    clock.set(addSeconds(T0, 72 * 3600));
    const collector = new FakeStatsCollector({ outcomes: { v1: { kind: "ok", views: 200, impressions: 800, ctr_pct: 4.5, avg_view_sec: 90 } } });

    const report = await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger });

    expect(report.collected).toHaveLength(1);
    expect(report.collected[0]).toMatchObject({ job_id: job.publication_job_id, age_hours: 72 });
    const rows = store.listVideoMetrics({ publication_job_id: job.publication_job_id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ views: 200, impressions: 800, ctr_pct: 4.5, avg_view_sec: 90, source: "studio" });
    const events = store.listEvents({ event_type: "stats.collected" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ job_id: job.publication_job_id, metric_id: rows[0]!.metric_id });
  });

  it("no-views: inserts a row with views 0 and everything else null", async () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const channels = makeRegistry([channel]);
    const job = insertPublishedJob(store, { published_at: T0, youtube_video_id: "v1" });
    clock.set(addSeconds(T0, 72 * 3600));
    const collector = new FakeStatsCollector({ outcomes: { v1: { kind: "no-views" } } });

    const report = await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    expect(report.collected).toHaveLength(1);
    const row = store.listVideoMetrics({ publication_job_id: job.publication_job_id })[0]!;
    expect(row.views).toBe(0);
    expect(row.impressions).toBeNull();
    expect(row.ctr_pct).toBeNull();
    expect(row.avg_view_sec).toBeNull();
    expect(row.retention30_pct).toBeNull();
  });

  it("blocked: no row for that channel, event deduped on a second sweep, other channels still collect", async () => {
    const { store, clock } = openTempStore(T0);
    const channelA = makeChannel({ channel_id: "channel-a" });
    const channelB = makeChannel({ channel_id: "channel-b" });
    const channels = makeRegistry([channelA, channelB]);
    const jobA = insertPublishedJob(store, { channel_id: "channel-a", published_at: T0, youtube_video_id: "va" });
    const jobB = insertPublishedJob(store, { channel_id: "channel-b", published_at: T0, youtube_video_id: "vb" });
    clock.set(addSeconds(T0, 72 * 3600));
    const collector = new FakeStatsCollector({ outcomes: { va: { kind: "blocked", reason: "login wall" }, vb: { kind: "ok", views: 50 } } });

    const first = await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    expect(first.blocked).toEqual(["channel-a"]);
    expect(store.listVideoMetrics({ publication_job_id: jobA.publication_job_id })).toEqual([]);
    expect(store.listVideoMetrics({ publication_job_id: jobB.publication_job_id })).toHaveLength(1);
    expect(store.listEvents({ event_type: "stats.blocked" })).toHaveLength(1);

    // channel-a's job is still due (nothing was collected); sweeping again inside the 24h dedup window
    // must not fire a second stats.blocked event, but the channel is still reported blocked.
    const second = await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    expect(second.blocked).toEqual(["channel-a"]);
    expect(store.listEvents({ event_type: "stats.blocked" })).toHaveLength(1);
  });

  it("error: increments receipt.collect_failures and fires a deduped stats.failing after 3 in a row; a later ok resets it", async () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const channels = makeRegistry([channel]);
    const job = insertPublishedJob(store, { published_at: T0, youtube_video_id: "v1" });
    clock.set(addSeconds(T0, 72 * 3600));
    const failingCollector = new FakeStatsCollector({ outcomes: { v1: { kind: "error", reason: "dom changed" } } });

    for (let i = 0; i < 3; i++) {
      await collectStats({ store, collector: failingCollector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    }
    expect(store.getPublicationJob(job.publication_job_id)!.receipt).toMatchObject({ collect_failures: 3 });
    expect(store.listEvents({ event_type: "stats.failing" })).toHaveLength(1);

    await collectStats({ store, collector: failingCollector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    expect(store.listEvents({ event_type: "stats.failing" })).toHaveLength(1); // still deduped

    const okCollector = new FakeStatsCollector({ outcomes: { v1: { kind: "ok", views: 10 } } });
    await collectStats({ store, collector: okCollector, channels, clock, batch: 5, durationOf, logger: noopLogger });
    expect(store.getPublicationJob(job.publication_job_id)!.receipt).toMatchObject({ collect_failures: 0 });
  });

  it("force collects every PUBLISHED job of the channel(s) at its current age, ignoring due-ness", async () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const channels = makeRegistry([channel]);
    const job = insertPublishedJob(store, { published_at: T0, youtube_video_id: "v1" });
    clock.set(addSeconds(T0, 5 * 3600)); // nowhere near the 72h horizon
    const collector = new FakeStatsCollector({ outcomes: { v1: { kind: "ok", views: 7 } } });

    expect(await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger })).toMatchObject({ collected: [] });

    const forced = await collectStats({ store, collector, channels, clock, batch: 5, durationOf, logger: noopLogger }, { force: true });
    expect(forced.collected).toHaveLength(1);
    expect(forced.collected[0]).toMatchObject({ job_id: job.publication_job_id, age_hours: 5 });
  });
});

describe("importMetrics", () => {
  it("imports matching rows as manual snapshots, skips a mismatched videoId, and drops the $schema line", () => {
    const { store, clock } = openTempStore(T0);
    insertPublishedJob(store, { published_at: T0, youtube_video_id: "v1" });
    insertPublishedJob(store, { published_at: T0, youtube_video_id: "v2" });
    clock.set(addSeconds(T0, 100 * 3600));

    const jsonl = [
      JSON.stringify({ $schema: "https://example/schema.json" }),
      JSON.stringify({ videoId: "v1", views: 1000, impressions: 5000, ctr_pct: 6.1, avg_view_sec: 120 }),
      JSON.stringify({ videoId: "v2", views: 200 }),
      JSON.stringify({ videoId: "does-not-exist", views: 5 }),
    ].join("\n");

    const result = importMetrics(store, { channel_id: "channel-a", jsonl, clock });
    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual([{ videoId: "does-not-exist", why: "no matching publication job" }]);

    const rows = store.listVideoMetrics({ channel_id: "channel-a" });
    expect(rows.filter((r) => r.source === "manual")).toHaveLength(2);
    const v1 = rows.find((r) => r.video_id === "v1")!;
    expect(v1.views).toBe(1000);
    expect(v1.impressions).toBe(5000);
    expect(v1.source).toBe("manual");
  });
});
