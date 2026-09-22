import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { HarnessError, MusicTrackSchema, type Clock, type MediaProber, type MusicTrack, type StateStore } from "@harness/contracts";
import type { LibraryFs } from "./files.js";

/** Reads a music track straight from the kho (not the DB mirror): an absent file means "no such track_id
 * yet" (used by `addMusicTrack` to reject a re-used id, and by `retireMusicTrack` to look one up). */
function readTrackOrUndefined(fs: LibraryFs, trackId: string): MusicTrack | undefined {
  const path = fs.paths.trackFile(trackId);
  if (!existsSync(path)) return undefined;
  return fs.readJson(path, MusicTrackSchema);
}

/**
 * Adds a new channel-owned background music track to the kho. Unlike a voice profile, a track is immutable
 * once added -- `track_id` colliding with an existing track is rejected outright (spec §2.2: "muốn đổi thì id
 * mới"), never bumped.
 *
 * Order matters: the source file's existence, then the `track_id` collision, are both checked before the
 * (comparatively expensive) media probe runs, and the probe result (must have an audio stream, duration > 5s)
 * is checked before anything is copied into the kho -- same ordering discipline as `addVoice`.
 */
export async function addMusicTrack(
  d: { fs: LibraryFs; store: StateStore; clock: Clock; prober: MediaProber },
  p: {
    track_id: string;
    display_name: string;
    file_path: string;
    mood: string[];
    origin: MusicTrack["origin"];
    origin_note: string;
    loop_ok?: boolean;
  },
): Promise<MusicTrack> {
  if (!existsSync(p.file_path)) {
    throw new HarnessError("CONFIG_INVALID", `music source file not found: ${p.file_path}`, { file_path: p.file_path });
  }
  if (readTrackOrUndefined(d.fs, p.track_id)) {
    throw new HarnessError("CONFIG_INVALID", `music track already exists: ${p.track_id} (tracks are immutable; add a new track_id instead)`, { track_id: p.track_id });
  }

  const probe = await d.prober.probe(p.file_path);
  if (!probe || !probe.audio) {
    throw new HarnessError("CONFIG_INVALID", `music source has no audio stream: ${p.file_path}`, { file_path: p.file_path });
  }
  const duration = probe.duration_seconds;
  if (duration === null || duration <= 5) {
    throw new HarnessError("CONFIG_INVALID", `music track must be longer than 5 seconds, got ${duration ?? "unknown"}`, { file_path: p.file_path, duration_seconds: duration });
  }

  const ext = extname(p.file_path).toLowerCase().replace(/^\./, "");
  const dest = join(d.fs.paths.trackDir(p.track_id), `track.${ext}`);
  const file = await d.fs.copyFileWithChecksum(p.file_path, dest);
  const now = d.clock.now();

  const track: MusicTrack = MusicTrackSchema.parse({
    schema_version: "harness.music-track/v1",
    track_id: p.track_id,
    display_name: p.display_name,
    file: file.path,
    mood: p.mood,
    duration_seconds: duration,
    loop_ok: p.loop_ok ?? false,
    origin: p.origin,
    origin_note: p.origin_note,
    checksum: file.checksum,
    active: true,
    created_at: now,
    updated_at: now,
  });

  d.fs.writeJsonAtomic(d.fs.paths.trackFile(p.track_id), track);
  d.store.upsertMusicTrack(track);
  return track;
}

/** active -> retired (studio may never call this: `writeJsonAtomic` refuses a studio role's write under
 * `music/**` before anything is touched). The file itself is never removed (spec §2.2: "file giữ") -- older
 * items in the kho that already reference this track keep working. Idempotent on an already-retired track;
 * NOT_FOUND for a track_id that was never added. */
export function retireMusicTrack(d: { fs: LibraryFs; store: StateStore; clock: Clock }, trackId: string): MusicTrack {
  const track = readTrackOrUndefined(d.fs, trackId);
  if (!track) throw new HarnessError("NOT_FOUND", `music track not found: ${trackId}`, { track_id: trackId });
  if (!track.active) return track;
  const updated: MusicTrack = { ...track, active: false, updated_at: d.clock.now() };
  d.fs.writeJsonAtomic(d.fs.paths.trackFile(trackId), updated);
  d.store.upsertMusicTrack(updated);
  return updated;
}

/** Resolves a brand's `music.tracks` id list (spec §2.3's candidate pool) against the DB mirror, in the same
 * order as `ids`, keeping only tracks that are still `active` and dropping any id with no mirrored track at
 * all (a track retired, or never synced). Reads the store, not the kho, for the same reason
 * `requireActiveVoice` does: the caller (studio, at `media-compose` time) may not have direct kho read access
 * to another channel's `music/<id>/track.json`, but `syncLibrary` keeps the mirror current for both roles. */
export function activeTracks(store: StateStore, ids: string[]): MusicTrack[] {
  const out: MusicTrack[] = [];
  for (const id of ids) {
    const track = store.getMusicTrack(id);
    if (track && track.active) out.push(track);
  }
  return out;
}
