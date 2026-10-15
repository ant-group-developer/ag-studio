/** Cuts on the music's beat (feedback-vps §4.7): `snapCuts` moves a shot's cut to the nearest beat or first beat of a bar. */
import { describe, expect, it } from "vitest";
import { gridPoints, snapCuts, wholeFrames, type BeatGrid, type SnapClip } from "../../src/studio/beat-snap.js";

// 120 BPM from 0.25 s: a beat every 0.5 s, a bar every 2 s, a 30 s track
const beats = Array.from({ length: 60 }, (_, k) => 0.25 + k * 0.5);
const GRID: BeatGrid = { beats, downbeats: beats.filter((_, k) => k % 4 === 0), duration_s: 30 };
const clip = (duration: number, o: Partial<SnapClip> = {}): SnapClip => ({ duration, snap: null, room: 5, ...o });
const cuts = (d: number[]) => d.reduce<number[]>((a, x) => [...a, Math.round(((a.at(-1) ?? 0) + x) * 1000) / 1000], []);

describe("snapCuts", () => {
  it("moves each cut to the nearest first beat of a bar, later clips moving with it", () => {
    const r = snapCuts([clip(3.1, { snap: "bar" }), clip(4.3, { snap: "bar" }), clip(2.6, { snap: "bar" })], GRID);
    expect(cuts(r.durations)).toEqual([2.25, 6.25, 8.25]);
    expect(r.moves).toEqual([
      { index: 0, snap: "bar", from: 3.1, to: 2.25 },
      { index: 1, snap: "bar", from: 6.55, to: 6.25 },
      { index: 2, snap: "bar", from: 8.85, to: 8.25 },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("on the beat: never more than half a beat off; clips without snap keep their length", () => {
    const r = snapCuts([clip(1.9, { snap: "beat" }), clip(2.2), clip(1.3, { snap: "beat" })], GRID);
    expect(cuts(r.durations)).toEqual([1.75, 3.95, 5.25]);
    expect(r.durations[1]).toBe(2.2);
  });

  it("never below the shortest clip, never past what the shot holds", () => {
    // the nearest bar (2.25) would leave 0.25 s of the second clip; the next one (4.25) is out of its room
    const r = snapCuts([clip(2, { snap: "bar" }), clip(1.2, { snap: "bar", room: 0.5 })], GRID, { minSeconds: 1 });
    expect(r.durations[0]).toBe(2.25);
    expect(r.durations[1]).toBe(1.2);
    expect(r.skipped).toEqual([{ index: 1, snap: "bar", reason: "no_point" }]);
    // no room at all: the cut only moves earlier, and not at all when the bar before is too close to the start
    expect(cuts(snapCuts([clip(2.6, { snap: "bar", room: 0 })], GRID).durations)).toEqual([2.25]);
    expect(cuts(snapCuts([clip(1.6, { snap: "bar", room: 0 })], GRID).durations)).toEqual([1.6]);
  });

  it("never lets a narration line run into the next one", () => {
    // line 1 (3 s) starts 0.3 s into clip 0; line 2 starts 0.3 s into clip 1: clip 0 may not end before 3.0
    const clips = [clip(3.2, { snap: "bar", line: { lead: 0.3, length: 3 } }), clip(3, { line: { lead: 0.3, length: 2 } })];
    const r = snapCuts(clips, GRID);
    // the nearest bar (2.25) would cut line 1 short of its end: the next one in reach (4.25) instead
    expect(cuts(r.durations)).toEqual([4.25, 7.25]);
    const tight = snapCuts([{ ...clips[0]!, room: 0.5 }, clips[1]!], GRID);
    expect(tight.durations).toEqual([3.2, 3]);
    expect(tight.skipped).toEqual([{ index: 0, snap: "bar", reason: "narration" }]);
  });

  it("the music loops: its beats start again where it does", () => {
    const short: BeatGrid = { beats: [0.1, 1.1, 2.1, 3.1], downbeats: [0.1], duration_s: 4 };
    expect(gridPoints(short, "bar", 9)).toEqual([0.1, 4.1, 8.1]);
    expect(gridPoints(short, "bar", 9, false)).toEqual([0.1]);
    expect(cuts(snapCuts([clip(7.5, { snap: "bar" })], short).durations)).toEqual([8.1]);
  });

  it("with fps, a cut sits on the frame nearest to the bar and every clip is whole frames, so a render does not drift", () => {
    const odd: BeatGrid = { beats: [1.625, 3.785, 5.898, 8.01], downbeats: [1.625, 3.785, 5.898, 8.01], duration_s: 30 };
    expect(gridPoints(odd, "bar", 10, true, 30)).toEqual([1.633, 3.8, 5.9, 8]);
    // 114 + 63 frames, a clip without snap (1.31 s) rounded to 39 frames, then 63 more to the bar at 8.0
    const r = snapCuts([clip(3.6, { snap: "bar" }), clip(2, { snap: "bar" }), clip(1.31), clip(0.9, { snap: "bar" })], odd, { fps: 30 });
    expect(r.durations).toEqual([3.8, 2.1, 1.3, 0.8]);
    expect(r.durations.map((d) => Math.ceil(d * 30 - 1e-9))).toEqual([114, 63, 39, 24]);
    // 131 frames are 4.3666… s: written 4.366, not 4.367 (which would play a 132nd)
    expect(wholeFrames([4.3667], 30)).toEqual([4.366]);
    expect(r.moves.map((m) => m.to)).toEqual([3.8, 5.9, 8]);
  });

  it("whole frames: never one frame more (ffmpeg keeps frames before the length), never one less", () => {
    for (const fps of [25, 30]) {
      const lengths = Array.from({ length: 200 }, (_, i) => 0.5 + ((i * 7919) % 1000) / 137);
      const out = wholeFrames(lengths, fps);
      let at = 0;
      let frames = 0;
      out.forEach((d, i) => {
        const k = Math.ceil(d * fps - 1e-9);
        expect(d).toBeGreaterThan((k - 1) / fps);
        frames += k;
        at += lengths[i]!;
        expect(Math.abs(frames - at * fps)).toBeLessThanOrEqual(0.5 + 1e-9);
      });
    }
  });

  it("music without beats leaves every cut", () => {
    const r = snapCuts([clip(3, { snap: "beat" })], { beats: [], downbeats: [], duration_s: 30 });
    expect(r.durations).toEqual([3]);
    expect(r.skipped).toEqual([{ index: 0, snap: "beat", reason: "no_point" }]);
  });
});
