/**
 * The Studio's own garbage (deferred-items, "Kho giọng và file theo run không dọn", "Session Claude không dọn"): what
 * runs, chats and audio changes leave behind, swept by the worker every few hours (`createStudioWorkerPool`).
 *
 * - Workspaces of ended runs (720p proxies, frames, contact sheets, a Claude session's files), past
 *   `workspaceDays`. A run still open keeps its workspaces, so its gates still chat with the stage that wrote them.
 * - `studio_agent_sessions` rows whose workspace is gone (the chat already falls back to structured then).
 * - Voice store lines not read for `voiceDays` (a line read again is only one farm job away).
 * - Production audio on the bucket (`library/studio/<production>/voice|music/…`) nothing points at any more: not the
 *   production, not any episode revision. Only past `audioGraceDays`, and never while the production has a run open
 *   (a brief may have frozen the old music).
 * - Shot frames (`productions/<p>/episodes/<e>/shots/…`) of episodes that no longer exist (a series plan replaced them).
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isTerminal } from "@harness/core";
import type { StudioBucket } from "./bucket.js";
import type { StudioEngineCore } from "./core.js";
import type { StudioDb } from "./studio-db.js";
import { voicePath } from "./voice-store.js";

export interface RetentionConfig {
  /** Workspaces of ended runs, by their last change. */
  workspaceDays: number;
  /** Voice store lines, by their last read. */
  voiceDays: number;
  /** Production audio nothing points at, by when it was written. */
  audioGraceDays: number;
}
export const DEFAULT_RETENTION: RetentionConfig = { workspaceDays: 14, voiceDays: 90, audioGraceDays: 7 };

export interface CleanupReport { workspaces: number; sessions: number; voiceLines: number; audioObjects: number; shotFrames: number }

const DAY_MS = 86_400_000;
const list = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

/**
 * Removes `<root>/<run>/…` of every run that ended (`stateOf` is a terminal state) and has not changed since
 * `cutoffMs`. A directory whose run is unknown is left alone.
 */
export function sweepWorkspaces(root: string, cutoffMs: number, stateOf: (runId: string) => string | null): number {
  let removed = 0;
  for (const run of list(root)) {
    const state = stateOf(run);
    if (!state || !isTerminal("run", state)) continue;
    const dir = join(root, run);
    if (newestChange(dir) >= cutoffMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** The latest mtime of a run directory and its stage and attempt directories (a resumed run adds attempts). */
function newestChange(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const stage of list(dir)) {
    const s = join(dir, stage);
    t = Math.max(t, statSync(s).mtimeMs);
    for (const attempt of list(s)) t = Math.max(t, statSync(join(s, attempt)).mtimeMs);
  }
  return t;
}

/** Agent sessions whose workspace is gone: nothing can resume them. */
export function sweepAgentSessions(db: StudioDb): number {
  const gone = db.all<{ run_id: string; stage_key: string; cwd: string }>("SELECT run_id, stage_key, cwd FROM studio_agent_sessions")
    .filter((r) => !existsSync(r.cwd));
  for (const r of gone) db.run("DELETE FROM studio_agent_sessions WHERE run_id = ? AND stage_key = ?", [r.run_id, r.stage_key]);
  return gone.length;
}

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

/** Production audio nothing points at, written before `cutoff`; productions with a run open are skipped. */
export async function sweepProductionAudio(core: StudioEngineCore, db: StudioDb, bucket: StudioBucket, cutoff: Date): Promise<number> {
  const keep = new Set<string>();
  for (const r of db.all<{ voice: string | null; music: string | null }>("SELECT voice, music FROM productions")) {
    for (const k of [...libraryKeys(r.voice), ...libraryKeys(r.music)]) keep.add(k);
  }
  for (const r of db.all<{ data: string }>("SELECT data FROM episode_revisions WHERE data LIKE '%library:studio/%'")) {
    for (const k of libraryKeys(r.data)) keep.add(k);
  }
  let removed = 0;
  for (const p of db.all<{ id: string; run_id: string | null }>("SELECT id, run_id FROM productions")) {
    if (hasOpenRun(core, db, p.id, p.run_id)) continue;
    const stale = (await bucket.list(`library/studio/${p.id}/`))
      .filter((o) => !keep.has(o.key) && o.lastModified.getTime() < cutoff.getTime()).map((o) => o.key);
    if (stale.length) { await bucket.deleteMany(stale); removed += stale.length; }
  }
  return removed;
}

function hasOpenRun(core: StudioEngineCore, db: StudioDb, productionId: string, planRun: string | null): boolean {
  const runs = [planRun, ...db.all<{ run_id: string | null }>("SELECT run_id FROM episodes WHERE production_id = ?", [productionId]).map((e) => e.run_id)];
  return runs.some((id) => { const run = id ? core.store.getRun(id) : undefined; return !!run && !isTerminal("run", run.state); });
}

/** Shot frames of episodes that no longer exist. */
export async function sweepShotFrames(db: StudioDb, bucket: StudioBucket): Promise<number> {
  const episodes = new Set(db.all<{ id: string }>("SELECT id FROM episodes").map((e) => e.id));
  let removed = 0;
  for (const p of db.all<{ id: string }>("SELECT id FROM productions")) {
    const stale = (await bucket.list(`productions/${p.id}/episodes/`)).map((o) => o.key).filter((k) => {
      const m = /^productions\/[^/]+\/episodes\/([^/]+)\/shots\//.exec(k);
      return !!m && !episodes.has(m[1]!);
    });
    if (stale.length) { await bucket.deleteMany(stale); removed += stale.length; }
  }
  return removed;
}

/** One sweep of everything above. */
export async function sweepStudioData(
  d: { core: StudioEngineCore; db: StudioDb; bucket: StudioBucket; voiceDir?: string | undefined },
  o: { now: Date; retention?: Partial<RetentionConfig> },
): Promise<CleanupReport> {
  const r = { ...DEFAULT_RETENTION, ...o.retention };
  const at = (days: number) => o.now.getTime() - days * DAY_MS;
  const workspaces = sweepWorkspaces(join(d.core.dataRoot, "workspaces"), at(r.workspaceDays), (id) => d.core.store.getRun(id)?.state ?? null);
  return {
    workspaces,
    sessions: sweepAgentSessions(d.db),
    voiceLines: d.voiceDir ? sweepVoiceStore(d.db, d.voiceDir, new Date(at(r.voiceDays)).toISOString()) : 0,
    audioObjects: await sweepProductionAudio(d.core, d.db, d.bucket, new Date(at(r.audioGraceDays))),
    shotFrames: await sweepShotFrames(d.db, d.bucket),
  };
}
