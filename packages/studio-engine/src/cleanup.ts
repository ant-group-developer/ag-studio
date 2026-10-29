/**
 * The Studio's own garbage, swept by the worker every few hours (`createStudioWorkerPool`):
 *
 * - Voice store lines not read for `voiceDays` (a line read again is only one farm job away).
 * - Project audio on the bucket (`library/studio/projects/<id>/voice|music/…`) nothing points at any more: not the
 *   project, not a video's own music, not any video revision (a track's beats go with it); and uploaded footage
 *   (`…/footage/…`) no source holds (removed, or an upload never finished). Only past `audioGraceDays`.
 * - Media library files (`library/studio/users/<owner>/media/…`, plan 2026-10-29) of items deleted more than
 *   `audioGraceDays` ago that no project uses, with their rows, and uploads that never became an item.
 * - Files a browser uploaded to the bucket (`uploads/…`) Studio never took, past `RAW_UPLOAD_HOURS`.
 * - Scratch folders a crashed worker left: `<dataRoot>/job-runs/<job>` of jobs no longer running and
 *   `<dataRoot>/agent-runs/<message>` of turns no longer running, past `SCRATCH_HOURS`.
 * - Files people deleted from a project (`<workspace>/.trash/…`), past `workspaceDays`.
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RAW_UPLOADS_PREFIX, type StudioBucket } from "./bucket.js";
import type { StudioDb } from "./studio-db.js";
import { voicePath } from "./voice-store.js";
import { sweepAuditLog } from "./audit-log.js";
import { BEATS_SUFFIX } from "./workspace/music-beats.js";

export interface RetentionConfig {
  /** Files deleted from a project (its `.trash`), by when they were deleted. */
  workspaceDays: number;
  /** Voice store lines, by their last read. */
  voiceDays: number;
  /** Project audio nothing points at, by when it was written. */
  audioGraceDays: number;
  /** Rows of the activity log, by when they happened. */
  auditDays: number;
}
export const DEFAULT_RETENTION: RetentionConfig = { workspaceDays: 14, voiceDays: 90, audioGraceDays: 7, auditDays: 90 };

export interface CleanupReport { voiceLines: number; audioObjects: number; mediaObjects: number; rawUploads: number; scratch: number; trash: number; auditRows: number }

/** A scratch folder older than this whose job or turn is not running was left by a crash. */
export const SCRATCH_HOURS = 6;
/** A browser's upload Studio has not taken within this was abandoned (a signed PUT link lives an hour). */
export const RAW_UPLOAD_HOURS = 24;

const DAY_MS = 86_400_000;
const list = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return Number.POSITIVE_INFINITY; } };

/** Voice store lines last read before `cutoffIso`: the WAV and the row. */
export async function sweepVoiceStore(db: StudioDb, voiceDir: string, cutoffIso: string): Promise<number> {
  // the rows go first, only those still unread since the cutoff (a line read meanwhile stays)
  const old = await db.all<{ key: string }>("DELETE FROM studio_voice_lines WHERE last_used_at < ? RETURNING key", [cutoffIso]);
  for (const { key } of old) {
    try { unlinkSync(voicePath(voiceDir, key)); } catch { /* already gone */ }
  }
  return old.length;
}

