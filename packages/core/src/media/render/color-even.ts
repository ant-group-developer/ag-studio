/** Even colour (item 6 of the 2026-10-27 feedback, `composition.color_even`): footage shot on different cameras or at
 * different hours cuts together with jumps in brightness and white balance. Each segment's picture is measured once
 * (`signalstats` over its mezzanine body, kept in the mezzanine's cache sidecar) and brought part of the way to the
 * median of the segments: its luma spread and level, and its colour cast. Mild on purpose, like `even.ts` for the
 * sound: a night street is not lit up to match a beach at noon, only the gap between them narrows. Pure: the measuring
 * pass is run by `run.ts`. */
import { round3 } from "../time.js";

/** What one segment's picture measures: the averages over its sampled frames, in 8-bit YUV (limited range). */
export interface ColorStats {
  /** Mean luma. */
  y: number;
  /** Luma 10th and 90th percentiles (`YLOW`, `YHIGH`): the spread the contrast is matched on. */
  low: number;
  high: number;
  /** Mean chroma: 128 is neutral; away from it is the cast (white balance). */
  u: number;
  v: number;
}

/** The correction of one segment: luma `y * gain + offset`, chroma shifted by `u`/`v`. */
export interface ColorFix {
  gain: number;
  offset: number;
  u: number;
  v: number;
}

/** How far toward the median a segment moves (1 = all the way). */
export const COLOR_MATCH_STRENGTH = 0.7;
/** The contrast gain, the luma offset (8-bit steps) and the chroma shift a segment takes at most. */
export const COLOR_MAX_GAIN = 0.15;
export const COLOR_MAX_OFFSET = 18;
export const COLOR_MAX_CHROMA = 6;
/** A segment whose luma spreads less than this (a black card, a fade, fog) is neither measured into the median nor matched. */
const FLAT_SPREAD = 20;
/** Frames sampled per second of a segment, and the width they are measured at. */
const SAMPLE_FPS = 2;
const SAMPLE_WIDTH = 160;

/** ffmpeg argv that prints a file's per-frame picture stats (`signalstats` through `metadata=print`, on stderr). */
export function signalstatsArgs(ffmpeg: string, path: string): string[] {
  return [
    ffmpeg, "-hide_banner", "-nostats", "-i", path, "-map", "0:v:0",
    "-vf", `fps=${SAMPLE_FPS},scale=${SAMPLE_WIDTH}:-2,format=yuv420p,signalstats,metadata=mode=print`, "-f", "null", "-",
  ];
}

const KEYS = { YAVG: "y", YLOW: "low", YHIGH: "high", UAVG: "u", VAVG: "v" } as const;

/** The averages of `signalstats` over the printed frames, or null when no frame was printed. */
export function parseSignalstats(stderr: string): ColorStats | null {
  const sum = { y: 0, low: 0, high: 0, u: 0, v: 0 };
  const count = { y: 0, low: 0, high: 0, u: 0, v: 0 };
  for (const m of stderr.matchAll(/lavfi\.signalstats\.(YAVG|YLOW|YHIGH|UAVG|VAVG)=(-?\d+(?:\.\d+)?)/g)) {
    const k = KEYS[m[1] as keyof typeof KEYS];
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    sum[k] += n;
    count[k] += 1;
  }
  if (Object.values(count).some((c) => c === 0)) return null;
  return {
    y: round3(sum.y / count.y), low: round3(sum.low / count.low), high: round3(sum.high / count.high),
    u: round3(sum.u / count.u), v: round3(sum.v / count.v),
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const clamp = (x: number, max: number) => Math.max(-max, Math.min(max, x));

/**
 * The correction that brings each segment part of the way (`COLOR_MATCH_STRENGTH`) to the median of the measured ones,
 * within the limits above; null for a segment that was not measured, is flat, or would change by less than can be seen.
 * Fewer than two measured segments leave every segment as it is.
 */
export function colorFixes(stats: readonly (ColorStats | null)[]): (ColorFix | null)[] {
  const usable = (s: ColorStats | null): s is ColorStats => s !== null && s.high - s.low >= FLAT_SPREAD;
  const measured = stats.filter(usable);
  if (measured.length < 2) return stats.map(() => null);
  const target = {
    spread: median(measured.map((s) => s.high - s.low)), y: median(measured.map((s) => s.y)),
    u: median(measured.map((s) => s.u)), v: median(measured.map((s) => s.v)),
  };
  return stats.map((s) => {
    if (!usable(s)) return null;
    const k = COLOR_MATCH_STRENGTH;
    const gain = 1 + clamp((target.spread / (s.high - s.low) - 1) * k, COLOR_MAX_GAIN);
    // the mean lands where it should after the gain: y' = y * gain + offset
    const offset = clamp((s.y + (target.y - s.y) * k) - s.y * gain, COLOR_MAX_OFFSET);
    const u = clamp((target.u - s.u) * k, COLOR_MAX_CHROMA);
    const v = clamp((target.v - s.v) * k, COLOR_MAX_CHROMA);
    // what the correction does to the mean, the spread and the cast: under ~1.5 steps of 8-bit nobody sees it
    const moved = Math.max(Math.abs(s.y * (gain - 1) + offset), Math.abs((gain - 1) * (s.high - s.low)), Math.abs(u), Math.abs(v));
    if (moved < 1.5) return null;
    return { gain: round3(gain), offset: round3(offset), u: round3(u), v: round3(v) };
  });
}

const num = (x: number) => String(Number(x.toFixed(3)));
const plus = (x: number) => (x < 0 ? `-${num(-x)}` : `+${num(x)}`);

/** The `lutyuv` filter of a correction (on 8-bit YUV, as every mezzanine is). */
export function colorFixFilter(f: ColorFix): string {
  return `lutyuv=y='clip(val*${num(f.gain)}${plus(f.offset)},minval,maxval)':u='clip(val${plus(f.u)},minval,maxval)':v='clip(val${plus(f.v)},minval,maxval)'`;
}
