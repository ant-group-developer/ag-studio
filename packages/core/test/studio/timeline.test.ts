import { describe, expect, it } from "vitest";
import { CompositionSchema, TimelineV2Schema, type TimelineV2 } from "@harness/contracts";
import { buildStudioTimeline } from "../../src/studio/build-timeline.js";
import {
  BEAT_TAIL, NARRATION_GAP, addClip, layoutTimeline, moveBeat, removeClip, replaceClipSegment, setLineAudio, setLineText,
  timelineIssues, trimClip, TimelineOpError,
} from "../../src/studio/layout.js";
import { cuesFor, timelineToComposition, cuesToSrt, cuesToVtt } from "../../src/studio/render-plan.js";
import { brief, catalog, narration, seg, selection, treatment } from "./fixtures.js";

const AUDIO = new Map([
  ["L001", { key: "audio/a1.wav", duration: 3 }],
  ["L002", { key: "audio/a2.wav", duration: 2.5 }],
  ["L003", { key: "audio/a3.wav", duration: 1.75 }],
  ["L004", { key: "audio/a4.wav", duration: 2 }],
]);

function built(): TimelineV2 {
  return buildStudioTimeline({ brief: brief(), treatment: treatment(), catalog: catalog().segments, selection: selection(), narration: narration(), audio: AUDIO });
}

describe("buildStudioTimeline", () => {
  it("cuts every beat to its narration and passes the schema with no issues", () => {
    const t = built();
    expect(TimelineV2Schema.safeParse(t).success).toBe(true);
    expect(timelineIssues(t)).toEqual([]);
    const layout = layoutTimeline(t);
    expect(layout.beats.map((b) => b.duration)).toEqual([3 + BEAT_TAIL, 2.5 + NARRATION_GAP + 1.75 + BEAT_TAIL, 2 + BEAT_TAIL]);
    // picks share the beat, taken from the middle of each 8 s segment
    const first = t.clips[0]!;
    expect(first.segment_id).toBe("s01");
    expect(first.src_in + first.src_out).toBeCloseTo(8, 3);
    // every segment the timeline or its alternates mention can be looked up
    for (const c of t.clips) expect(t.segments[c.segment_id]).toBeTruthy();
    for (const alts of Object.values(t.alternates)) for (const a of alts) expect(t.segments[a.segment_id]).toBeTruthy();
  });

  it("brings alternates in when the picks are too short, and never repeats a segment", () => {
    const c = catalog([seg("tiny1", 1), seg("tiny2", 1)]);
    const s = selection();
    s.beats[0]!.picks = [{ segment_id: "tiny1", reason: "x" }, { segment_id: "tiny2", reason: "x" }];
    const t = buildStudioTimeline({ brief: brief(), treatment: treatment(), catalog: c.segments, selection: s, narration: narration(), audio: AUDIO });
    const b1 = t.clips.filter((x) => x.beat_id === "B01").map((x) => x.segment_id);
    expect(b1).toEqual(["tiny1", "tiny2", "s07"]);
    expect(t.alternates.B01!.map((a) => a.segment_id)).not.toContain("s07");
    const all = t.clips.map((x) => x.segment_id);
    expect(new Set(all).size).toBe(all.length);
    expect(timelineIssues(t)).toEqual([]);
  });
});

describe("timeline issues", () => {
  it("reports narration longer than the picture, lines without audio and a segment used twice", () => {
    let t = built();
    t = setLineText(t, "L001", "Một câu mới hoàn toàn");
    t = trimClip(t, "C001", 0, 0.5);
    t = trimClip(t, "C002", 0, 0.5);
    t = { ...t, clips: t.clips.map((c) => (c.clip_id === "C006" ? { ...c, segment_id: "s01" } : c)) };
    const codes = timelineIssues(t).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["narration_not_voiced", "narration_overflow", "duplicate_segment"]));
  });
});

