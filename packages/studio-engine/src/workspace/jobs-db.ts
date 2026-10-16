/**
 * Heavy work of a project, run in the background by the worker (spec 2026-10-10 agent-workspace §3.4, §5): preparing
 * input videos, renders, reading narration… Each job says who works on it, how far it is and how long is left, and
 * can be stopped. Rows in `project_jobs`.
 */
import { randomUUID } from "node:crypto";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import type { ActorRole } from "../agent/threads-db.js";

export const JOB_KINDS = ["prepare_asset", "transcribe_upload", "tts", "fit", "render_preview", "render_final", "export_premiere", "research", "style_watch", "thumbnail", "music_beats"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string; project_id: string; video_id: string | null; thread_id: string | null; kind: JobKind; status: JobStatus; title: string;
  /** What the job was asked (jsonb, parsed). */
  request: unknown;
  /** What it answered (jsonb, parsed), null until it did. */
  result: unknown;
  error: string | null; phase: string | null; progress: number | null; eta_seconds: number | null;
  node_id: string | null; units: number | null; farm_job_id: string | null; cancel_requested: boolean; continue_agent: boolean; attempts: number;
  created_by: string; actor_role: ActorRole | null; created_at: string; started_at: string | null; finished_at: string | null; updated_at: string;
}

export interface JobView {
  id: string; projectId: string; videoId: string | null; threadId: string | null; kind: JobKind; status: JobStatus; title: string;
  request: unknown; result: unknown; error: string | null; phase: string | null; progress: number | null; etaSeconds: number | null;
  nodeId: string | null; cancelRequested: boolean; createdBy: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export function jobView(j: JobRecord): JobView {
  return {
    id: j.id, projectId: j.project_id, videoId: j.video_id, threadId: j.thread_id, kind: j.kind, status: j.status, title: j.title,
    request: j.request ?? null, result: j.result ?? null, error: j.error, phase: j.phase, progress: j.progress, etaSeconds: j.eta_seconds,
    nodeId: j.node_id, cancelRequested: j.cancel_requested, createdBy: j.created_by, createdAt: j.created_at, startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

export async function createJob(db: StudioDb, p: {
  projectId: string; videoId?: string | null; threadId?: string | null; kind: JobKind; title: string; request: unknown; units?: number | null;
  continueAgent?: boolean; createdBy: string; actorRole?: ActorRole | null;
}, now = new Date().toISOString()): Promise<JobRecord> {
  return (await db.get<JobRecord>(
    `INSERT INTO project_jobs (id, project_id, video_id, thread_id, kind, status, title, request, units, continue_agent, created_by, actor_role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [randomUUID(), p.projectId, p.videoId ?? null, p.threadId ?? null, p.kind, p.title, JSON.stringify(p.request ?? {}), p.units ?? null,
      !!p.continueAgent, p.createdBy, p.actorRole ?? null, now, now],
  ))!;
}

export async function getJob(db: StudioDb, id: string): Promise<JobRecord | undefined> {
  return db.get<JobRecord>("SELECT * FROM project_jobs WHERE id = ?", [id]);
}

export async function requireJob(db: StudioDb, id: string): Promise<JobRecord> {
  const j = await getJob(db, id);
  if (!j) throw new StudioRunError("not_found", `không có việc ${id}`);
  return j;
}

/** A project's jobs, newest first; `active` = queued or running only. */
export async function listJobs(db: StudioDb, projectId: string, opts: { active?: boolean; videoId?: string; limit?: number } = {}): Promise<JobRecord[]> {
  const where = ["project_id = ?"];
  const params: (string | number)[] = [projectId];
  if (opts.active) where.push("status IN ('queued', 'running')");
  if (opts.videoId) { where.push("video_id = ?"); params.push(opts.videoId); }
  return db.all<JobRecord>(`SELECT * FROM project_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, [...params, opts.limit ?? 100]);
}

/** A queued job of these kinds (oldest first) taken to run; one statement, so two workers never take the same job. */
export async function claimJob(db: StudioDb, kinds: readonly JobKind[], now: string): Promise<JobRecord | null> {
  if (!kinds.length) return null;
  const placeholders = kinds.map(() => "?").join(", ");
  return (await db.get<JobRecord>(
    `UPDATE project_jobs SET status = 'running', started_at = COALESCE(started_at, ?::timestamptz), attempts = attempts + 1, updated_at = ?
      WHERE id = (SELECT id FROM project_jobs WHERE status = 'queued' AND kind IN (${placeholders}) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now, now, ...kinds],
  )) ?? null;
}

/** How far it is: what it does now, 0–1, seconds left, which machine. Only fields given change. */
export async function reportJob(db: StudioDb, id: string, p: { phase?: string | null; progress?: number | null; etaSeconds?: number | null; nodeId?: string | null; farmJobId?: string | null }, now: string): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const put = (col: string, v: string | number | null | undefined) => { if (v !== undefined) { sets.push(`${col} = ?`); params.push(v); } };
  put("phase", p.phase === null || p.phase === undefined ? p.phase : JSON.stringify(p.phase));
  put("progress", p.progress === null || p.progress === undefined ? p.progress : Math.max(0, Math.min(1, p.progress)));
  put("eta_seconds", p.etaSeconds === null || p.etaSeconds === undefined ? p.etaSeconds : Math.max(0, Math.round(p.etaSeconds)));
  put("node_id", p.nodeId);
  put("farm_job_id", p.farmJobId);
  if (!sets.length) return;
  await db.run(`UPDATE project_jobs SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND status = 'running'`, [...params, now, id]);
}

const FINISH_SET = `status = ?, result = ?, error = ?, phase = NULL, progress = CASE WHEN ?::text = 'done' THEN 1 ELSE progress END,
            eta_seconds = NULL, finished_at = ?, updated_at = ?`;
type Finish = { status: "done" | "failed" | "cancelled"; result?: unknown; error?: string | null };
const finishParams = (p: Finish, now: string) => [p.status, p.result === undefined ? null : JSON.stringify(p.result), p.error ?? null, p.status, now, now];

export async function finishJob(db: StudioDb, id: string, p: Finish, now: string): Promise<void> {
  await db.run(`UPDATE project_jobs SET ${FINISH_SET} WHERE id = ?`, [...finishParams(p, now), id]);
}

/** Stop: a queued job is cancelled at once; a running one is asked to stop (its runner kills ffmpeg or cancels the farm job). */
export async function requestJobCancel(db: StudioDb, id: string, now = new Date().toISOString()): Promise<JobRecord> {
  await requireJob(db, id);
  // a job a worker takes in between is asked to stop instead
  const { changes } = await db.run(`UPDATE project_jobs SET ${FINISH_SET} WHERE id = ? AND status = 'queued'`, [...finishParams({ status: "cancelled", error: null }, now), id]);
  if (!changes) await db.run("UPDATE project_jobs SET cancel_requested = true, updated_at = ? WHERE id = ? AND status = 'running'", [now, id]);
  return (await getJob(db, id))!;
}

export async function jobCancelRequested(db: StudioDb, id: string): Promise<boolean> {
  return (await db.get<{ c: boolean }>("SELECT cancel_requested AS c FROM project_jobs WHERE id = ?", [id]))?.c === true;
}

/** A running job's runner says it is alive (every few seconds); a job silent longer than `JOB_STALE_MS` was left. */
export async function touchJob(db: StudioDb, id: string, now: string): Promise<void> {
  await db.run("UPDATE project_jobs SET updated_at = ? WHERE id = ? AND status = 'running'", [now, id]);
}

export const JOB_STALE_MS = 2 * 60_000;

/**
 * Jobs a stopped worker left running (no word for `JOB_STALE_MS`) go back in line; their farm job is found again by
 * its correlation id, not sent twice. Too many attempts: failed instead. A job whose runner spoke up in between is left.
 */
export async function requeueStaleJobs(db: StudioDb, now: string, maxAttempts = 3): Promise<{ requeued: string[]; failed: string[] }> {
  const before = new Date(Date.parse(now) - JOB_STALE_MS).toISOString();
  const stale = "id = ? AND status = 'running' AND updated_at < ?";
  const rows = await db.all<{ id: string; attempts: number; cancel_requested: boolean }>(
    "SELECT id, attempts, cancel_requested FROM project_jobs WHERE status = 'running' AND updated_at < ?", [before]);
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    if (r.cancel_requested) {
      await db.run(`UPDATE project_jobs SET ${FINISH_SET} WHERE ${stale}`, [...finishParams({ status: "cancelled" }, now), r.id, before]);
    } else if (r.attempts >= maxAttempts) {
      const { changes } = await db.run(`UPDATE project_jobs SET ${FINISH_SET} WHERE ${stale}`,
        [...finishParams({ status: "failed", error: "worker dừng giữa chừng nhiều lần" }, now), r.id, before]);
      if (changes) failed.push(r.id);
    } else {
      const { changes } = await db.run(`UPDATE project_jobs SET status = 'queued', phase = NULL, eta_seconds = NULL, updated_at = ? WHERE ${stale}`, [now, r.id, before]);
      if (changes) requeued.push(r.id);
    }
  }
  return { requeued, failed };
}

/** Seconds per unit of the last finished jobs of a kind (median), to estimate a new one before it reports progress. */
export async function secondsPerUnit(db: StudioDb, kind: JobKind, sample = 20): Promise<number | null> {
  const rows = await db.all<{ s: number; u: number }>(
    `SELECT EXTRACT(EPOCH FROM (finished_at - started_at)) AS s, units AS u FROM project_jobs
      WHERE kind = ? AND status = 'done' AND units > 0 AND started_at IS NOT NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT ?`, [kind, sample]);
  const per = rows.filter((r) => r.s > 0).map((r) => r.s / r.u).sort((a, b) => a - b);
  if (!per.length) return null;
  const mid = Math.floor(per.length / 2);
  return per.length % 2 ? per[mid]! : (per[mid - 1]! + per[mid]!) / 2;
}
