import { describe, expect, it } from "vitest";
import { layoutTimeline, timelineIssues } from "@studio/timeline";
import { editorReducer, HISTORY_LIMIT, initEditor, isDirty, type EditorAction, type EditorState } from "./editor-reducer";
import { sampleTimeline } from "./fixtures";

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);
const clip = (s: EditorState, id: string) => s.timeline.clips.find((c) => c.clip_id === id)!;

describe("editor reducer (v3)", () => {
  it("moveClip reorders clips and a drag is one undo step (coalesce is not implemented for move — just checking undo)", () => {
    const s0 = initEditor(sampleTimeline(), 4);
    const s1 = run(s0, { type: "moveClip", from: 0, to: 2 });
    const layout = layoutTimeline(s1.timeline);
    expect(layout.clips[2]!.clip_id).toBe("C001");
    expect(s1.past).toHaveLength(1);
    expect(isDirty(s1)).toBe(true);
    const undone = run(s1, { type: "undo" });
    expect(undone.timeline).toBe(s0.timeline);
    expect(isDirty(undone)).toBe(false);
  });

  it("removeClip removes the clip and undo restores it", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const s1 = run(s0, { type: "removeClip", clipId: "C002" });
    expect(s1.timeline.clips).toHaveLength(2);
    const s2 = run(s1, { type: "undo" });
    expect(s2.timeline).toBe(s0.timeline);
  });

  it("swapClip replaces asset on a clip; old asset goes to alternates", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const s1 = run(s0, { type: "swapClip", clipId: "C001", newAssetId: "asset-4" });
    expect(clip(s1, "C001").asset_id).toBe("asset-4");
    expect(s1.timeline.alternates.some((a) => a.asset_id === "asset-1")).toBe(true);
  });

  it("swapClip with a new asset registers it in assets via ensureAsset", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const newAsset = { title: "Mới", summary_vi: "mới", duration_s: 5, orientation: "landscape" as const };
    const s1 = run(s0, { type: "swapClip", clipId: "C002", newAssetId: "asset-new", asset: newAsset });
    expect(s1.timeline.assets["asset-new"]).toEqual(newAsset);
    expect(clip(s1, "C002").asset_id).toBe("asset-new");
  });

  it("redo: a new edit after undo drops the redo branch", () => {
    const s = run(initEditor(sampleTimeline(), 1),
      { type: "moveClip", from: 0, to: 1 },
      { type: "undo" },
      { type: "setSourceMuted", muted: false },
    );
    expect(s.future).toEqual([]);
    expect(s.timeline.source_audio.muted).toBe(false);
  });

  it("texts, music and source audio are edits like any other", () => {
    const s = run(initEditor(sampleTimeline(), 1),
      { type: "addText", text: { kind: "callout", text: "Ninh 12 giờ", start: 2, duration: 2, position: "center" } },
      { type: "updateText", textId: "T001", patch: { text: "Phở sáng Hà Nội" } },
      { type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true } },
      { type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -12, ducking: true } },
      { type: "setSourceMuted", muted: false },
    );
    expect(s.timeline.texts.map((t) => t.text_id)).toEqual(["T001", "T002"]);
    expect(s.timeline.texts[0]!.text).toBe("Phở sáng Hà Nội");
    expect(s.timeline.music!.gain_db).toBe(-12);
    expect(s.timeline.source_audio.muted).toBe(false);
    // Two setMusic calls coalesce into one undo step; addText + first updateText = 2 more; setSourceMuted = 1 more
    expect(s.past).toHaveLength(4);
  });

  it("an invalid edit keeps the timeline and reports the error", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    // Remove a clip using a non-existent id
    const s1 = run(s0, { type: "removeClip", clipId: "C999" });
    expect(s1.timeline).toBe(s0.timeline);
    expect(s1.error).toMatch(/không có clip/);
  });

  it("saving advances the base revision; edits made during the save stay dirty", () => {
    const s1 = run(initEditor(sampleTimeline(), 4), { type: "moveClip", from: 0, to: 1 });
    const sent = s1.timeline;
    const s2 = run(s1, { type: "setSourceMuted", muted: false }, { type: "saved", revision: 5, timeline: sent });
    expect(s2.revision).toBe(5);
    expect(isDirty(s2)).toBe(true);
    expect(isDirty(run(s2, { type: "saved", revision: 6, timeline: s2.timeline }))).toBe(false);
  });

  it("keeps at most HISTORY_LIMIT undo steps", () => {
    let s = initEditor(sampleTimeline(), 1);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s = editorReducer(s, { type: "setSourceMuted", muted: i % 2 === 0 });
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });

  it("setSectionTitle updates the clip", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const s1 = run(s0, { type: "setSectionTitle", clipId: "C002", title: "Chương 2" });
    expect(clip(s1, "C002").section_title).toBe("Chương 2");
  });

  it("timeline with 3 clips produces no errors", () => {
    const s = initEditor(sampleTimeline(), 1);
    const errs = timelineIssues(s.timeline).filter((i) => i.severity === "error");
    expect(errs).toEqual([]);
  });

  it("redo restores exactly after undo", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const s1 = run(s0, { type: "moveClip", from: 2, to: 0 });
    const s2 = run(s1, { type: "undo" });
    expect(s2.timeline).toBe(s0.timeline);
    const s3 = run(s2, { type: "redo" });
    expect(s3.timeline).toBe(s1.timeline);
    expect(run(s3, { type: "redo" })).toBe(s3); // nothing left to redo
  });
});
