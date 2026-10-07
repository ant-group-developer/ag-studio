import { describe, expect, it } from "vitest";
import { TimelineV4Schema, upgradeTimelineV3, type TimelineV3, type TimelineV4 } from "@harness/contracts";
import {
  addClip, applyTimelineOps, layoutTimeline, moveClip, removeClip, replaceClipAsset, resolveTransitions, setCaptions,
  setTransition, timelineIssues, TimelineOpError, trimClip,
} from "../../src/studio/layout.js";

const asset = (d: number) => ({ title: "Video", summary_vi: "Clip", duration_s: d, orientation: "landscape" as const });
const KEY = "a".repeat(64);

function v3(): TimelineV3 {
  return {
    schema_version: "studio.timeline/v3", production_id: "p", episode_id: "e", canvas: { width: 3840, height: 2160 }, fps: 30, language: "vi",
    clips: [
      { clip_id: "C001", asset_id: "a01", section_title: "Mở đầu" },
      { clip_id: "C002", asset_id: "a02", section_title: null },
    ],
    texts: [{ text_id: "T001", kind: "title", text: "Hoa Lư", start: 0.5, duration: 3, position: "top_left" }],
    music: null,
    source_audio: { muted: false },
    assets: { a01: asset(20), a02: asset(10), a03: asset(6) },
    alternates: [],
  };
}

/** Three shots: 2–5 s of a01, 0–4 s of a02, 10–14 s of a01; L001 on C001, L002 on C003. */
function cut(): TimelineV4 {
  const base = upgradeTimelineV3(v3());
  const clip = (clip_id: string, asset_id: string, inS: number, out: number | null, line_id: string | null, kind: "cut" | "dissolve" = "cut") => ({
    clip_id, asset_id, section_title: null, in: inS, out, shot_id: null, line_id, transition_out: { kind, seconds: kind === "cut" ? 0 : 0.4 },
  });
  return TimelineV4Schema.parse({
    ...base,
    edit_style: "cut",
    clips: [clip("C001", "a01", 2, 5, "L001", "dissolve"), clip("C002", "a02", 0, 4, null), clip("C003", "a01", 10, 14, "L002")],
    narration: {
      voice: "tts", lead_seconds: 0.3,
      lines: [
        { line_id: "L001", text: "Phố cổ Hoa Lư lúc chiều.", audio: { key: KEY, duration_s: 2.5, words: [] } },
        { line_id: "L002", text: "Đền vua Đinh.", audio: { key: KEY, duration_s: 1.5, words: [] } },
      ],
    },
    captions: { mode: "burn-in" },
  });
}

const codes = (t: TimelineV3 | TimelineV4, target?: number) => timelineIssues(t, { targetSeconds: target }).map((i) => `${i.severity}:${i.code}`);

describe("layoutTimeline on v4", () => {
  it("lays trimmed clips back to back and resolves out", () => {
    const l = layoutTimeline(cut());
    expect(l.clips.map((c) => [c.clip_id, c.start, c.end, c.duration, c.in, c.source_out])).toEqual([
      ["C001", 0, 3, 3, 2, 5], ["C002", 3, 7, 4, 0, 4], ["C003", 7, 11, 4, 10, 14],
    ]);
    expect(l.duration).toBe(11);
  });

  it("an out of null plays to the end of the asset, as v3", () => {
    const l = layoutTimeline(v3());
    expect(l.clips.map((c) => [c.start, c.end, c.in, c.source_out])).toEqual([[0, 20, 0, 20], [20, 30, 0, 10]]);
    expect(l.lines).toEqual([]);
  });

  it("places each narration line after the start of its clip", () => {
    expect(layoutTimeline(cut()).lines).toEqual([
      { line_id: "L001", clip_id: "C001", start: 0.3, end: 2.8, estimated: false },
      { line_id: "L002", clip_id: "C003", start: 7.3, end: 8.8, estimated: false },
    ]);
  });

  it("estimates an unread line from its length", () => {
    const t = cut();
    t.narration.lines[1] = { ...t.narration.lines[1]!, audio: null };
    const line = layoutTimeline(t).lines[1]!;
    expect(line.estimated).toBe(true);
    expect(line.end).toBeCloseTo(7.3 + "Đền vua Đinh.".length / 14, 3);
  });
});

