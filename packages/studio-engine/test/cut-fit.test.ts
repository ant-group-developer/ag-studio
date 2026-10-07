import { describe, expect, it } from "vitest";
import { TimelineV4Schema, type EditPlan, type ShotsIndex, type StudioSurvey } from "@harness/contracts";
import { layoutTimeline, studioSourceId, timelineIssues } from "@harness/core";
import { fitCutTimeline } from "../src/index.js";

const A = studioSourceId("a");
const B = studioSourceId("b");
const KEY = (n: number) => String(n).repeat(64).slice(0, 64);

const shots: ShotsIndex = {
  schema_version: "harness.shots/v2",
  sources: [
    { source_id: A, index: 0, file_name: "a.mp4", duration_seconds: 40, has_audio: true, shots: [
      { shot_id: "s000-000", in: 0, out: 8 }, { shot_id: "s000-001", in: 8, out: 20 }, { shot_id: "s000-002", in: 20, out: 40 },
    ] },
    { source_id: B, index: 1, file_name: "b.mp4", duration_seconds: 15, has_audio: false, shots: [{ shot_id: "s001-000", in: 0, out: 15 }] },
  ],
};
const survey: StudioSurvey = {
  schema_version: "harness.survey-index/v2",
  shots: shots.sources.flatMap((s) => s.shots.map((x) => ({ source_id: s.source_id, shot_id: x.shot_id, in: x.in, out: x.out, score: 4, tags: [], usable: true, note: "", speech: "ambient" as const }))),
};
const plan: EditPlan = {
  schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration: "tts", language: "vi", target_seconds: 12,
  shots: [
    { order: 1, shot_id: "s000-000", source_id: A, in: 1, out: 4, line_id: "L001", transition: "dissolve", section_title: null, note: "" },
    { order: 2, shot_id: "s001-000", source_id: B, in: 2, out: 6, line_id: null, transition: "cut", section_title: "Đền", note: "" },
    { order: 3, shot_id: "s000-002", source_id: A, in: 22, out: 25, line_id: "L002", transition: "cut", section_title: null, note: "" },
  ],
  lines: [{ line_id: "L001", text: "Phố cổ Hoa Lư lúc chiều tà." }, { line_id: "L002", text: "Đền vua Đinh." }],
  texts: [
    { text_id: "T001", kind: "title", text: "Hoa Lư", at_order: 1, offset_s: 0.5, duration: 3, position: "top_left" },
    { text_id: "T002", kind: "lower_third", text: "Đền vua Đinh", at_order: 2, offset_s: 1, duration: 4, position: "bottom_left" },
  ],
  music_mood: "calm",
};
const assets = {
  a: { title: "Phố cổ", summary_vi: "Phố", duration_s: 40, orientation: "landscape" },
  b: { title: "Đền", summary_vi: "Đền", duration_s: 15, orientation: "landscape" },
};

function fit(voice: Record<string, { key: string; duration_s: number; words: { word: string; start: number; end: number }[] }>) {
  return fitCutTimeline({
    productionId: "prod-1", plan, shots, survey, transcript: null, voice,
    sources: [{ asset_id: "a", source_id: A }, { asset_id: "b", source_id: B }], assets,
    canvas: { width: 3840, height: 2160 }, fps: 30, music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true },
  });
}

describe("fitCutTimeline", () => {
  it("turns the fitted plan into a clean timeline v4 with the narration on its shots", () => {
    const { timeline, report } = fit({
      L001: { key: KEY(1), duration_s: 2.2, words: [{ word: "Phố", start: 0, end: 0.3 }] },
      L002: { key: KEY(2), duration_s: 1.4, words: [] },
    });
    const t = TimelineV4Schema.parse(timeline);
    expect(t).toMatchObject({ edit_style: "cut", episode_id: "ep-1", captions: { mode: "burn-in" }, narration: { voice: "tts", lead_seconds: 0.3 } });
    expect(t.clips.map((c) => [c.asset_id, c.shot_id, c.line_id])).toEqual([["a", "s000-000", "L001"], ["b", "s001-000", null], ["a", "s000-002", "L002"]]);
    expect(t.clips[0]!.transition_out).toEqual({ kind: "dissolve", seconds: 0.4 });
    expect(t.clips[1]!.section_title).toBe("Đền");
    expect(t.narration.lines.map((l) => [l.line_id, l.audio?.key, l.audio?.duration_s])).toEqual([["L001", KEY(1), 2.2], ["L002", KEY(2), 1.4]]);
    const laid = layoutTimeline(t);
    expect(t.texts.find((x) => x.text_id === "T002")?.start).toBeCloseTo(laid.clips[1]!.start + 1, 3);
    expect(timelineIssues(t, { targetSeconds: 12 }).filter((i) => i.severity === "error")).toEqual([]);
    expect(report.schema_version).toBe("harness.fit-report/v1");
    expect(t.assets.a?.duration_s).toBe(40);
  });

  it("a line longer than its picture makes the picture longer, never cuts the voice", () => {
    const { timeline, report } = fit({
      L001: { key: KEY(1), duration_s: 6, words: [] },
      L002: { key: KEY(2), duration_s: 1, words: [] },
    });
    const laid = layoutTimeline(TimelineV4Schema.parse(timeline));
    const l1 = laid.lines.find((l) => l.line_id === "L001")!;
    const next = laid.lines.find((l) => l.line_id === "L002")!;
    expect(l1.end).toBeLessThanOrEqual(next.start + 1e-6);
    expect(report.entries.some((e) => e.action === "extended" || e.action === "appended")).toBe(true);
  });

  it("a line with no audio cannot be placed", () => {
    expect(() => fit({ L001: { key: KEY(1), duration_s: 2, words: [] } })).toThrow(/L002/);
  });
});
