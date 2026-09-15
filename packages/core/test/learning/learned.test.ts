import { describe, expect, it } from "vitest";
import { newId, type ChannelPackage, type StateStore } from "@harness/contracts";
import { learnChannelStandard, median, overlayGroup, titlePattern, type HypothesisMetric } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, durationOf, insertPublishedJob, makeChannel, makeCommittedPackage, makeHypothesis, makeMetric } from "./fixtures.js";

describe("titlePattern", () => {
  it("combines number/question/length labels", () => {
    expect(titlePattern("Bí quyết 5 bước?")).toBe("number+question+short");
    expect(titlePattern("Why This Works")).toBe("plain+statement+short");
    expect(titlePattern("x".repeat(61))).toBe("plain+statement+long");
    expect(titlePattern("Is this real")).toBe("plain+statement+short");
  });
});

describe("overlayGroup", () => {
  it("buckets by overlay line count", () => {
    expect(overlayGroup([])).toBe("0");
    expect(overlayGroup(["a"])).toBe("1-2");
    expect(overlayGroup(["a", "b"])).toBe("1-2");
    expect(overlayGroup(["a", "b", "c"])).toBe("3");
  });
});

describe("median", () => {
  it("averages the middle two for an even count, returns null for empty", () => {
    expect(median([])).toBeNull();
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

/** Seeds one committed, evaluated ChannelPackage plus the PUBLISHED job + 72h snapshot that back its
 * medians contribution -- everything `learnChannelStandard` reads. */
function seedEvaluated(store: StateStore, o: {
  channel_id?: string; status: "supported" | "refuted"; metric: HypothesisMetric; metric_value: number;
  angle?: string; title?: string; overlay?: string[]; snapshotViews?: number; horizon_hours?: number; snapshotAgeHours?: number;
}): ChannelPackage {
  const h = makeHypothesis({
    status: o.status,
    expected: { metric: o.metric, target: 1, horizon_hours: o.horizon_hours ?? 72 },
    chosen: { title: o.title ?? "Why This Works", angle: o.angle ?? "", overlay_text: o.overlay ?? [], thumbnail_candidate: "c.png" },
    evaluated: { at: T0, metric_value: o.metric_value, metric_id: newId("video_metrics") },
  });
  const pkg = makeCommittedPackage({ channel_id: o.channel_id, hypothesis: h });
  store.insertChannelPackage(pkg);
  const job = insertPublishedJob(store, { channel_id: o.channel_id, published_at: T0, package_id: pkg.package_id });
  store.insertVideoMetrics(makeMetric({ publication_job_id: job.publication_job_id, age_hours: o.snapshotAgeHours ?? 72, views: o.snapshotViews ?? 100 }));
  return pkg;
}

describe("learnChannelStandard", () => {
  // Regression: the medians used to be taken at a hardcoded 72h, so a channel that collects at 48h had no
  // snapshot at all in range -> every median null -> every lift 0 -> nothing could ever become a standard.
  it("takes the medians at the channel's own learning.horizon_hours, not a hardcoded 72", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ learning: { horizon_hours: 48 } });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 150, angle: "curiosity", horizon_hours: 48, snapshotAgeHours: 50, snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 150, angle: "curiosity", title: "10 Secrets?", overlay: ["a"], horizon_hours: 48, snapshotAgeHours: 50, snapshotViews: 100 });

    const { learned } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.medians.views_72h).toBe(100); // "views at the channel horizon", here 48h
    expect(learned.standard.angle).toBe("curiosity");
  });

  it("ignores a snapshot far past the channel horizon when computing the medians", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ learning: { horizon_hours: 48 } });
    // only a 168h snapshot exists: the 48h collect never ran, so this job contributes no median at all
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 150, angle: "curiosity", horizon_hours: 48, snapshotAgeHours: 168, snapshotViews: 9999 });

    const { learned } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.medians.views_72h).toBeNull();
  });

  it("promotes an angle to the standard when two supported hypotheses share it with lift > 1", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 150, angle: "Curiosity", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 150, angle: "curiosity", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });

    const { learned, changed } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBe("curiosity"); // trimmed + lowercased
    expect(learned.standard.title_pattern).toBeUndefined();
    expect(learned.standard.overlay_lines).toBeUndefined();
    expect(learned.winners.angles).toContainEqual({ value: "curiosity", supported: 2, refuted: 0, lift: 1.5 });
    expect(changed).toBe(true);
  });

  it("leaves the standard empty with an explanatory note when only one hypothesis is evaluated", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "x", snapshotViews: 100 });

    const { learned } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBeUndefined();
    expect(learned.standard.note).toBe("cần ≥2 giả thuyết supported cùng nhóm; hiện có 1 đã đánh giá");
  });

  it("does not promote a group where refuted count meets or beats supported count", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "y", snapshotViews: 100 });
    seedEvaluated(store, { status: "refuted", metric: "views_72h", metric_value: 50, angle: "y", snapshotViews: 100 });

    const { learned } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBeUndefined();
    expect(learned.standard.note).toContain("hiện có 2 đã đánh giá");
  });

  it("keeps the old standard value when the new candidate's lift does not beat it by 10%", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    store.upsertChannelLearned({
      schema_version: "harness.channel-learned/v1", channel_id: "channel-a", updated_at: T0, sample_size: 2, metric: "views_72h",
      medians: { views_72h: 100, ctr_pct: null, avg_view_pct: null },
      winners: { angles: [{ value: "curiosity", supported: 2, refuted: 0, lift: 1.5 }], title_patterns: [], overlay: [] },
      standard: { angle: "curiosity", note: "" },
      history: [],
    });

    // new candidate "mystery": mean 160 / median 100 = 1.6 lift -- short of 1.5 * 1.10 = 1.65
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 160, angle: "mystery", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 160, angle: "mystery", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });

    const { learned, changed } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBe("curiosity");
    expect(changed).toBe(false);
  });

  it("keeps the old standard value (does not drop it) when its lift is unknown and there is no new candidate", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    // the old standard's value is absent from its own previous winners (e.g. a manually-set standard, or
    // one carried over from an even earlier round whose winners were pruned) -- no old lift to compare.
    store.upsertChannelLearned({
      schema_version: "harness.channel-learned/v1", channel_id: "channel-a", updated_at: T0, sample_size: 0, metric: null,
      medians: { views_72h: null, ctr_pct: null, avg_view_pct: null },
      winners: { angles: [], title_patterns: [], overlay: [] },
      standard: { angle: "curiosity", note: "" },
      history: [],
    });

    // no evaluated hypotheses this round at all -> no candidate anywhere either.
    const { learned, changed } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBe("curiosity");
    expect(changed).toBe(false);
    expect(store.listEvents({ event_type: "channel.learned_updated" })).toEqual([]);
  });

  it("replaces the old standard value once the new candidate's lift clears the 10% bar", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    store.upsertChannelLearned({
      schema_version: "harness.channel-learned/v1", channel_id: "channel-a", updated_at: T0, sample_size: 2, metric: "views_72h",
      medians: { views_72h: 100, ctr_pct: null, avg_view_pct: null },
      winners: { angles: [{ value: "curiosity", supported: 2, refuted: 0, lift: 1.5 }], title_patterns: [], overlay: [] },
      standard: { angle: "curiosity", note: "" },
      history: [],
    });

    // new candidate "mystery": mean 170 / median 100 = 1.7 lift -- clears 1.5 * 1.10 = 1.65
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 170, angle: "mystery", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 170, angle: "mystery", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });

    const { learned, changed } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.standard.angle).toBe("mystery");
    expect(changed).toBe(true);
  });

  it("caps history at 20 entries, dropping the oldest", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const oldHistory = Array.from({ length: 20 }, (_, i) => ({ at: T0, standard: { angle: `old-${i}` } }));
    store.upsertChannelLearned({
      schema_version: "harness.channel-learned/v1", channel_id: "channel-a", updated_at: T0, sample_size: 0, metric: null,
      medians: { views_72h: null, ctr_pct: null, avg_view_pct: null },
      winners: { angles: [], title_patterns: [], overlay: [] },
      standard: { note: "" },
      history: oldHistory,
    });

    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "z", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "z", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });

    const { learned, changed } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(changed).toBe(true);
    expect(learned.history).toHaveLength(20);
    expect(learned.history[0]!.standard.angle).toBe("old-1");
    expect(learned.history[19]!.standard.angle).toBe("z");
  });

  it("reports changed=true the first time and changed=false once the store already matches", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "z", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "z", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });

    const first = learnChannelStandard({ store, clock, channel, durationOf });
    expect(first.changed).toBe(true);
    const second = learnChannelStandard({ store, clock, channel, durationOf });
    expect(second.changed).toBe(false);
  });

  it("groups only hypotheses sharing the channel's most common metric", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "a1", title: "Why This Works", overlay: [], snapshotViews: 100 });
    seedEvaluated(store, { status: "supported", metric: "views_72h", metric_value: 200, angle: "a1", title: "10 Secrets?", overlay: ["a"], snapshotViews: 100 });
    seedEvaluated(store, { status: "refuted", metric: "views_72h", metric_value: 10, angle: "other", title: "Something Else", overlay: [], snapshotViews: 100 });
    // a ctr hypothesis sharing angle "a1" must not inflate the views_72h "a1" group
    seedEvaluated(store, { status: "supported", metric: "ctr", metric_value: 9, angle: "a1", title: "A Ctr Hypothesis", overlay: [], snapshotViews: 100 });

    const { learned } = learnChannelStandard({ store, clock, channel, durationOf });
    expect(learned.metric).toBe("views_72h");
    expect(learned.standard.angle).toBe("a1");
    expect(learned.winners.angles.find((g) => g.value === "a1")).toMatchObject({ supported: 2, refuted: 0 });
  });
});
