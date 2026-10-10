/**
 * How long a job has left (spec 2026-10-10 agent-workspace §5): from its own progress once it reports some, else
 * from how long earlier jobs of the kind took per unit (seconds of video…), else a default per kind.
 */
import type { JobKind } from "./jobs-db.js";

/** Seconds per unit when there is no history yet (a unit: a second of source video, a narration line…). */
export const DEFAULT_SECONDS_PER_UNIT: Partial<Record<JobKind, number>> = {
  prepare_asset: 0.6, transcribe_upload: 0.3, tts: 4, render_preview: 1.2, render_final: 3, export_premiere: 0.5, research: 2,
};

/** Seconds left, or null when nothing sensible can be said yet. */
export function estimateSecondsLeft(o: {
  kind: JobKind; elapsedSeconds: number; progress: number | null; units: number | null; secondsPerUnit: number | null;
}): number | null {
  if (o.progress !== null && o.progress > 0.03) {
    const p = Math.min(o.progress, 0.999);
    return Math.max(0, (o.elapsedSeconds * (1 - p)) / p);
  }
  const per = o.secondsPerUnit ?? DEFAULT_SECONDS_PER_UNIT[o.kind] ?? null;
  if (per === null || !o.units || o.units <= 0) return null;
  return Math.max(0, per * o.units - o.elapsedSeconds);
}
