/** Pure shot-building from raw scene-cut times (spec sub-project 5A §1.2). No ffmpeg, no I/O: `index.ts`
 * feeds it `detectSceneChanges` output, but any caller can hand it a plain `number[]` of cut times. */
import { HarnessError } from "@harness/contracts";

const MAX_SHOT_ID_INDEX = 999;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Turns raw scene-cut times into one source's shot list.
 *
 * Boundaries = `[0, ...cuts strictly inside (0, duration) sorted ascending, duration]`, which produces the
 * initial (unmerged, unsplit) shots. Then:
 * - a shot shorter than `min_shot_seconds` merges into the *previous* shot; the very first shot has no
 *   previous, so it merges *forward* into the next one instead (possibly repeatedly, if that next shot is
 *   itself still short once combined -- this only ever chases forward, never backward, so it terminates).
 * - a shot longer than `max_shot_seconds` splits evenly into `ceil(length / max_shot_seconds)` equal parts
 *   (this happens after merging, so a long run of merged-forward short shots gets split back down too).
 *
 * All returned `in`/`out` values are rounded to 3 decimal places. `duration <= 0` (nothing to shoot) returns
 * `[]` without looking at `cuts`.
 */
export function buildShots(
  cuts: number[],
  duration: number,
  o: { min_shot_seconds: number; max_shot_seconds: number },
): { in: number; out: number }[] {
  if (duration <= 0) return [];

  const inRange = cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const boundaries = [0, ...inRange, duration];

  const initial: { in: number; out: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    initial.push({ in: boundaries[i]!, out: boundaries[i + 1]! });
  }

  // Merge shots shorter than min_shot_seconds into the previous shot -- or, for the first shot (no previous),
  // forward into the next one; `initial[i + 1]` is mutated in place so a chain of short shots at the head
  // collapses correctly as the loop advances into it.
  const merged: { in: number; out: number }[] = [];
  for (let i = 0; i < initial.length; i++) {
    const s = initial[i]!;
    const length = s.out - s.in;
    if (length < o.min_shot_seconds) {
      if (merged.length === 0) {
        if (i + 1 < initial.length) {
          initial[i + 1] = { in: s.in, out: initial[i + 1]!.out };
          continue;
        }
        merged.push(s); // the only shot there is: nothing to merge into either direction
      } else {
        merged[merged.length - 1] = { in: merged[merged.length - 1]!.in, out: s.out };
      }
    } else {
      merged.push(s);
    }
  }

  // Split shots longer than max_shot_seconds into ceil(length / max) equal parts.
  const out: { in: number; out: number }[] = [];
  for (const s of merged) {
    const length = s.out - s.in;
    if (length > o.max_shot_seconds) {
      const parts = Math.ceil(length / o.max_shot_seconds);
      const partLen = length / parts;
      for (let i = 0; i < parts; i++) {
        const partIn = s.in + i * partLen;
        const partOut = i === parts - 1 ? s.out : s.in + (i + 1) * partLen;
        out.push({ in: round3(partIn), out: round3(partOut) });
      }
    } else {
      out.push({ in: round3(s.in), out: round3(s.out) });
    }
  }
  return out;
}

/** `shot_id` for a source's Nth shot: `s<sourceIndex:3>-<shotIndex:3>`, matching `ShotsIndexSchema`'s
 * `/^s\d{3}-\d{3}$/`. That regex only ever allows 3 digits per half, so an index above 999 (a source-item
 * count or a shot-per-source count nobody expects to hit in practice) would silently produce an id the
 * schema then rejects far from here -- caught immediately instead, with a clear reason. */
export function shotId(sourceIndex: number, shotIndex: number): string {
  if (sourceIndex > MAX_SHOT_ID_INDEX || shotIndex > MAX_SHOT_ID_INDEX) {
    throw new HarnessError("CONFIG_INVALID", `shotId: index exceeds ${MAX_SHOT_ID_INDEX} (sourceIndex=${sourceIndex}, shotIndex=${shotIndex})`, { sourceIndex, shotIndex });
  }
  const pad = (n: number) => String(n).padStart(3, "0");
  return `s${pad(sourceIndex)}-${pad(shotIndex)}`;
}
