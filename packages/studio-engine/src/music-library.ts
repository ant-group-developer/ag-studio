/**
 * The team's music library (plan 2026-10-08 task 29): background tracks a Studio admin uploads once, tagged by mood,
 * that any production may use. A shot-cut episode whose production has no music of its own gets one picked by mood
 * when its cut is fitted (cut 1.1.0); the person reviewing the timeline can change it.
 *
 * The tracks are rows of the harness `music_track` table (same `studio.db`), their files AAC under `library/music/`
 * on the bucket — outside the per-production audio the cleanup sweep removes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicTrackSchema, type MusicTrack, type StudioMusic } from "@harness/contracts";
import { selectTrack } from "@harness/core";
import { MUSIC_DEFAULTS, prepareMusic, sha256Of, type AudioImportDeps } from "./audio-import.js";
import type { StudioDb } from "./studio-db.js";

export const LIBRARY_MUSIC_ORIGINS = ["own", "licensed", "royalty_free"] as const;
export type LibraryMusicOrigin = (typeof LIBRARY_MUSIC_ORIGINS)[number];

export function listLibraryMusic(db: StudioDb, o: { activeOnly?: boolean } = {}): MusicTrack[] {
  const rows = o.activeOnly
    ? db.all<{ data: string }>("SELECT data FROM music_track WHERE active = 1 ORDER BY rowid")
    : db.all<{ data: string }>("SELECT data FROM music_track ORDER BY rowid");
  return rows.map((r) => MusicTrackSchema.parse(JSON.parse(r.data)));
}

export function getLibraryMusic(db: StudioDb, trackId: string): MusicTrack | null {
  const r = db.get<{ data: string }>("SELECT data FROM music_track WHERE id = ?", [trackId]);
  return r ? MusicTrackSchema.parse(JSON.parse(r.data)) : null;
}

/** Same row as the harness store writes (`upsertMusicTrack`). */
export function saveLibraryMusic(db: StudioDb, t: MusicTrack): void {
  const v = MusicTrackSchema.parse(t);
  db.run(
    "INSERT INTO music_track (id, data, active, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET data = excluded.data, active = excluded.active, updated_at = excluded.updated_at",
    [v.track_id, JSON.stringify(v), v.active ? 1 : 0, v.updated_at],
  );
}

/** Lower case, no Vietnamese marks, single spaces: "Ấm áp" and "am ap" are one mood. */
export function foldMood(mood: string): string {
  return mood.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A file a Studio admin uploads: checked and made AAC as a production's music is, kept by its content under
 * `library/music/`, recorded with its moods, where it came from and whether it loops cleanly. The same file twice is
 * one track (its id comes from the content): uploading it again updates its name, moods and origin.
 */
export async function importLibraryMusic(d: AudioImportDeps, o: {
  file: string; displayName: string; moods: string[]; origin: LibraryMusicOrigin; originNote: string; loopOk: boolean; now: string;
}): Promise<MusicTrack> {
  const work = mkdtempSync(join(tmpdir(), "studio-music-"));
  try {
    const out = join(work, "music.m4a");
    const { duration_s } = await prepareMusic(d, o.file, out);
    const sha = await sha256Of(out);
    const key = `library/music/${sha}.m4a`;
    await d.bucket.putFile(key, out, "audio/mp4");
    const trackId = `m-${sha.slice(0, 16)}`;
    const before = getLibraryMusic(d.db, trackId);
    const moods = [...new Set(o.moods.map((m) => m.trim()).filter(Boolean))];
    const track = MusicTrackSchema.parse({
      schema_version: "harness.music-track/v1", track_id: trackId, display_name: o.displayName.trim(), file: `library:music/${sha}.m4a`,
      mood: moods, duration_seconds: duration_s, loop_ok: o.loopOk, origin: o.origin, origin_note: o.originNote.trim(),
      checksum: `sha256:${sha}`, active: true, created_at: before?.created_at ?? o.now, updated_at: o.now,
    });
    saveLibraryMusic(d.db, track);
    return track;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The library track for an episode with no music of its own: the first of `moods` (the edit plan's, then the
 * branding's, then the style's) that some active track is tagged with, compared without case or marks; among those,
 * tracks long enough for the episode or that loop cleanly first, then one picked by `seed` (the same episode always
 * gets the same track). No mood matches: none (the reviewer may still pick one).
 */
export function pickLibraryMusic(
  tracks: readonly MusicTrack[], moods: readonly (string | null | undefined)[], o: { seed: string; seconds: number },
): { track: MusicTrack; mood: string; music: StudioMusic } | null {
  const active = tracks.filter((t) => t.active);
  for (const mood of moods) {
    if (!mood?.trim()) continue;
    const want = foldMood(mood);
    const tagged = active.filter((t) => t.mood.some((m) => foldMood(m) === want));
    if (!tagged.length) continue;
    const fits = tagged.filter((t) => t.loop_ok || t.duration_seconds >= o.seconds);
    const { track } = selectTrack({ tracks: fits.length ? fits : tagged, mood: undefined, request_id: o.seed });
    if (!track) continue;
    return { track, mood, music: { track: track.file, gain_db: MUSIC_DEFAULTS.gain_db, ducking: MUSIC_DEFAULTS.ducking } };
  }
  return null;
}