describe("resolveTransitions", () => {
  it("keeps a dissolve with a tail and a long enough next clip, the last clip cuts", () => {
    expect(resolveTransitions(layoutTimeline(cut()))).toEqual([
      { kind: "dissolve", seconds: 0.4, tail_available: true, downgraded: null },
      { kind: "cut", seconds: 0, tail_available: false, downgraded: null },
      { kind: "cut", seconds: 0, tail_available: false, downgraded: null },
    ]);
  });

  it("downgrades a dissolve with no tail, a too short next clip, and a short dip to black", () => {
    let t = setTransition(cut(), "C002", "dissolve", 0.4);
    t = trimClip(t, "C002", 6, null); // to the end of a02: no tail
    t = setTransition(t, "C003", "dissolve", 0.4); // last clip: never a transition
    const r = resolveTransitions(layoutTimeline(t));
    expect(r[1]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false, downgraded: "no_tail" });
    expect(r[2]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false, downgraded: null });

    const short = trimClip(cut(), "C002", 0, 0.6);
    expect(resolveTransitions(layoutTimeline(short))[0]?.downgraded).toBe("next_too_short");
    const dip = trimClip(setTransition(cut(), "C001", "dip_black", 0.8), "C002", 0, 0.6);
    expect(resolveTransitions(layoutTimeline(dip))[0]).toEqual({ kind: "cut", seconds: 0.8, tail_available: false, downgraded: "too_short" });
  });
});

describe("timelineIssues on v4", () => {
  it("a v3 timeline read as v4 gives exactly the v3 issues", () => {
    const t = v3();
    t.clips.push({ clip_id: "C003", asset_id: "a01", section_title: null });
    expect(codes(upgradeTimelineV3(t), 60)).toEqual(codes(t, 60));
    expect(codes(t, 60)).toContain("error:duplicate_asset");
  });

  it("a clean shot-cut timeline has no issues", () => {
    expect(codes(cut(), 11)).toEqual([]);
  });

  it("a cut episode may reuse an asset, but warns when the ranges overlap", () => {
    expect(codes(cut())).not.toContain("error:duplicate_asset");
    expect(codes(trimClip(cut(), "C003", 4, 8))).toContain("warning:overlapping_range");
  });

  it("flags ranges, short clips and narration problems", () => {
    const beyond = cut();
    beyond.clips[1] = { ...beyond.clips[1]!, out: 12 }; // a02 is 10 s long
    expect(codes(beyond)).toContain("error:bad_range");
    const late = cut();
    late.clips[1] = { ...late.clips[1]!, in: 11, out: null };
    expect(codes(late)).toContain("error:bad_range");
    expect(codes(trimClip(cut(), "C002", 0, 0.3))).toContain("error:clip_too_short");
    const unknown = cut();
    unknown.clips[1] = { ...unknown.clips[1]!, line_id: "L009" };
    expect(codes(unknown)).toContain("error:unknown_line");
    const twice = cut();
    twice.clips[1] = { ...twice.clips[1]!, line_id: "L001" };
    expect(codes(twice)).toContain("error:duplicate_line");
    const silent = cut();
    silent.narration.lines[0] = { ...silent.narration.lines[0]!, audio: null };
    expect(codes(silent)).toContain("error:line_without_audio");
    const loose = cut();
    loose.clips[2] = { ...loose.clips[2]!, line_id: null };
    expect(codes(loose)).toContain("warning:unanchored_line");
    // C001 0–0.6, C002 0.6–1.6: L002 starts at 1.9 while L001 (0.3–2.8) is still being read
    expect(codes(trimClip(trimClip(cut(), "C001", 2, 2.6), "C002", 0, 1))).toContain("warning:narration_overrun");
    expect(codes(trimClip(cut(), "C002", 0, 9.5))).not.toContain("warning:narration_overrun");
    expect(codes(setTransition(trimClip(cut(), "C001", 2, 20), "C001", "dissolve", 0.4))).toContain("warning:transition_no_tail");
  });
});

