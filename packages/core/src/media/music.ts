/** Music track selection and plan (duck windows, loop, fade) -- sub-project 5B Task 4, spec §2.3 / §4.4.
 * Pure: no I/O, no clock. `selectTrack`'s only randomness is a deterministic hash of `request_id`, so the
 * same request always picks the same track from the same candidate set. */
import { createHash } from "node:crypto";
import type { BrandProfile, Composition, MusicTrack, Timeline } from "@harness/contracts";
import { EPS, round3 } from "./time.js";

/** Merge gap: two duck windows separated by less than this many seconds are merged into one -- spec §4.4. */
const DUCK_MERGE_GAP_SECONDS = 0.5;

/**
 * Picks a track from `tracks` (already filtered to `active` tracks the brand references -- see
 * `activeTracks`). When `mood` is given, narrows to tracks whose `mood[]` contains it (case-insensitive); an
 * empty match keeps the full candidate set and warns `music_mood_unmatched:<mood>`. The pick itself is the
 * first 4 bytes of `sha256(request_id)`, read big-endian, mod the candidate count -- stable for a given
 * `request_id` but not tied to any one track across different requests. No candidates at all (before or
 * after the mood filter) -> `track: null, reason: "no_candidates"`.
 */
export function selectTrack(p: { tracks: MusicTrack[]; mood: string | undefined; request_id: string }): { track: MusicTrack | null; reason?: "no_candidates"; warnings: string[] } {
  const { tracks, mood, request_id } = p;
  const warnings: string[] = [];
  if (tracks.length === 0) return { track: null, reason: "no_candidates", warnings };

  let candidates = tracks;
  if (mood !== undefined) {
    const moodLower = mood.toLowerCase();
    const matched = tracks.filter((t) => t.mood.some((m) => m.toLowerCase() === moodLower));
    if (matched.length > 0) {
      candidates = matched;
    } else {
      warnings.push(`music_mood_unmatched:${mood}`);
    }
  }
  if (candidates.length === 0) return { track: null, reason: "no_candidates", warnings };

  const hash = createHash("sha256").update(request_id).digest();
  const index = hash.readUInt32BE(0) % candidates.length;
  return { track: candidates[index]!, warnings };
}

/** The union of `narration[].{start,end}` (`voice: tts`) or `speech[].{start,end}` (`voice: original`),
 * merged wherever the gap between two windows is under `DUCK_MERGE_GAP_SECONDS`; `voice: none` yields no
 * windows -- spec §4.4. */
export function duckWindows(timeline: Timeline): { start: number; end: number }[] {
  const raw: { start: number; end: number }[] =
    timeline.voice === "tts" ? timeline.narration.map((n) => ({ start: n.start, end: n.end })) : timeline.voice === "original" ? timeline.speech.map((s) => ({ start: s.start, end: s.end })) : [];
  if (raw.length === 0) return [];

  const sorted = [...raw].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [{ ...sorted[0]! }];
  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (w.start - last.end < DUCK_MERGE_GAP_SECONDS + EPS) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged.map((w) => ({ start: round3(w.start), end: round3(w.end) }));
}

/**
 * Builds the `composition.json` music plan for a selected track: one cue spanning the whole programme,
 * looped (no crossfade) when the track is shorter than `total_seconds` and `loop_ok`, otherwise played once
 * (with `music_ends_early` warned when that leaves the tail silent); fixed `fade_in: 1` / `fade_out: 3`; and
 * `duck.windows` from `duckWindows` -- spec §4.4.
 */
export function buildMusicPlan(p: { track: MusicTrack; path: string; brand: BrandProfile; timeline: Timeline }): { music: NonNullable<Composition["music"]>; warnings: string[] } {
  const { track, path, brand, timeline } = p;
  const warnings: string[] = [];
  const total = timeline.total_seconds;

  const loop = track.duration_seconds < total && track.loop_ok;
  const cueEnd = loop || track.duration_seconds >= total ? total : track.duration_seconds;
  if (cueEnd < total - EPS) warnings.push("music_ends_early");

  const music: NonNullable<Composition["music"]> = {
    track_id: track.track_id,
    path,
    loop,
    fade_in: 1,
    fade_out: 3,
    cues: [{ start: 0, end: round3(cueEnd), gain_db: brand.music.gain_db }],
    duck: {
      windows: duckWindows(timeline),
      gain_db: brand.music.duck_db,
      attack_ms: brand.music.duck_attack_ms,
      release_ms: brand.music.duck_release_ms,
    },
  };
  return { music, warnings };
}
