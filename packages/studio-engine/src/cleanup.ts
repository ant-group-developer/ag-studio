/**
 * The Studio's own garbage, swept by the worker every few hours (`createStudioWorkerPool`):
 *
 * - Voice store lines not read for `voiceDays` (a line read again is only one farm job away).
 * - Project audio on the bucket (`library/studio/projects/<id>/voice|music/…`) nothing points at any more: not the
 *   project, not any video revision. Only past `audioGraceDays`.
 * - Scratch folders a crashed worker left: `<dataRoot>/job-runs/<job>` of jobs no longer running and
 *   `<dataRoot>/agent-runs/<message>` of turns no longer running, past `SCRATCH_HOURS`.
 * - Files people deleted from a project (`<workspace>/.trash/…`), past `workspaceDays`.
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StudioBucket } from "./bucket.js";
import type { StudioDb } from "./studio-db.js";
import { voicePath } from "./voice-store.js";

export interface RetentionConfig {
  /** Files deleted from a project (its `.trash`), by when they were deleted. */
  workspaceDays: number;
  /** Voice store lines, by their last read. */
  voiceDays: number;
  /** Project audio nothing points at, by when it was written. */
  audioGraceDays: number;
}
export const DEFAULT_RETENTION: RetentionConfig = { workspaceDays: 14, voiceDays: 90, audioGraceDays: 7 };

export interface CleanupReport { voiceLines: number; audioObjects: number; scratch: number; trash: number }

/** A scratch folder older than this whose job or turn is not running was left by a crash. */
export const SCRATCH_HOURS = 6;

const DAY_MS = 86_400_000;
const list = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return Number.POSITIVE_INFINITY; } };

/** Voice store lines last read before `cutoffIso`: the WAV and the row. */
export function sweepVoiceStore(db: StudioDb, voiceDir: string, cutoffIso: string): number {
  const old = db.all<{ key: string }>("SELECT key FROM studio_voice_lines WHERE last_used_at < ?", [cutoffIso]);
  for (const { key } of old) {
    try { unlinkSync(voicePath(voiceDir, key)); } catch { /* already gone */ }
    db.run("DELETE FROM studio_voice_lines WHERE key = ?", [key]);
  }
  return old.length;
}

/** `library:studio/…` references in a JSON text, as bucket keys (`library/studio/…`). */
function libraryKeys(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(/library:(studio\/[^"\\\s]+)/g)].map((m) => `library/${m[1]}`);
}

/** Project audio nothing points at (the project's voice and music, any video revision), written before `cutoff`. */
export async function sweepProjectAudio(db: StudioDb, bucket: StudioBucket, cutoff: Date): Promise<number> {
  const keep = new Set<string>();
  for (const r of db.all<{ voice: string | null; music: string | null }>("SELECT voice, music FROM projects")) {
    for (const k of [...libraryKeys(r.voice), ...libraryKeys(r.music)]) keep.add(k);
  }
  for (const r of db.all<{ data: string }>("SELECT data FROM video_revisions WHERE data LIKE '%library:studio/%'")) {
    for (const k of libraryKeys(r.data)) keep.add(k);
  }
  const stale = (await bucket.list("library/studio/projects/"))
    .filter((o) => !keep.has(o.key) && o.lastModified.getTime() < cutoff.getTime()).map((o) => o.key);
  if (stale.length) await bucket.deleteMany(stale);
  return stale.length;
}

/** Scratch folders of jobs and turns that are not running any more, untouched since `cutoffMs`. */
export function sweepScratch(db: StudioDb, dataRoot: string, cutoffMs: number): number {
  let removed = 0;
  const sweep = (dir: string, running: (id: string) => boolean) => {
    for (const id of list(dir)) {
      const path = join(dir, id);
      if (running(id) || mtime(path) >= cutoffMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  };
  sweep(join(dataRoot, "job-runs"), (id) => !!db.get("SELECT 1 AS x FROM project_jobs WHERE id = ? AND status IN ('queued', 'running')", [id]));
  sweep(join(dataRoot, "agent-runs"), (id) => !!db.get("SELECT 1 AS x FROM agent_messages WHERE id = ? AND status IN ('pending', 'running')", [id]));
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
    voiceLines: d.voiceDir ? sweepVoiceStore(d.db, d.voiceDir, new Date(at(r.voiceDays)).toISOString()) : 0,
    audioObjects: await sweepProjectAudio(d.db, d.bucket, new Date(at(r.audioGraceDays))),
    scratch: sweepScratch(d.db, d.dataRoot, o.now.getTime() - SCRATCH_HOURS * 3_600_000),
    trash: d.workspacesRoot ? sweepTrash(d.workspacesRoot, at(r.workspaceDays)) : 0,
  };
}
