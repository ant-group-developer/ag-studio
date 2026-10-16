/** Even source sound (feedback-vps §4.3, `composition.source_even`): each segment's own sound is measured once (`ebur128`
 * over its mezzanine body, kept in the mezzanine's cache sidecar) and brought to the median of the segments, by at most
 * `EVEN_MAX_DB` either way. A quiet interview next to a loud street no longer jumps by 15 dB at the cut. Pure: the
 * measuring pass is run by `run.ts`. */
import { round3 } from "../time.js";

/** The most a segment is raised or lowered to meet the others. */
export const EVEN_MAX_DB = 12;
/** ebur128's integrated loudness of silence (its absolute gate): a segment this quiet has nothing to bring up. */
const SILENT_LUFS = -69.9;

/** ffmpeg argv that prints a file's integrated loudness (`ebur128` summary on stderr, nothing written). */
export function ebur128Args(ffmpeg: string, path: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"];
}

/** The integrated loudness from `ebur128`'s summary, or null when the sound is silent or the summary is missing. */
export function parseEbur128Integrated(stderr: string): number | null {
  const summary = stderr.lastIndexOf("Summary:");
  if (summary < 0) return null;
  const m = /I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(stderr.slice(summary));
  if (!m) return null;
  const lufs = Number(m[1]);
  return Number.isFinite(lufs) && lufs > SILENT_LUFS ? lufs : null;
}

/** The median of the measured segments. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The gain (dB) that brings each segment to the median loudness of the measured ones, within ±`EVEN_MAX_DB`; 0 for a
 * segment that is silent or was not measured (`null`).
 */
export function evenGains(lufs: readonly (number | null)[]): number[] {
  const measured = lufs.filter((l): l is number => l !== null);
  if (measured.length === 0) return lufs.map(() => 0);
  const target = median(measured);
  return lufs.map((l) => (l === null ? 0 : round3(Math.max(-EVEN_MAX_DB, Math.min(EVEN_MAX_DB, target - l)))));
}
