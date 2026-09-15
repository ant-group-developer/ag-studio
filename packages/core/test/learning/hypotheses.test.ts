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
  it("returns the first snapshot whose age_hours reached the horizon", () => {
    const list = [metric({ age_hours: 10 }), metric({ age_hours: 75 }), metric({ age_hours: 200 })];
    expect(snapshotAtHorizon(list, 72)).toBe(list[1]);
  });

  it("returns undefined when no snapshot has reached the horizon", () => {
    const list = [metric({ age_hours: 10 }), metric({ age_hours: 50 })];
    expect(snapshotAtHorizon(list, 72)).toBeUndefined();
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
