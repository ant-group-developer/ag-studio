import { describe, expect, it } from "vitest";
import type { TimelineOp, TimelineV3 } from "@harness/contracts";
import { applyTimelineOps, TimelineOpError } from "../../src/studio/layout.js";

const asset = (d: number) => ({ title: "Video", summary_vi: "Clip", duration_s: d, orientation: "landscape" as const });

function tl(): TimelineV3 {
  return {
    schema_version: "studio.timeline/v3", production_id: "p", episode_id: "e", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
    clips: [
      { clip_id: "C001", asset_id: "a01", section_title: "Mở đầu" },
      { clip_id: "C002", asset_id: "a02", section_title: null },
    ],
    texts: [{ text_id: "T001", kind: "lower_third", text: "Gion", start: 2, duration: 4, position: "bottom_left" }],
    music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true },
    source_audio: { muted: false },
    assets: { a01: asset(8), a02: asset(10) },
    alternates: [],
  };
}

describe("applyTimelineOps", () => {
  it("runs the edits in order on a copy", () => {
    const before = tl();
    const ops: TimelineOp[] = [
      { op: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -22, ducking: true } },
      { op: "addText", kind: "lower_third", text: "Sagano bamboo grove", start: 8, duration: 6, position: "bottom_left" },
      { op: "updateText", text_id: "T001", kind: null, text: "Gion buổi sáng", start: null, duration: null, position: null },
      { op: "addClip", asset_id: "a03", index: 0 },
      { op: "moveClip", from: 0, to: 2 },
      { op: "setSectionTitle", clip_id: "C002", title: "Rừng tre" },
      { op: "setSourceMuted", muted: true },
    ];
    const after = applyTimelineOps(before, ops, { a03: asset(12) });
    expect(after.music?.gain_db).toBe(-22);
    expect(after.texts.map((x) => [x.text_id, x.text, x.start])).toEqual([["T001", "Gion buổi sáng", 2], ["T002", "Sagano bamboo grove", 8]]);
    expect(after.clips.map((c) => c.asset_id)).toEqual(["a01", "a02", "a03"]);
    expect(after.clips.find((c) => c.clip_id === "C002")?.section_title).toBe("Rừng tre");
    expect(after.assets.a03?.duration_s).toBe(12);
    expect(after.source_audio.muted).toBe(true);
    expect(before.clips).toHaveLength(2); // untouched
  });

  it("swaps a clip to an allowed video and keeps the old one as an alternate", () => {
    const after = applyTimelineOps(tl(), [{ op: "replaceClipAsset", clip_id: "C002", asset_id: "a09" }], { a09: asset(5) });
    expect(after.clips[1]?.asset_id).toBe("a09");
    expect(after.alternates.map((a) => a.asset_id)).toEqual(["a02"]);
  });

  it("refuses a video the episode may not use, and names the op that failed", () => {
    expect(() => applyTimelineOps(tl(), [{ op: "removeText", text_id: "T001" }, { op: "addClip", asset_id: "zz", index: 0 }], {}))
      .toThrow(TimelineOpError);
    try { applyTimelineOps(tl(), [{ op: "removeClip", clip_id: "C009" }], {}); }
    catch (e) { expect((e as TimelineOpError).code).toBe("not_found"); expect((e as Error).message).toMatch(/^thao tác 1 \(removeClip\)/); }
  });
});