describe("edit operations on v4", () => {
  it("keep a v3 timeline v3 and a v4 timeline v4", () => {
    const a = addClip(v3(), "a03", 1);
    expect(a.schema_version).toBe("studio.timeline/v3");
    expect(a.clips[1]).toEqual({ clip_id: "C003", asset_id: "a03", section_title: null });
    const b = addClip(cut(), "a03", 1);
    expect(b.clips[1]).toEqual({
      clip_id: "C004", asset_id: "a03", section_title: null, in: 0, out: null, shot_id: null, line_id: null,
      transition_out: { kind: "cut", seconds: 0 },
    });
    expect(TimelineV4Schema.safeParse(b).success).toBe(true);
  });

  it("trimming moves every later clip", () => {
    const l = layoutTimeline(trimClip(cut(), "C001", 2, 3));
    expect(l.clips.map((c) => c.start)).toEqual([0, 1, 5]);
  });

  it("trim, transition and captions are v4 only and checked", () => {
    expect(() => trimClip(v3() as never, "C001", 1, 2)).toThrow(TimelineOpError);
    try { setCaptions(v3() as never, "karaoke"); } catch (e) { expect((e as TimelineOpError).code).toBe("needs_v4"); }
    expect(() => trimClip(cut(), "C001", 3, 3)).toThrow(TimelineOpError);
    expect(() => trimClip(cut(), "C001", 2, 25)).toThrow(TimelineOpError);
    expect(() => trimClip(cut(), "C404", 0, 1)).toThrow(TimelineOpError);
    expect(() => setTransition(cut(), "C001", "dissolve", 1.5)).toThrow(TimelineOpError);
    expect(setCaptions(cut(), "karaoke").captions.mode).toBe("karaoke");
  });

  it("removing a clip hands its narration line to the next clip when that one is free", () => {
    expect(removeClip(cut(), "C001").clips[0]).toMatchObject({ clip_id: "C002", line_id: "L001" });
    const t = moveClip(cut(), 2, 1); // C001(L001), C003(L002), C002
    expect(removeClip(t, "C001").clips.map((c) => [c.clip_id, c.line_id])).toEqual([["C003", "L002"], ["C002", null]]);
  });

  it("a new asset on a shot keeps the shot's length and drops the shot id", () => {
    const t = cut();
    t.clips[1] = { ...t.clips[1]!, shot_id: "s001-002" };
    const r = replaceClipAsset(t, "C002", "a03");
    expect(r.clips[1]).toMatchObject({ asset_id: "a03", in: 0, out: 4, shot_id: null });
    expect(replaceClipAsset(cut(), "C001", "a03").clips[0]).toMatchObject({ in: 0, out: 3 });
    const longer = trimClip(cut(), "C002", 0, 9);
    expect(replaceClipAsset(longer, "C002", "a03").clips[1]).toMatchObject({ in: 0, out: null });
  });

  it("chat ops trim and set transitions; on a v3 timeline they are refused", () => {
    const after = applyTimelineOps(cut(), [
      { op: "trimClip", clip_id: "C002", in: 1, out: 3 },
      { op: "setTransition", clip_id: "C002", kind: "dissolve", seconds: 0.5 },
      { op: "setCaptions", mode: "karaoke" },
    ], {});
    expect(after.clips[1]).toMatchObject({ in: 1, out: 3, transition_out: { kind: "dissolve", seconds: 0.5 } });
    expect(after.captions.mode).toBe("karaoke");
    try { applyTimelineOps(v3(), [{ op: "trimClip", clip_id: "C001", in: 1, out: 2 }], {}); }
    catch (e) { expect((e as TimelineOpError).code).toBe("needs_v4"); }
  });
});
