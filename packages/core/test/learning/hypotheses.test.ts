import { describe, expect, it } from "vitest";
import { evaluateHypotheses, metricValue, snapshotAtHorizon } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, durationOf, insertPublishedJob, makeChannel, makeCommittedPackage, makeHypothesis, makeMetric } from "./fixtures.js";
import type { VideoMetrics } from "@harness/contracts";

function metric(overrides: Partial<VideoMetrics> = {}): VideoMetrics {
  return makeMetric({ publication_job_id: "pub_x", age_hours: 72, ...overrides });
}

describe("metricValue", () => {
  it("ctr reads ctr_pct", () => {
    expect(metricValue("ctr", metric({ ctr_pct: 6.5 }), 600)).toBe(6.5);
    expect(metricValue("ctr", metric({ ctr_pct: null }), 600)).toBeNull();
  });

  it("views_72h reads views", () => {
    expect(metricValue("views_72h", metric({ views: 321 }), null)).toBe(321);
  });

  it("avg_view_pct divides avg_view_sec by duration and scales to a percentage", () => {
    expect(metricValue("avg_view_pct", metric({ avg_view_sec: 90 }), 300)).toBe(30);
  });

  it("avg_view_pct is null when avg_view_sec or duration is missing", () => {
    expect(metricValue("avg_view_pct", metric({ avg_view_sec: null }), 300)).toBeNull();
    expect(metricValue("avg_view_pct", metric({ avg_view_sec: 90 }), null)).toBeNull();
  });
});

describe("snapshotAtHorizon", () => {
  it("returns the snapshot inside the window, ignoring ones far past it", () => {
    const list = [metric({ age_hours: 10 }), metric({ age_hours: 75 }), metric({ age_hours: 200 })];
    expect(snapshotAtHorizon(list, 72)).toBe(list[1]);
  });

  it("returns undefined when no snapshot has reached the horizon", () => {
    const list = [metric({ age_hours: 10 }), metric({ age_hours: 50 })];
    expect(snapshotAtHorizon(list, 72)).toBeUndefined();
  });

  // The upper bound is the whole point: a missed 72h collect must not let the 168h snapshot stand in for it.
  it("returns undefined when the only snapshot is past the window's upper bound (168h for a 72h horizon)", () => {
    const list = [metric({ age_hours: 168 })];
    expect(snapshotAtHorizon(list, 72)).toBeUndefined();
  });

  it("picks the snapshot closest to the horizon, not merely the first in the window", () => {
    const list = [metric({ age_hours: 70 }), metric({ age_hours: 90 })];
    expect(snapshotAtHorizon(list, 72)).toBe(list[0]);
    const reversed = [metric({ age_hours: 90 }), metric({ age_hours: 70 })];
    expect(snapshotAtHorizon(reversed, 72)).toBe(reversed[1]);
  });

  it("window is [horizon - 12, horizon + 24] inclusive at both edges", () => {
    expect(snapshotAtHorizon([metric({ age_hours: 60 })], 72)).toBeDefined();
    expect(snapshotAtHorizon([metric({ age_hours: 59.9 })], 72)).toBeUndefined();
    expect(snapshotAtHorizon([metric({ age_hours: 96 })], 72)).toBeDefined();
    expect(snapshotAtHorizon([metric({ age_hours: 96.1 })], 72)).toBeUndefined();
  });

  it("the window follows a non-default horizon (48h -> [36, 72])", () => {
    expect(snapshotAtHorizon([metric({ age_hours: 50 })], 48)).toBeDefined();
    expect(snapshotAtHorizon([metric({ age_hours: 80 })], 48)).toBeUndefined();
  });
});

