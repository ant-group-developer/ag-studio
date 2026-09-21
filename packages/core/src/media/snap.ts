/** Word-boundary snapping for `voice: original` cuts (spec sub-project 5A §4.1). Pure: no I/O, no clock, no
 * randomness. Split out of `fit-edl.ts` to keep that file focused; the tuning constants live in `FIT` there
 * and are passed in, so this module never imports back into `fit-edl.ts`. */
import type { Transcript, Word } from "@harness/contracts";

export interface SnapOptions {
  /** How far from a cut point a silence edge may sit and still be used (seconds). */
  window: number;
  /** Shortest silence between two words that counts as a place to cut (seconds). */
  minGap: number;
  /** How far into the silence the new cut point is placed, measured from the speech side (seconds). */
  handle: number;
}

export interface SnapResult {
  in: number;
  out: number;
  /** True when at least one of the two points actually moved. */
  snapped: boolean;
  warnings: string[];
}

type Gap = { start: number; end: number };

function nearestEdgeDistance(g: Gap, t: number): number {
  return Math.min(Math.abs(g.start - t), Math.abs(g.end - t));
}

/** Silences around `words`: before the first word (from 0), between consecutive words, and after the last
 * word (to `duration`). `words` must be sorted by `start`; overlapping words are absorbed by the running
 * `prev` high-water mark so an overlap never produces a negative-length "gap". */
function gapsBetween(sorted: Word[], duration: number): Gap[] {
  const gaps: Gap[] = [];
  let prev = 0;
  for (const w of sorted) {
    if (w.start > prev) gaps.push({ start: prev, end: w.start });
    prev = Math.max(prev, w.end);
  }
  if (duration > prev) gaps.push({ start: prev, end: duration });
  return gaps;
}

/**
 * Moves one cut point to the nearest usable silence.
 *
 * Only a point that falls strictly inside a word (`word.start < t < word.end`) is moved -- a point already in
 * a silence is a clean cut and is left exactly where the editor put it. Among the silences of at least
 * `minGap` whose nearest edge is within `window` of `t`, the direction that EXPANDS the entry wins (for `in`
 * a silence at or before `t`, for `out` one at or after it); with nothing in that direction the other one is
 * used rather than cutting mid-word. The new point sits `handle` into the silence from the speech side but
 * never beyond the silence's centre, so `in` and `out` can never swap sides of the same gap.
 *
 * Returns `null` when the point should not move, or `"no-gap"` when it is inside a word but no silence
 * qualifies (the caller keeps the point and warns).
 */
function snapPoint(t: number, kind: "in" | "out", sorted: Word[], gaps: Gap[], o: SnapOptions): number | null | "no-gap" {
  if (!sorted.some((w) => w.start < t && t < w.end)) return null;

  const qualifying = gaps.filter((g) => g.end - g.start >= o.minGap && nearestEdgeDistance(g, t) <= o.window);
  if (qualifying.length === 0) return "no-gap";

  const expanding = kind === "in" ? qualifying.filter((g) => g.end <= t) : qualifying.filter((g) => g.start >= t);
  const pool = expanding.length > 0 ? expanding : qualifying;
  const best = pool.reduce((a, b) => {
    const da = nearestEdgeDistance(a, t);
    const db = nearestEdgeDistance(b, t);
    return db < da || (db === da && b.start < a.start) ? b : a;
  });

  const centre = (best.start + best.end) / 2;
  return kind === "in" ? Math.max(best.end - o.handle, centre) : Math.min(best.start + o.handle, centre);
}

/** The `alignment: "segment"` fallback: no words to cut between, so a point inside a segment goes to the
 * nearest segment `start` (for `in`) / `end` (for `out`) within `window`. */
function snapToSegment(
  t: number,
  kind: "in" | "out",
  segments: Transcript["sources"][number]["segments"],
  o: SnapOptions,
): number | null | "no-gap" {
  if (!segments.some((s) => s.start < t && t < s.end)) return null;
  const boundaries = segments.map((s) => (kind === "in" ? s.start : s.end)).filter((b) => Math.abs(b - t) <= o.window);
  if (boundaries.length === 0) return "no-gap";
  return boundaries.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) || (Math.abs(b - t) === Math.abs(a - t) && b < a) ? b : a));
}

/**
 * Snaps one EDL entry's `in`/`out` to speech boundaries in its own source's transcript. With no transcript
 * for that source -- or an empty one (a `word` alignment with no words, a `segment` alignment with no
 * segments) -- nothing moves and nothing is warned about: there is no speech to cut around.
 */
export function snapEntry(p: {
  order: number;
  in: number;
  out: number;
  source: Transcript["sources"][number] | undefined;
  sourceDuration: number;
  o: SnapOptions;
}): SnapResult {
  const warnings: string[] = [];
  const result: SnapResult = { in: p.in, out: p.out, snapped: false, warnings };
  const source = p.source;
  if (!source) return result;

  const sorted = source.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start || a.end - b.end);
  const useWords = source.alignment === "word";
  if (useWords ? sorted.length === 0 : source.segments.length === 0) return result;
  const gaps = useWords ? gapsBetween(sorted, p.sourceDuration) : [];

  for (const kind of ["in", "out"] as const) {
    const t = kind === "in" ? p.in : p.out;
    const moved = useWords ? snapPoint(t, kind, sorted, gaps, p.o) : snapToSegment(t, kind, source.segments, p.o);
    if (moved === null) continue;
    if (moved === "no-gap") {
      warnings.push(
        `fit: entry order ${p.order} ${kind} ${t.toFixed(3)}s falls inside speech and no silence of ${p.o.minGap}s was found within +-${p.o.window}s; kept`,
      );
      continue;
    }
    if (moved !== t) {
      result[kind] = moved;
      result.snapped = true;
    }
  }
  return result;
}
