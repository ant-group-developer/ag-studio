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

  it("never asks for more than this build renders", () => {
    expect(compositionFeatureLevel(timelineToComposition(timeline({ track: "library:m.mp3", gain_db: -30, ducking: false })))).toBeLessThanOrEqual(RENDER_FEATURE_LEVEL);
  });
});
