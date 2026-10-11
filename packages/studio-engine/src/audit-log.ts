/**
 * The activity log (migration 0036): what people changed through the API, every tool an agent called, every chat turn
 * and every background job — who, when, in which team/project/video, how it ended, how long, what it cost. The API,
 * the agent's tool route and the worker all write here; writing never fails the work it records. Chat text, file
 * content and secrets are never stored: `details` keeps ids, short fields and sizes, redacted and cut to 4 KB.
 */
import { randomUUID } from "node:crypto";
import type { StudioDb } from "./studio-db.js";

export type AuditActorKind = "user" | "agent" | "studio";
export type AuditKind = "http" | "tool" | "turn" | "job";

export interface AuditEntry {
  actorKind: AuditActorKind;
  /** Auth0 subject: the person, or for an agent/Studio row the person it acts for. */
  actorId?: string | null;
  kind: AuditKind;
  /** `Class.handler` of a route, a tool's name, `turn`, `job.<kind>`. */
  action: string;
  outcome: "ok" | "error";
  method?: string | null;
  route?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  teamId?: string | null;
  projectId?: string | null;
  videoId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  jobId?: string | null;
  /** What it was about, in a few words (a file path, a video title, an error). */
  target?: string | null;
  summary?: string | null;
  details?: unknown;
  costUsd?: number | null;
  requestId?: string | null;
  at?: string;
}

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|signature|api[-_]?key|private[-_]?key|credential/i;
const MAX_STRING = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
export const AUDIT_DETAILS_MAX = 4096;

/** A copy safe to keep: secret-looking keys dropped, strings, lists and depth cut; ≤ 4 KB as JSON. */
export function redactDetails(value: unknown): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…(${v.length})` : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? `[${v.length}]` : "{…}";
    if (Array.isArray(v)) {
      const head = v.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1));
      return v.length > MAX_ITEMS ? [...head, `…(${v.length})`] : head;
    }
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) continue;
        out[k] = walk(x, depth + 1);
      }
      return out;
    }
    return String(v);
  };
  const safe = walk(value, 0);
  const json = JSON.stringify(safe);
  if (json.length <= AUDIT_DETAILS_MAX) return safe;
  // too big even cut: keep the keys and a head of the text
  return { truncated: true, size: json.length, head: json.slice(0, AUDIT_DETAILS_MAX - 200) };
}

export interface AuditScope { teamId: string | null; projectId: string | null; videoId: string | null; threadId: string | null }

/** The team, project, video and thread a set of ids belongs to (unknown ids leave the rest as given). */
export function scopeOf(db: StudioDb, ids: { teamId?: string | null; projectId?: string | null; videoId?: string | null; threadId?: string | null; jobId?: string | null; actionId?: string | null }): AuditScope {
  let { projectId = null, videoId = null, threadId = null } = ids;
  if (ids.jobId && !projectId) {
    const j = db.get<{ project_id: string; video_id: string | null; thread_id: string | null }>("SELECT project_id, video_id, thread_id FROM project_jobs WHERE id = ?", [ids.jobId]);
    if (j) { projectId = j.project_id; videoId ??= j.video_id; threadId ??= j.thread_id; }
  }
  if (ids.actionId && !projectId) {
    const a = db.get<{ project_id: string; video_id: string | null; thread_id: string }>("SELECT project_id, video_id, thread_id FROM agent_actions WHERE id = ?", [ids.actionId]);
    if (a) { projectId = a.project_id; videoId ??= a.video_id; threadId ??= a.thread_id; }
  }
  if (threadId && !projectId) {
    const t = db.get<{ project_id: string; video_id: string | null }>("SELECT project_id, video_id FROM agent_threads WHERE id = ?", [threadId]);
    if (t) { projectId = t.project_id; videoId ??= t.video_id; }
  }
  if (videoId && !projectId) projectId = db.get<{ project_id: string }>("SELECT project_id FROM videos WHERE id = ?", [videoId])?.project_id ?? null;
  const teamId = ids.teamId ?? (projectId ? db.get<{ team_id: string }>("SELECT team_id FROM projects WHERE id = ?", [projectId])?.team_id ?? null : null);
  return { teamId, projectId, videoId, threadId };
}

/** Writes one row; a failure is reported to `onError` (default: stderr), never thrown. Returns the row's id. */
export function logAudit(db: StudioDb, e: AuditEntry, onError: (err: unknown) => void = (err) => process.stderr.write(`audit log: ${String(err)}\n`)): string | null {
  try {
    const scope = scopeOf(db, { teamId: e.teamId ?? null, projectId: e.projectId ?? null, videoId: e.videoId ?? null, threadId: e.threadId ?? null, jobId: e.jobId ?? null });
    const id = randomUUID();
    const details = e.details === undefined ? null : JSON.stringify(redactDetails(e.details));
    db.run(
      `INSERT INTO audit_log (id, at, actor_kind, actor_id, kind, action, outcome, method, route, status_code, duration_ms, team_id, project_id, video_id,
         thread_id, message_id, job_id, target, summary, details, cost_usd, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.at ?? new Date().toISOString(), e.actorKind, e.actorId ?? null, e.kind, e.action.slice(0, 120), e.outcome, e.method ?? null, e.route?.slice(0, 200) ?? null,
        e.statusCode ?? null, e.durationMs == null ? null : Math.round(e.durationMs), scope.teamId, scope.projectId, scope.videoId,
        scope.threadId, e.messageId ?? null, e.jobId ?? null, e.target?.slice(0, 300) ?? null, e.summary?.slice(0, 500) ?? null, details,
        e.costUsd ?? null, e.requestId ?? null],
    );
    return id;
  } catch (err) {
    onError(err);
    return null;
  }
}