/** `library:studio/…` references in a JSON text (jsonb read as text), as bucket keys (`library/studio/…`). */
function libraryKeys(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(/library:(studio\/[^"\\\s]+)/g)].map((m) => `library/${m[1]}`);
}

/** Project audio nothing points at (the project's voice and music, a video's music, any video revision), written before `cutoff`. */
export async function sweepProjectAudio(db: StudioDb, bucket: StudioBucket, cutoff: Date): Promise<number> {
  const keep = new Set<string>();
  for (const r of await db.all<{ voice: string | null; music: string | null }>("SELECT voice::text AS voice, music::text AS music FROM projects")) {
    for (const k of [...libraryKeys(r.voice), ...libraryKeys(r.music)]) keep.add(k);
  }
  for (const r of await db.all<{ data: string }>("SELECT data::text AS data FROM video_revisions WHERE data::text LIKE '%library:studio/%'")) {
    for (const k of libraryKeys(r.data)) keep.add(k);
  }
  for (const r of await db.all<{ music: string }>("SELECT music::text AS music FROM videos WHERE music IS NOT NULL")) {
    for (const k of libraryKeys(r.music)) keep.add(k);
  }
  // uploaded footage and a photo's clip, while a source holds them (`footage-upload.ts`)
  for (const r of await db.all<{ key: string | null; clip_key: string | null }>(
    "SELECT meta->>'key' AS key, meta->>'clip_key' AS clip_key FROM project_sources WHERE kind = 'upload_asset'",
  )) {
    for (const k of [r.key, r.clip_key]) if (k) keep.add(k);
  }
  // a track's beats (`<key>.beats.json`) go with it
  const kept = (key: string) => keep.has(key) || (key.endsWith(BEATS_SUFFIX) && keep.has(key.slice(0, -BEATS_SUFFIX.length)));
  const stale = (await bucket.list("library/studio/projects/"))
    .filter((o) => !kept(o.key) && o.lastModified.getTime() < cutoff.getTime()).map((o) => o.key);
  if (stale.length) await bucket.deleteMany(stale);
  return stale.length;
}

/**
 * Media library files nobody keeps: an item deleted before `cutoff` that no source uses goes (its file, its photo
 * clip and its row); a file under the library no item names (the upload was not finished), written before `cutoff`.
 */
export async function sweepMediaLibrary(db: StudioDb, bucket: StudioBucket, cutoff: Date): Promise<number> {
  const items = await db.all<{ id: string; key: string; clip_key: string | null; deleted_at: string | null; used: boolean }>(
    `SELECT m.id, m.key, m.clip_key, m.deleted_at, EXISTS (SELECT 1 FROM project_sources s WHERE s.media_id = m.id) AS used FROM media_items m`,
  );
  const gone = items.filter((m) => m.deleted_at && !m.used && new Date(m.deleted_at).getTime() < cutoff.getTime());
  const goneIds = new Set(gone.map((m) => m.id));
  const keep = new Set<string>();
  for (const m of items) if (!goneIds.has(m.id)) for (const k of [m.key, m.clip_key]) if (k) keep.add(k);
  for (const r of await db.all<{ key: string | null; clip_key: string | null }>(
    "SELECT meta->>'key' AS key, meta->>'clip_key' AS clip_key FROM project_sources WHERE media_id IS NOT NULL",
  )) for (const k of [r.key, r.clip_key]) if (k) keep.add(k);
  const stale = (await bucket.list("library/studio/users/"))
    .filter((o) => !keep.has(o.key) && o.lastModified.getTime() < cutoff.getTime()).map((o) => o.key);
  // footage uploaded before the library keeps its project key (scripts/migrate-media-library.mjs): gone with its item
  for (const m of gone) for (const k of [m.key, m.clip_key]) if (k && !k.startsWith("library/studio/users/") && !keep.has(k)) stale.push(k);
  if (stale.length) await bucket.deleteMany(stale);
  for (const m of gone) await db.run("DELETE FROM media_items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM project_sources WHERE media_id = ?)", [m.id, m.id]);
  return stale.length;
}

/** Files a browser put on the bucket that Studio never took (the upload was not finished), written before `cutoff`. */
export async function sweepRawUploads(bucket: StudioBucket, cutoff: Date): Promise<number> {
  const stale = (await bucket.list(RAW_UPLOADS_PREFIX)).filter((o) => o.lastModified.getTime() < cutoff.getTime()).map((o) => o.key);
  if (stale.length) await bucket.deleteMany(stale);
  return stale.length;
}

/** Scratch folders of jobs and turns that are not running any more, untouched since `cutoffMs`. */
export async function sweepScratch(db: StudioDb, dataRoot: string, cutoffMs: number): Promise<number> {
  let removed = 0;
  const sweep = async (dir: string, running: (id: string) => Promise<boolean>) => {
    for (const id of list(dir)) {
      const path = join(dir, id);
      if (mtime(path) >= cutoffMs || await running(id)) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  };
  await sweep(join(dataRoot, "job-runs"), async (id) => !!await db.get("SELECT 1 AS x FROM project_jobs WHERE id = ? AND status IN ('queued', 'running')", [id]));
  await sweep(join(dataRoot, "agent-runs"), async (id) => !!await db.get("SELECT 1 AS x FROM agent_messages WHERE id = ? AND status IN ('pending', 'running')", [id]));
  return removed;
}

/** Entries of every project's `.trash` deleted before `cutoffMs`. */
export function sweepTrash(workspacesRoot: string, cutoffMs: number): number {
  let removed = 0;
  for (const project of list(workspacesRoot)) {
    const trash = join(workspacesRoot, project, ".trash");
    if (!existsSync(trash)) continue;
    for (const entry of list(trash)) {
      const path = join(trash, entry);
      if (mtime(path) >= cutoffMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** One sweep of everything above. */
export async function sweepStudioData(
  d: { db: StudioDb; bucket: StudioBucket; dataRoot: string; workspacesRoot?: string | undefined; voiceDir?: string | undefined },
  o: { now: Date; retention?: Partial<RetentionConfig> },
): Promise<CleanupReport> {
  const r = { ...DEFAULT_RETENTION, ...o.retention };
  const at = (days: number) => o.now.getTime() - days * DAY_MS;
  return {
    voiceLines: d.voiceDir ? await sweepVoiceStore(d.db, d.voiceDir, new Date(at(r.voiceDays)).toISOString()) : 0,
    audioObjects: await sweepProjectAudio(d.db, d.bucket, new Date(at(r.audioGraceDays))),
    mediaObjects: await sweepMediaLibrary(d.db, d.bucket, new Date(at(r.audioGraceDays))),
    rawUploads: await sweepRawUploads(d.bucket, new Date(o.now.getTime() - RAW_UPLOAD_HOURS * 3_600_000)),
    scratch: await sweepScratch(d.db, d.dataRoot, o.now.getTime() - SCRATCH_HOURS * 3_600_000),
    trash: d.workspacesRoot ? sweepTrash(d.workspacesRoot, at(r.workspaceDays)) : 0,
    auditRows: await sweepAuditLog(d.db, new Date(at(r.auditDays)).toISOString()),
  };
}
