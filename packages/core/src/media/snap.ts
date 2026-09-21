/** Word-boundary snapping for `voice: original` cuts (spec sub-project 5A §4.1). Pure: no I/O, no clock, no
 * randomness. Split out of `fit-edl.ts` to keep that file focused; the tuning constants live in `FIT` there
 * and are passed in, so this module never imports back into `fit-edl.ts`. */
import type { Transcript, Word } from "@harness/contracts";
import { EPS } from "./time.js";

export interface SnapOptions {
  /** How far from a cut point a silence edge may sit and still be used (seconds, inclusive). */
  window: number;
  /** Shortest silence between two words that counts as a place to cut (seconds, inclusive). */
  minGap: number;
  /** How far into the silence the new cut point is placed, measured from the speech side (seconds). */
  handle: number;
  /** Shortest entry worth keeping; snapping is never allowed to leave less than this (seconds). */
  minEntry: number;
}

export interface SnapResult {
  in: number;
  out: number;
  /** True when at least one of the two points actually moved. */
  snapped: boolean;
  warnings: string[];
}

type Gap = { start: number; end: number };
type Point = "in" | "out";
/** A resolved cut point: the new time, `null` for "leave it alone", `"no-gap"` for "inside speech with
 * nowhere to go" (the caller keeps it and warns). */
type Snapped = number | null | "no-gap";

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
 * Only a point that falls strictly inside a word (`word.start < t < word.end`) is moved -- a point already
 * in a silence is a clean cut and is left exactly where the editor put it. Among the silences of at least
 * `minGap` whose nearest edge is within `window` of `t`, the direction that EXPANDS the entry wins (for
 * `in` a silence at or before `t`, for `out` one at or after it). With `expandingOnly` there is no second
 * choice and the point simply stays put; otherwise a silence in the shrinking direction is used rather than
 * cutting mid-word. The new point sits `handle` into the silence from the speech side but never beyond the
 * silence's centre, so `in` and `out` can never swap sides of the same gap.
 */
function snapPoint(t: number, kind: Point, sorted: Word[], gaps: Gap[], o: SnapOptions, expandingOnly: boolean): Snapped {
  if (!sorted.some((w) => w.start < t && t < w.end)) return null;

  const qualifying = gaps.filter(
    (g) => g.end - g.start >= o.minGap - EPS && nearestEdgeDistance(g, t) <= o.window + EPS,
  );
  if (qualifying.length === 0) return "no-gap";

  const expanding = kind === "in" ? qualifying.filter((g) => g.end <= t) : qualifying.filter((g) => g.start >= t);
  if (expandingOnly && expanding.length === 0) return null;
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
  kind: Point,
  segments: Transcript["sources"][number]["segments"],
  o: SnapOptions,
  expandingOnly: boolean,
): Snapped {
  if (!segments.some((s) => s.start < t && t < s.end)) return null;
  const all = segments.map((s) => (kind === "in" ? s.start : s.end)).filter((b) => Math.abs(b - t) <= o.window + EPS);
  if (all.length === 0) return "no-gap";
  const expanding = all.filter((b) => (kind === "in" ? b <= t : b >= t));
  if (expandingOnly && expanding.length === 0) return null;
  const pool = expanding.length > 0 ? expanding : all;
  return pool.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) || (Math.abs(b - t) === Math.abs(a - t) && b < a) ? b : a));
}

/**
 * Snaps one EDL entry's `in`/`out` to speech boundaries in its own source's transcript. With no transcript
 * for that source -- or an empty one (a `word` alignment with no words, a `segment` alignment with no
 * segments) -- nothing moves and nothing is warned about: there is no speech to cut around.
 *
 * The two points are resolved together, never independently. Each one on its own prefers the silence that
 * expands the entry and only falls back to a shrinking one; but when neither point has an expanding silence
 * they can both fall back to the SAME silence lying between them, which inverts the entry and would destroy
 * a perfectly good short cut. So the shrink-allowed pair is only accepted when it leaves at least
 * `minEntry` and is not shorter than the original while a real non-shrinking snap exists; otherwise the
 * expanding-only pair is used, and failing that the editor's own points are kept with a warning.
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

  const resolve = (kind: Point, expandingOnly: boolean): Snapped => {
    const t = kind === "in" ? p.in : p.out;
    return useWords
      ? snapPoint(t, kind, sorted, gaps, p.o, expandingOnly)
      : snapToSegment(t, kind, source.segments, p.o, expandingOnly);
  };
  const resolved = {
    in: { full: resolve("in", false), expand: resolve("in", true) },
    out: { full: resolve("out", false), expand: resolve("out", true) },
  };
  const at = (kind: Point, mode: "full" | "expand"): number => {
    const v = resolved[kind][mode];
    return typeof v === "number" ? v : kind === "in" ? p.in : p.out;
  };

  for (const kind of ["in", "out"] as const) {
    if (resolved[kind].full !== "no-gap") continue;
    const t = kind === "in" ? p.in : p.out;
    warnings.push(
      `fit: entry order ${p.order} ${kind} ${t.toFixed(3)}s falls inside speech and no silence of ${p.o.minGap}s was found within +-${p.o.window}s; kept`,
    );
  }

  const full = { in: at("in", "full"), out: at("out", "full") };
  const expandOnly = { in: at("in", "expand"), out: at("out", "expand") };
  const origLength = p.out - p.in;
  const expandIsRealSnap = expandOnly.in !== p.in || expandOnly.out !== p.out;
  const tooShort = full.out - full.in < p.o.minEntry - EPS;
  const shrinks = full.out - full.in < origLength - EPS;

  const chosen = !tooShort && !(shrinks && expandIsRealSnap) ? full : expandIsRealSnap ? expandOnly : null;
  if (chosen === null) {
    warnings.push(
      `fit: entry order ${p.order} kept its original cut points: snapping to [${full.in.toFixed(3)}, ${full.out.toFixed(3)}] would have left ${(full.out - full.in).toFixed(3)}s, under the ${p.o.minEntry}s minimum`,
    );
    return result;
  }

  result.in = chosen.in;
  result.out = chosen.out;
  result.snapped = chosen.in !== p.in || chosen.out !== p.out;
  return result;
}
