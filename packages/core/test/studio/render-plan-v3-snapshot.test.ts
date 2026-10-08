/**
 * The composition of a v3 timeline must not change by a byte when the renderer learns v4 (ADR-0001 item 151):
 * these snapshots were recorded with the v3-only `timelineToComposition`.
 */
import { describe, expect, it } from "vitest";
import type { TimelineV3 } from "@harness/contracts";
import { timelineToComposition } from "../../src/studio/render-plan.js";

const asset = (d: number) => ({ title: "Video", summary_vi: "Clip", duration_s: d, orientation: "landscape" as const });

const WITH_MUSIC: TimelineV3 = {
  schema_version: "studio.timeline/v3", production_id: "prod-1", episode_id: "ep-1", canvas: { width: 3840, height: 2160 }, fps: 30, language: "vi",
  clips: [
    { clip_id: "C001", asset_id: "a01", section_title: "Mở đầu" },
    { clip_id: "C002", asset_id: "a02", section_title: null },
    { clip_id: "C003", asset_id: "a03", section_title: "Đền vua Đinh" },
  ],
  texts: [
    { text_id: "T001", kind: "title", text: "Hoa Lư", start: 0.5, duration: 3.5, position: "top_left" },
    { text_id: "T002", kind: "lower_third", text: "Đền vua Đinh", start: 21.25, duration: 5, position: "bottom_left" },
  ],
  music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true },
  source_audio: { muted: false },
  assets: { a01: asset(12.3456), a02: asset(8.5), a03: asset(20) },
  alternates: [],
};

const MUTED: TimelineV3 = {
  ...WITH_MUSIC, production_id: "prod-2", episode_id: "ep-2", canvas: { width: 1080, height: 1920 }, fps: 25,
  clips: [{ clip_id: "C001", asset_id: "a02", section_title: null }],
  texts: [], music: null, source_audio: { muted: true },
};

describe("timelineToComposition on v3", () => {
  it("a timeline with music, texts and sections", () => {
    expect(JSON.stringify(timelineToComposition(WITH_MUSIC), null, 1)).toMatchSnapshot();
  });

  it("a muted single clip, no music", () => {
    expect(JSON.stringify(timelineToComposition(MUTED), null, 1)).toMatchSnapshot();
  });
});
