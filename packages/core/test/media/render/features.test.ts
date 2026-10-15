import { describe, expect, it } from "vitest";
import { timelineToComposition } from "../../../src/studio/render-plan.js";
import { compositionFeatureLevel, RENDER_FEATURE_LEVEL } from "../../../src/media/render/features.js";
import type { TimelineV4 } from "@harness/contracts";

function timeline(music: TimelineV4["music"]): TimelineV4 {
  return {
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: "e", canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [{ clip_id: "C001", asset_id: "a1", section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } }],
    texts: [], narration: { voice: "original", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" }, music, source_audio: { muted: false },
    assets: { a1: { title: "Thuyền", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [],
  };
}

describe("compositionFeatureLevel", () => {
  it("is 0 for what every render worker reads, 1 for music that does not duck", () => {
    expect(compositionFeatureLevel(timelineToComposition(timeline(null)))).toBe(0);
    expect(compositionFeatureLevel(timelineToComposition(timeline({ track: "library:m.mp3", gain_db: -18, ducking: true })))).toBe(0);
    expect(compositionFeatureLevel(timelineToComposition(timeline({ track: "library:m.mp3", gain_db: -30, ducking: false })))).toBe(1);
  });

  it("is 3 for a text's own size, a text shadow, or texts at one position at the same time", () => {
    const texts = (...t: TimelineV4["texts"]) => ({ ...timeline(null), texts: t });
    const text = (text_id: string, start: number, position: TimelineV4["texts"][number]["position"] = "bottom_left") =>
      ({ text_id, kind: "lower_third" as const, text: text_id, start, duration: 2, position });
    expect(compositionFeatureLevel(timelineToComposition(texts(text("T001", 0), text("T002", 2))))).toBe(0);
    expect(compositionFeatureLevel(timelineToComposition(texts(text("T001", 0), text("T002", 1, "top_left"))))).toBe(0);
    expect(compositionFeatureLevel(timelineToComposition(texts(text("T001", 0), text("T002", 1))))).toBe(3);
    expect(compositionFeatureLevel(timelineToComposition(texts({ ...text("T001", 0), size: "s" })))).toBe(3);
    const look = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m" as const };
    expect(compositionFeatureLevel(timelineToComposition({ ...timeline(null), text_style: look }))).toBe(0);
    expect(compositionFeatureLevel(timelineToComposition({ ...timeline(null), text_style: { ...look, shadow: true } }))).toBe(3);
  });

  it("is 4 for a text look that names a font", () => {
    const look = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m" as const };
    expect(compositionFeatureLevel(timelineToComposition({ ...timeline(null), text_style: { ...look, font: "Be Vietnam Pro" } }))).toBe(4);
    expect(compositionFeatureLevel(timelineToComposition({ ...timeline(null), text_style: { ...look, font: "Arial", shadow: true } }))).toBe(4);
  });

  it("is 5 for a clip's gain, even source sound or a music volume line", () => {
    const t = timeline({ track: "library:m.mp3", gain_db: -18, ducking: true });
    expect(compositionFeatureLevel(timelineToComposition({ ...t, clips: [{ ...t.clips[0]!, gain_db: -6 }] }))).toBe(5);
    expect(compositionFeatureLevel(timelineToComposition({ ...t, source_audio: { muted: false, even: true } }))).toBe(5);
    expect(compositionFeatureLevel(timelineToComposition({ ...t, music: { ...t.music!, envelope: [{ at: 0, gain_db: -30 }] } }))).toBe(5);
  });

  it("never asks for more than this build renders", () => {
    expect(compositionFeatureLevel(timelineToComposition(timeline({ track: "library:m.mp3", gain_db: -30, ducking: false })))).toBeLessThanOrEqual(RENDER_FEATURE_LEVEL);
  });
});