describe("evaluateHypotheses", () => {
  it("marks a hypothesis supported when the metric value reaches the target", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, views: 150 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated).toEqual([{ hypothesis_id: h.hypothesis_id, package_id: pkg.package_id, status: "supported", metric_value: 150 }]);
    const updated = store.getChannelPackage(pkg.package_id)!;
    expect(updated.hypothesis.status).toBe("supported");
    expect(updated.hypothesis.evaluated).toMatchObject({ metric_value: 150 });
  });

  it("marks a hypothesis refuted when the metric value misses the target", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, views: 50 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated[0]!.status).toBe("refuted");
    expect(store.getChannelPackage(pkg.package_id)!.hypothesis.status).toBe("refuted");
  });

  it("voids a ctr hypothesis when impressions are below the channel's min_impressions floor", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ learning: { min_impressions: 50 } });
    const h = makeHypothesis({ expected: { metric: "ctr", target: 5, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, ctr_pct: 8, impressions: 10 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated[0]!.status).toBe("void");
  });

  it("voids an avg_view_pct hypothesis when avg_view_sec or duration is missing", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "avg_view_pct", target: 30, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, avg_view_sec: null }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated[0]!.status).toBe("void");
  });

  // An unreadable metric is "we did not measure it", never a verdict of 0.
  it("voids a ctr hypothesis when ctr_pct is null even though impressions clear the floor", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ learning: { min_impressions: 50 } });
    const h = makeHypothesis({ expected: { metric: "ctr", target: 5, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, impressions: 5000, ctr_pct: null }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated[0]!.status).toBe("void");
    expect(report.evaluated[0]!.metric_value).toBeNull();
    expect(store.getChannelPackage(pkg.package_id)!.hypothesis.status).toBe("void");
  });

  it("voids an avg_view_pct hypothesis when the package duration is 0 (not a 0% verdict)", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "avg_view_pct", target: 30, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, avg_view_sec: 60 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf: () => 0 });
    expect(report.evaluated[0]!.status).toBe("void");
  });

  // The 72h collect was blocked; the only snapshot is the 168h one. Judging that as the 72h number would
  // score a week of views against a 72h target.
  it("leaves a hypothesis open when the only snapshot is past the horizon window", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 168, views: 150 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated).toEqual([]);
    expect(store.getChannelPackage(pkg.package_id)!.hypothesis.status).toBe("open");
  });

  it("judges against the snapshot nearest the horizon when several are in the window", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 70, views: 50 }));
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 90, views: 400 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated[0]).toMatchObject({ status: "refuted", metric_value: 50 });
  });

  it("leaves a hypothesis open when no snapshot has reached the horizon yet", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 50, views: 150 }));

    const report = evaluateHypotheses({ store, clock, channel, durationOf });
    expect(report.evaluated).toEqual([]);
    expect(store.getChannelPackage(pkg.package_id)!.hypothesis.status).toBe("open");
  });

  it("is idempotent: a hypothesis already evaluated is never re-evaluated", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, views: 150 }));

    evaluateHypotheses({ store, clock, channel, durationOf });
    const firstMetricId = store.getChannelPackage(pkg.package_id)!.hypothesis.evaluated!.metric_id;

    // a later, higher-age snapshot arrives; a non-idempotent implementation would flip the verdict
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 200, views: 1 }));
    const second = evaluateHypotheses({ store, clock, channel, durationOf });

    expect(second.evaluated).toEqual([]);
    expect(store.getChannelPackage(pkg.package_id)!.hypothesis.evaluated!.metric_id).toBe(firstMetricId);
  });

  it("appends a hypothesis.evaluated event", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const h = makeHypothesis({ expected: { metric: "views_72h", target: 100, horizon_hours: 72 } });
    const pkg = makeCommittedPackage({ hypothesis: h });
    store.insertChannelPackage(pkg);
    const job = insertPublishedJob(store, { published_at: T0, package_id: pkg.package_id });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: 72, views: 150 }));

    evaluateHypotheses({ store, clock, channel, durationOf });
    const events = store.listEvents({ event_type: "hypothesis.evaluated" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ hypothesis_id: h.hypothesis_id, status: "supported", metric_value: 150 });
  });
});
