import { describe, expect, it } from "vitest";
import { layoutTimeline, timelineIssues } from "@studio/timeline";
import { editorReducer, HISTORY_LIMIT, initEditor, isDirty, type EditorAction, type EditorState } from "./editor-reducer";
import { sampleTimeline } from "./fixtures";

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);
const clip = (s: EditorState, id: string) => s.timeline.clips.find((c) => c.clip_id === id)!;

describe("editor reducer (M1)", () => {
  it("trim inside the segment moves every later beat, and a drag is one undo step", () => {
    const s0 = initEditor(sampleTimeline(), 4);
    const before = layoutTimeline(s0.timeline);
    const s1 = run(s0,
      { type: "trimClip", clipId: "C001", srcIn: 1, srcOut: 4 },
      { type: "trimClip", clipId: "C001", srcIn: 1, srcOut: 5 },
      { type: "trimClip", clipId: "C001", srcIn: 0.5, srcOut: 5 },
    );
    expect([clip(s1, "C001").src_in, clip(s1, "C001").src_out]).toEqual([0.5, 5]);
    const after = layoutTimeline(s1.timeline);
    expect(after.beats[1]!.start).toBeCloseTo(before.beats[1]!.start + 2.5, 3);
    expect(s1.past).toHaveLength(1);
    expect(isDirty(s1)).toBe(true);
    const undone = run(s1, { type: "undo" });
    expect(undone.timeline).toBe(s0.timeline);
    expect(isDirty(undone)).toBe(false);
  });

  it("trim is clamped to the segment (0–8 s here)", () => {
    const s = run(initEditor(sampleTimeline(), 1), { type: "trimClip", clipId: "C003", srcIn: -2, srcOut: 30 });
    expect([clip(s, "C003").src_in, clip(s, "C003").src_out]).toEqual([0, 8]);
  });

  it("swap a clip for a beat alternate: same length, old footage becomes the alternate", () => {
    const s = run(initEditor(sampleTimeline(), 1), { type: "swapClip", clipId: "C001", segmentId: "s7" });
    expect(clip(s, "C001").segment_id).toBe("s7");
    expect(clip(s, "C001").src_out - clip(s, "C001").src_in).toBeCloseTo(2, 3);
    expect(s.timeline.alternates.B01!.map((a) => a.segment_id)).toEqual(["s1"]);
  });

  it("swap a clip for a catalog segment not yet in the timeline registers it first", () => {
    const info = { asset_id: "asset-9", start_ms: 5000, end_ms: 9000, caption: "ngõ nhỏ", orientation: "landscape" };
    const s = run(initEditor(sampleTimeline(), 1), { type: "swapClip", clipId: "C002", segmentId: "cat-42", segment: info });
    expect(s.timeline.segments["cat-42"]).toEqual(info);
    expect(clip(s, "C002").segment_id).toBe("cat-42");
    expect(timelineIssues(s.timeline).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("re-orders beats: picture, narration and text move together; undo/redo restore exactly", () => {
    const s0 = initEditor(sampleTimeline(), 1);
    const s1 = run(s0, { type: "moveBeat", from: 2, to: 0 });
    const lay = layoutTimeline(s1.timeline);
    expect(lay.beats.map((b) => b.beat_id)).toEqual(["B03", "B01", "B02"]);
    expect(lay.lines.map((l) => l.line_id)).toEqual(["L003", "L001", "L002"]);
    expect(lay.texts[0]!.start).toBeCloseTo(lay.beats[1]!.start + 0.5, 3);
    const s2 = run(s1, { type: "undo" });
    expect(s2.timeline).toBe(s0.timeline);
    const s3 = run(s2, { type: "redo" });
    expect(s3.timeline).toBe(s1.timeline);
    expect(run(s3, { type: "redo" })).toBe(s3); // nothing left to redo
  });

  it("a new edit after undo drops the redo branch", () => {
    const s = run(initEditor(sampleTimeline(), 1), { type: "moveBeat", from: 0, to: 1 }, { type: "undo" }, { type: "setCaptions", enabled: false });
    expect(s.future).toEqual([]);
    expect(s.timeline.captions.enabled).toBe(false);
  });

  it("editing a sentence leaves only that sentence waiting for TTS; its audio comes back through setLineAudio", () => {
    const s1 = run(initEditor(sampleTimeline(), 1), { type: "setLineText", lineId: "L002", text: "Nước dùng trong veo" });
    expect(s1.timeline.narration.map((l) => l.audio === null)).toEqual([false, true, false]);
    const s2 = run(s1, { type: "setLineAudio", lineId: "L002", forText: "Nồi nước dùng", audio: { key: "audio/x.wav", duration: 2 } });
    expect(s2.error).toMatch(/đã đổi chữ/); // audio of the old text is refused
    expect(s2.timeline).toBe(s1.timeline);
    const s3 = run(s2, { type: "setLineAudio", lineId: "L002", forText: "Nước dùng trong veo", audio: { key: "audio/y.wav", duration: 2.2 } });
    expect(s3.timeline.narration[1]!.audio).toEqual({ key: "audio/y.wav", duration: 2.2 });
    expect(s3.error).toBeNull();
  });

  it("texts, music and source sound are edits like any other", () => {
    const s = run(initEditor(sampleTimeline(), 1),
      { type: "addText", text: { beat_id: "B02", kind: "callout", text: "Ninh 12 giờ", offset: 1, duration: 2, position: "center" } },
      { type: "updateText", textId: "T001", patch: { text: "Phở sáng Hà Nội" } },
      { type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true } },
      { type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -12, ducking: true } },
      { type: "setSourceMuted", muted: false },
    );
    expect(s.timeline.texts.map((t) => t.text_id)).toEqual(["T001", "T002"]);
    expect(s.timeline.texts[0]!.text).toBe("Phở sáng Hà Nội");
    expect(s.timeline.music!.gain_db).toBe(-12);
    expect(s.timeline.source_audio.muted).toBe(false);
    expect(s.past).toHaveLength(4); // the two volume changes are one step
  });

  it("an invalid edit keeps the timeline and reports the error", () => {
    const s0 = run(initEditor(sampleTimeline(), 1), { type: "removeClip", clipId: "C005" });
    const s1 = run(s0, { type: "removeClip", clipId: "C006" });
    expect(s1.timeline).toBe(s0.timeline);
    expect(s1.error).toMatch(/ít nhất một clip/);
  });

  it("saving advances the base revision; edits made during the save stay dirty", () => {
    const s1 = run(initEditor(sampleTimeline(), 4), { type: "moveBeat", from: 0, to: 1 });
    const sent = s1.timeline;
    const s2 = run(s1, { type: "setCaptions", enabled: false }, { type: "saved", revision: 5, timeline: sent });
    expect(s2.revision).toBe(5);
    expect(isDirty(s2)).toBe(true);
    expect(isDirty(run(s2, { type: "saved", revision: 6, timeline: s2.timeline }))).toBe(false);
  });

  it("keeps at most HISTORY_LIMIT undo steps", () => {
    let s = initEditor(sampleTimeline(), 1);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s = editorReducer(s, { type: "setCaptions", enabled: i % 2 === 0 });
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });
});