export interface AuditFilter {
  /** Rows of these teams only (a team owner); absent: every row (a Studio admin). */
  teamIds?: string[];
  projectId?: string;
  videoId?: string;
  threadId?: string;
  actorId?: string;
  actorKind?: AuditActorKind;
  kind?: AuditKind;
  outcome?: "ok" | "error";
  /** ISO times, `from` inclusive, `to` exclusive. */
  from?: string;
  to?: string;
}

export interface AuditView {
  id: string;
  at: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  kind: AuditKind;
  action: string;
  outcome: "ok" | "error";
  method: string | null;
  route: string | null;
  statusCode: number | null;
  durationMs: number | null;
  team: { id: string; name: string | null } | null;
  project: { id: string; name: string | null } | null;
  video: { id: string; title: string | null } | null;
  threadId: string | null;
  messageId: string | null;
  jobId: string | null;
  target: string | null;
  summary: string | null;
  details: unknown;
  costUsd: number | null;
}

function where(f: AuditFilter): { sql: string; params: (string | number)[] } {
  const c: string[] = [];
  const p: (string | number)[] = [];
  if (f.teamIds) {
    if (!f.teamIds.length) return { sql: "WHERE 0", params: [] };
    c.push(`a.team_id IN (${f.teamIds.map(() => "?").join(", ")})`);
    p.push(...f.teamIds);
  }
  const eq: [keyof AuditFilter, string][] = [
    ["projectId", "a.project_id"], ["videoId", "a.video_id"], ["threadId", "a.thread_id"], ["actorId", "a.actor_id"], ["actorKind", "a.actor_kind"],
    ["kind", "a.kind"], ["outcome", "a.outcome"],
  ];
  for (const [k, col] of eq) {
    const v = f[k];
    if (typeof v === "string" && v) { c.push(`${col} = ?`); p.push(v); }
  }
  if (f.from) { c.push("a.at >= ?"); p.push(f.from); }
  if (f.to) { c.push("a.at < ?"); p.push(f.to); }
  return { sql: c.length ? `WHERE ${c.join(" AND ")}` : "", params: p };
}

interface AuditRow {
  id: string; at: string; actor_kind: AuditActorKind; actor_id: string | null; kind: AuditKind; action: string; outcome: "ok" | "error"; method: string | null;
  route: string | null; status_code: number | null; duration_ms: number | null; team_id: string | null; team_name: string | null; project_id: string | null;
  project_name: string | null; video_id: string | null; video_title: string | null; thread_id: string | null; message_id: string | null; job_id: string | null;
  target: string | null; summary: string | null; details: string | null; cost_usd: number | null;
}

/** A page of the log, newest first, with the names of the team, project and video when they still exist. */
export function listAudit(db: StudioDb, f: AuditFilter, page = 1, pageSize = 50): { items: AuditView[]; total: number; page: number; pageSize: number } {
  const w = where(f);
  const size = Math.min(Math.max(pageSize, 1), 200);
  const at = Math.max(page, 1);
  const rows = db.all<AuditRow>(
    `SELECT a.*, t.name AS team_name, p.name AS project_name, v.title AS video_title
       FROM audit_log a LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN videos v ON v.id = a.video_id
       ${w.sql} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...w.params, size, (at - 1) * size],
  );
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log a ${w.sql}`, w.params)?.n ?? 0;
  return {
    items: rows.map((r) => ({
      id: r.id, at: r.at, actorKind: r.actor_kind, actorId: r.actor_id, kind: r.kind, action: r.action, outcome: r.outcome, method: r.method, route: r.route,
      statusCode: r.status_code, durationMs: r.duration_ms,
      team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
      project: r.project_id ? { id: r.project_id, name: r.project_name } : null,
      video: r.video_id ? { id: r.video_id, title: r.video_title } : null,
      threadId: r.thread_id, messageId: r.message_id, jobId: r.job_id, target: r.target, summary: r.summary,
      details: r.details ? JSON.parse(r.details) : null, costUsd: r.cost_usd,
    })),
    total, page: at, pageSize: size,
  };
}

/** The people who appear in the log under a filter (for the "who" filter). */
export function auditActors(db: StudioDb, f: AuditFilter): string[] {
  const w = where({ ...f, actorId: undefined });
  return db.all<{ actor_id: string }>(`SELECT DISTINCT a.actor_id FROM audit_log a ${w.sql}${w.sql ? " AND" : " WHERE"} a.actor_id IS NOT NULL ORDER BY a.actor_id LIMIT 500`, w.params)
    .map((r) => r.actor_id);
}

/** Drops rows older than `cutoff` (ISO); how many went. */
export function sweepAuditLog(db: StudioDb, cutoff: string): number {
  return db.run("DELETE FROM audit_log WHERE at < ?", [cutoff]).changes;
}