describe("editing operations (what the web reducer dispatches)", () => {
  it("replaceClipSegment keeps the clip length and swaps the old segment into the beat's alternates", () => {
    const t0 = built();
    const before = t0.clips[0]!;
    const t = replaceClipSegment(t0, before.clip_id, "s07");
    const after = t.clips[0]!;
    expect(after.segment_id).toBe("s07");
    expect(after.src_out - after.src_in).toBeCloseTo(before.src_out - before.src_in, 3);
    expect(t.alternates.B01!.map((a) => a.segment_id)).toEqual(expect.arrayContaining(["s01"]));
    expect(t.alternates.B01!.map((a) => a.segment_id)).not.toContain("s07");
    expect(t0.clips[0]!.segment_id).toBe("s01"); // pure: the input is untouched
  });

  it("trimClip clamps to the segment and to the minimum clip length", () => {
    const t = trimClip(built(), "C001", -3, 99);
    expect([t.clips[0]!.src_in, t.clips[0]!.src_out]).toEqual([0, 8]);
    const t2 = trimClip(built(), "C001", 7.9, 8);
    expect(t2.clips[0]!.src_out - t2.clips[0]!.src_in).toBeCloseTo(0.5, 3);
  });

  it("moveBeat moves picture, voice and text of the beat together", () => {
    const t0 = built();
    const t = moveBeat(t0, 0, 2);
    const layout = layoutTimeline(t);
    expect(layout.beats.map((b) => b.beat_id)).toEqual(["B02", "B03", "B01"]);
    const b1 = layout.beats[2]!;
    expect(b1.lines.map((l) => l.line_id)).toEqual(["L001"]);
    expect(b1.lines[0]!.start).toBe(b1.start);
    expect(b1.texts[0]!.start).toBeCloseTo(b1.start + 0.5, 3);
    expect(b1.clips[0]!.start).toBe(b1.start);
    expect(layout.duration).toBeCloseTo(layoutTimeline(t0).duration, 3);
  });

  it("setLineText drops only that line's audio; setLineAudio refuses audio of an older text", () => {
    const t = setLineText(built(), "L003", "Hành phi vàng giòn");
    expect(t.narration.filter((l) => l.audio === null).map((l) => l.line_id)).toEqual(["L003"]);
    expect(() => setLineAudio(t, "L003", "Hành nướng thơm lừng", { key: "audio/x.wav", duration: 1 })).toThrow(TimelineOpError);
    const voiced = setLineAudio(t, "L003", "Hành phi vàng giòn", { key: "audio/x.wav", duration: 1.2 });
    expect(voiced.narration.find((l) => l.line_id === "L003")!.audio).toEqual({ key: "audio/x.wav", duration: 1.2 });
  });

  it("addClip/removeClip keep a beat non-empty", () => {
    let t = addClip(built(), "B03", "s12", 3);
    const added = t.clips.find((c) => c.segment_id === "s12")!;
    expect(added.beat_id).toBe("B03");
    expect(added.src_out - added.src_in).toBeCloseTo(3, 3);
    t = removeClip(t, added.clip_id);
    const only = t.clips.filter((c) => c.beat_id === "B01");
    t = removeClip(t, only[0]!.clip_id);
    expect(() => removeClip(t, only[1]!.clip_id)).toThrow(/ít nhất một clip/);
  });
});

describe("render plan", () => {
  it("produces a composition the render worker accepts, with asset-absolute source times", () => {
    const t = { ...built(), music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true } };
    const comp = timelineToComposition(t, { audioInput: (k) => `stage:${k}` });
    expect(CompositionSchema.safeParse(comp).success).toBe(true);
    // fixture segments start 10 s into their asset
    expect(comp.segments[0]!.in).toBeCloseTo(10 + t.clips[0]!.src_in, 3);
    expect(comp.segments[0]!.source_path).toBe("segment:s01");
    expect(comp.narration.map((n) => n.wav)).toEqual(["stage:audio/a1.wav", "stage:audio/a2.wav", "stage:audio/a3.wav", "stage:audio/a4.wav"]);
    expect(comp.music!.duck.windows).toHaveLength(4);
    expect(comp.total_seconds).toBeCloseTo(layoutTimeline(t).duration, 3);
    // the same production and segment always map to the same ids (mezzanine cache hits across renders)
    expect(timelineToComposition(t, { audioInput: (k) => k }).segments[0]!.source_id).toBe(comp.segments[0]!.source_id);
  });

  it("writes SRT and VTT cues of at most two 42-character lines", () => {
    const t = setLineAudio(setLineText(built(), "L001", "Hà Nội buổi sáng thức dậy với mùi phở thơm nồng lan khắp các con phố nhỏ quanh hồ Hoàn Kiếm và chợ Đồng Xuân"), "L001",
      "Hà Nội buổi sáng thức dậy với mùi phở thơm nồng lan khắp các con phố nhỏ quanh hồ Hoàn Kiếm và chợ Đồng Xuân", { key: "audio/l1.wav", duration: 6 });
    const cues = cuesFor(layoutTimeline(t));
    expect(cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= 42))).toBe(true);
    const srt = cuesToSrt(cues);
    expect(srt.startsWith("1\n00:00:00,000 --> ")).toBe(true);
    expect(cuesToVtt(cues).startsWith("WEBVTT\n\n00:00:00.000 --> ")).toBe(true);
  });
});
