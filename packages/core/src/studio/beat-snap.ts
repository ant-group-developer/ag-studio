/**
 * Cuts on the music's beat (plan 2026-10-15 feedback-vps §4.7): a shot of the edit plan with `snap: "beat" | "bar"` ends
 * on the nearest beat of the music, or the nearest first beat of a bar, instead of where the fit put its end. Pure.
 *
 * Clips play back to back, so a cut is the sum of the clips before it; the music plays from the start of the video and
 * again from its own start when it is shorter (`loop`). Clips are taken in order, each cut moved to the grid point
 * nearest to where it was that keeps the clip:
 * - at least `minSeconds` long (never shorter than it already was, when that is less);
 * - within what its shot still holds (`room`: it may grow by that much, never into the next shot of its video);
 * - from making narration overlap: no line may end later past the start of the next one than it did before (each line
 *   starts `lead` seconds into the clip that anchors it).
 * A clip whose cut cannot move is left as it is and said so. Later clips move with the cuts before them.
 *
 * With `fps`, each grid point is put on the nearest frame and every clip is made a whole number of frames, its length
 * rounded down to the millisecond (`wholeFrames`): a render plays whole frames, and ffmpeg keeps every frame before a
 * clip's length, so a 4.334 s clip at 30 fps plays 131 frames (4.367 s) and every cut after it comes a frame late.
 */
import type { SnapKind } from "@harness/contracts";
import { MIN_CLIP_SECONDS } from "./layout.js";

const EPS = 1e-6;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface SnapClip {
  /** Seconds it plays now. */
  duration: number;
  /** Where its cut goes; null: it stays. */
  snap: SnapKind | null;
  /** Seconds it may grow by (what its shot still holds after its out). */
  room: number;
  /** The narration line it anchors: it starts `lead` seconds into the clip and lasts `length`. */
  line?: { lead: number; length: number } | null;
}

/** The music's beats, in seconds of the track (`MusicBeatsSchema`). */
export interface BeatGrid {
  beats: readonly number[];
  downbeats: readonly number[];
  duration_s: number;
}

export interface SnapMove {
  /** Index of the clip whose cut moved. */
  index: number;
  snap: SnapKind;
  /** Where its cut was and is now (seconds of the video). */
  from: number;
  to: number;
}

export interface SnapSkip {
  index: number;
  snap: SnapKind;
  /** No grid point within reach; or every one in reach would make narration overlap. */
  reason: "no_point" | "narration";
}

/** Grid points of `kind` in `[0, until]`, the track repeated when `loop`, on the nearest frame when `fps` is given. */
export function gridPoints(grid: BeatGrid, kind: SnapKind, until: number, loop = true, fps?: number): number[] {
  const base = kind === "bar" ? grid.downbeats : grid.beats;
  if (!base.length) return [];
  const out: number[] = [];
  const period = grid.duration_s;
  for (let k = 0; ; k++) {
    const offset = k * period;
    if (offset > until || (k > 0 && (!loop || period <= 0))) break;
    for (const p of base) {
      const t = fps ? Math.round((p + offset) * fps) / fps : p + offset;
      if (t <= until + EPS) out.push(r3(t));
    }
  }
  return out;
}

/** How far each line runs past the start of the next one (negative: a gap), lines in play order. */
function overruns(durations: readonly number[], clips: readonly SnapClip[]): number[] {
  const lines: { start: number; end: number }[] = [];
  let at = 0;
  durations.forEach((d, i) => {
    const l = clips[i]!.line;
    if (l) lines.push({ start: at + l.lead, end: at + l.lead + l.length });
    at += d;
  });
  return lines.map((l, k) => l.end - (lines[k + 1]?.start ?? at));
}

/**
 * The clips' new lengths with their `snap` cuts on the grid, and what moved or could not. `minSeconds` defaults to the
 * shortest clip a timeline may hold.
 */
export function snapCuts(clips: readonly SnapClip[], grid: BeatGrid, o: { minSeconds?: number; loop?: boolean; fps?: number } = {}): {
  durations: number[]; moves: SnapMove[]; skipped: SnapSkip[];
} {
  const min = o.minSeconds ?? MIN_CLIP_SECONDS;
  const durations = clips.map((c) => c.duration);
  const before = overruns(durations, clips);
  // a line may not run further into the next one than it did, nor past the end when it did not
  const fits = () => overruns(durations, clips).every((v, k) => v <= Math.max(0, before[k]!) + 0.05);
  const until = clips.reduce((n, c) => n + c.duration + Math.max(0, c.room), 0);
  const points = { beat: null as number[] | null, bar: null as number[] | null };
  const moves: SnapMove[] = [];
  const skipped: SnapSkip[] = [];
  let start = 0;
  clips.forEach((c, i) => {
    if (c.snap) {
      const grid1 = (points[c.snap] ??= gridPoints(grid, c.snap, until, o.loop ?? true, o.fps));
      const cut = start + durations[i]!;
      const lo = start + Math.min(min, durations[i]!) - EPS;
      const hi = cut + Math.max(0, c.room) + EPS;
      const reach = grid1.filter((t) => t >= lo && t <= hi).sort((a, b) => Math.abs(a - cut) - Math.abs(b - cut));
      let moved = false;
      for (const t of reach) {
        const was = durations[i]!;
        durations[i] = r3(t - start);
        if (fits()) {
          if (Math.abs(t - cut) > 0.0005) moves.push({ index: i, snap: c.snap, from: r3(cut), to: t });
          moved = true;
          break;
        }
        durations[i] = was;
      }
      if (!moved) skipped.push({ index: i, snap: c.snap, reason: reach.length ? "narration" : "no_point" });
    }
    start += durations[i]!;
  });
  return { durations: o.fps ? wholeFrames(durations, o.fps) : durations, moves, skipped };
}

/**
 * Each clip's length as a whole number of frames, each cut on the frame nearest to it: `k` frames are written as
 * `k / fps` rounded down to three decimals (the render reads three), never more than `k / fps` (that would play one
 * frame more) and never as little as `k - 1` frames; exactly `k / fps` when three decimals hold it (6.2 s = 186).
 */
export function wholeFrames(durations: readonly number[], fps: number): number[] {
  let at = 0;
  let prev = 0;
  return durations.map((d) => {
    at += d;
    const frame = Math.round(at * fps);
    const k = frame - prev;
    prev = frame;
    return Math.floor((k / fps) * 1000 + 1e-6) / 1000;
  });
}
