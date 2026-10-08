import { describe, expect, it } from "vitest";
import type { ResearchVideo, StudioResearch, StyleWatch } from "@harness/contracts";
import { measureShots, pickReferenceVideos, rhythmOf, validateStyle } from "../../src/studio/style.js";
import { isFollowUpWarning } from "../../src/studio/validate.js";

const v = (id: string, duration_s: number, views_per_day: number, published_at = "2026-06-01T00:00:00Z"): ResearchVideo => ({
  video_id: id.padEnd(11, "x"), channel_id: "UC1", channel_title: "Mei Time", title: `Video ${id}`, published_at, duration_s,
  views: views_per_day * 100, likes: null, comments: null, tags: [], views_per_day, outlier: false,
});
const research = (channels: StudioResearch["channels"]): StudioResearch => ({
  schema_version: "studio.research/v1", production_id: "p", fetched_at: "2026-10-08T00:00:00Z", quota_units: 3, skipped_reason: null,
  channels, keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] },
});
const channel = (input: string, role: "reference" | "own", videos: ResearchVideo[]) =>
  ({ input, role, channel_id: input, title: input, subscribers: null, error: null, videos, stats: null });

describe("pickReferenceVideos", () => {
  it("picks long-form videos of the reference channels nearest the target length, then by views per day, at most three", () => {
    const r = research([
      channel("@mei", "reference", [v("a", 1300, 50), v("b", 1150, 10), v("c", 40, 900), v("d", 0, 900), v("e", 3600, 900), v("f", 1250, 80)]),
      channel("@mine", "own", [v("g", 1200, 999)]),
    ]);
    const p = pickReferenceVideos(r, { aspect: "16:9", targetSeconds: 1200 });
    expect(p.skipped_reason).toBeNull();
    expect(p.target_seconds).toBe(1200);
    // f and b are as near the target (within a tenth of its log), f has more views per day; a is further
    expect(p.picks.map((x) => x.video_id[0])).toEqual(["f", "b", "a"]);
    expect(p.picks[0]!.url).toBe(`https://www.youtube.com/watch?v=${"f".padEnd(11, "x")}`);
  });

  it("takes turns between reference channels", () => {
    const r = research([
      channel("@one", "reference", [v("a", 600, 1), v("b", 610, 1), v("c", 620, 1)]),
      channel("@two", "reference", [{ ...v("d", 600, 1), channel_id: "UC2", channel_title: "Two" }]),
    ]);
    expect(pickReferenceVideos(r, { aspect: "16:9", targetSeconds: 600 }).picks.map((x) => x.video_id[0])).toEqual(["a", "d", "b"]);
  });

  it("vertical series learn from shorts; with no target, the median length of the candidates", () => {
    const r = research([channel("@mei", "reference", [v("a", 45, 1), v("b", 1200, 1), v("c", 59, 1)])]);
    const p = pickReferenceVideos(r, { aspect: "9:16", targetSeconds: null });
    expect(p.picks.map((x) => x.video_id[0]).sort()).toEqual(["a", "c"]);
    expect(p.target_seconds).toBe(52);
  });

  it("says why when it cannot pick", () => {
    expect(pickReferenceVideos(research([]), { aspect: "16:9", targetSeconds: 600 }).skipped_reason).toBe("Chưa nhập kênh tham khảo");
    expect(pickReferenceVideos({ ...research([]), skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY" }, { aspect: "16:9", targetSeconds: 600 }).skipped_reason)
      .toMatch(/research bị bỏ qua: Chưa cấu hình YOUTUBE_API_KEY/);
    expect(pickReferenceVideos(research([channel("@mei", "reference", [v("a", 20, 1)])]), { aspect: "16:9", targetSeconds: 600 }).skipped_reason)
      .toMatch(/không có video/);
  });
});

describe("measureShots", () => {
  it("shot lengths from scene changes, cuts closer than a quarter second merged, over every video", () => {
    const m = measureShots([{ cuts: [2, 2.1, 6, 12], duration: 20 }, { cuts: [5], duration: 10 }]);
    // video 1: 2, 4, 6, 8 ; video 2: 5, 5
    expect(m).toMatchObject({ videos: 2, shots: 6, first_shot_s: 3.5 });
    expect(m!.shot_seconds.median).toBe(5);
    expect(m!.cuts_per_minute).toBe(8);
    expect(measureShots([])).toBeNull();
  });

  it("rhythm from the median shot length", () => {
    expect([rhythmOf(1.8), rhythmOf(3), rhythmOf(6.5)]).toEqual(["fast", "medium", "slow"]);
  });
});

describe("validateStyle", () => {
  const measured = { videos: 1, shots: 3, cuts_per_minute: 9, shot_seconds: { p25: 5, median: 6.5, p75: 8 }, first_shot_s: 2 };
  const watch: StyleWatch = {
    schema_version: "studio.style-watch/v1", production_id: "p", skipped_reason: null, measured,
    videos: [{ label: "R1", video_id: "U_17EqTHUIo", title: "Kyoto", duration_s: 1299, error: null, measured, cuts: [2, 8.5],
      frames: [{ t: 2.5, file: "R1/f-2.500.jpg", kind: "opening", key: "k" }, { t: 10, file: "R1/f-10.000.jpg", kind: "interval", key: "k2" }], sheets: [] }],
  };
  const style = {
    schema_version: "studio.style/v1", skipped: false, skipped_reason: null, name: "Chậm", summary: "Cảnh dài.",
    references: [{ video_id: "U_17EqTHUIo", title: "Kyoto", channel_title: "Mei Time", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", duration_s: 1299 }],
    measured,
    params: { cut_rhythm: "slow", shot_seconds: { min: 5, max: 8 }, transitions: ["cut"], opening: { seconds: 10, structure: "montage" },
      text_overlay: { density: "low", style: "serif" }, subtitles: "none", voice: "unknown", music: { mood: "calm", ducking: null }, visual: "", pace_notes: "" },
    do: [], dont: [],
    evidence: [{ param: "opening", video_id: "U_17EqTHUIo", t: 2.5, note: "a" }, { param: "pace", video_id: "U_17EqTHUIo", t: 10, note: "b" }, { param: "text", video_id: "U_17EqTHUIo", t: 2.5, note: "c" }],
  };

  it("passes a style backed by the frames and numbers watched", () => {
    const r = validateStyle(style, { watch });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("evidence must be a frame that was watched, numbers must be the ones measured, references the videos watched", () => {
    const bad = { ...style, measured: { ...measured, shot_seconds: { ...measured.shot_seconds, median: 3 } },
      references: [{ ...style.references[0], video_id: "AAAAAAAAAAA" }],
      evidence: [...style.evidence.slice(0, 2), { param: "x", video_id: "U_17EqTHUIo", t: 77, note: "" }] };
    const codes = validateStyle(bad, { watch }).problems.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["evidence_not_watched", "measured_differs", "references_differ"]));
  });

  it("a style that contradicts what was measured goes back to Claude (follow-up); a person editing it keeps it as a warning", () => {
    const off = { ...style, params: { ...style.params, cut_rhythm: "fast", shot_seconds: { min: 1, max: 2 } } };
    const r = validateStyle(off, { watch });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["style_cut_rhythm", "style_shot_seconds"]);
    expect(r.warnings.every(isFollowUpWarning)).toBe(true);
  });

  it("a skipped style must say why; a learned one needs params, numbers and three pieces of evidence", () => {
    expect(validateStyle({ ...style, skipped: true, skipped_reason: null, params: null, measured: null, references: [], evidence: [] }, {}).problems.map((p) => p.code)).toContain("skipped_without_reason");
    expect(validateStyle({ ...style, params: null, evidence: [] }, {}).problems.map((p) => p.code)).toEqual(expect.arrayContaining(["no_params", "too_little_evidence"]));
    expect(validateStyle({ ...style, params: { ...style.params, shot_seconds: { min: 9, max: 3 } } }, {}).problems.map((p) => p.code)).toContain("shot_range");
  });
});
