/**
 * Diagnostics of a period for a Studio admin (plan 2026-11-07 prod-diagnostics): what went wrong — jobs, agent turns,
 * cards, API writes and tools, grouped by the shape of their message and set against the period just before — and how
 * the renders ran. Read-only SQL on Studio's own tables; the API adds the farm's view of its jobs.
 */
import type { StudioDb } from "./studio-db.js";

export interface DiagnosticsPeriod {
  /** ISO times: `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  /** Minutes east of UTC of the viewer, for the days of the series (Vietnam: 420). */
  tzOffsetMinutes?: number;
}

/** Longest period one request reads (the activity log keeps 90 days). */
export const DIAGNOSTICS_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

/** The period of the same length that ends where `p` starts. */
export function previousPeriod(p: DiagnosticsPeriod): DiagnosticsPeriod {
  const from = Date.parse(p.from);
  const to = Date.parse(p.to);
  return { ...p, from: new Date(from - (to - from)).toISOString(), to: new Date(from).toISOString() };
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const seconds = (a: string | null, b: string | null): number | null => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);

/** The `q` quantile (0..1) of `xs`; null when empty. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

// ---------------------------------------------------------------------------------------------------------------
// Overview

export interface JobCount { kind: string; status: string; n: number }
export interface StuckJob {
  id: string; kind: string; status: string; title: string; projectId: string; projectName: string | null; videoId: string | null;
  createdAt: string; startedAt: string | null; nodeId: string | null; minutes: number;
}
export interface DiagnosticsDay { day: string; jobs: number; jobsFailed: number; turns: number; turnsFailed: number }
export interface TurnSummary {
  /** Agent answers (assistant messages) by status. */
  byStatus: Record<string, number>;
  /** Agent answers by what started them (`timeout`: a turn that went on after the 20 minute cut). */
  byTrigger: Record<string, number>;
  costUsd: number;
}
export interface ClaudeAccountProblem { id: string; label: string; lastError: string; lastErrorAt: string; rateLimitedUntil: string | null }

export interface DiagnosticsOverview {
  jobs: JobCount[];
  previousJobs: JobCount[];
  turns: TurnSummary;
  previousTurns: TurnSummary;
  /** Now, not in the period: jobs running or waiting far longer than they should. */
  stuck: StuckJob[];
  daily: DiagnosticsDay[];
  /** Claude accounts whose last error falls in the period. */
  accounts: ClaudeAccountProblem[];
}

/** A running job of this kind is stuck past these minutes (others: `STUCK_DEFAULT_MINUTES`). */
export const STUCK_MINUTES: Record<string, number> = { render_final: 180, export_premiere: 180, render_preview: 60, research: 60, style_watch: 60 };
export const STUCK_DEFAULT_MINUTES = 45;
/** A job queued longer than this is stuck waiting. */
export const STUCK_QUEUED_MINUTES = 30;

async function jobCounts(db: StudioDb, p: DiagnosticsPeriod): Promise<JobCount[]> {
  return db.all<JobCount>(
    "SELECT kind, status, COUNT(*)::int AS n FROM project_jobs WHERE created_at >= ? AND created_at < ? GROUP BY kind, status ORDER BY kind, status",
    [p.from, p.to],
  );
}

async function turnSummary(db: StudioDb, p: DiagnosticsPeriod): Promise<TurnSummary> {
  const rows = await db.all<{ status: string; trigger: string; n: number; cost: number | null }>(
    `SELECT status, trigger, COUNT(*)::int AS n, SUM(cost_usd) AS cost FROM agent_messages
      WHERE role = 'assistant' AND created_at >= ? AND created_at < ? GROUP BY status, trigger`,
    [p.from, p.to],
  );
  const out: TurnSummary = { byStatus: {}, byTrigger: {}, costUsd: 0 };
  for (const r of rows) {
    out.byStatus[r.status] = (out.byStatus[r.status] ?? 0) + r.n;
    out.byTrigger[r.trigger] = (out.byTrigger[r.trigger] ?? 0) + r.n;
    out.costUsd += r.cost ?? 0;
  }
  out.costUsd = round(out.costUsd, 4);
  return out;
}

export async function stuckJobs(db: StudioDb, nowIso: string): Promise<StuckJob[]> {
  const rows = await db.all<{
    id: string; kind: string; status: string; title: string; project_id: string; project_name: string | null; video_id: string | null;
    created_at: string; started_at: string | null; node_id: string | null;
  }>(
    `SELECT j.id, j.kind, j.status, j.title, j.project_id, p.name AS project_name, j.video_id, j.created_at, j.started_at, j.node_id
       FROM project_jobs j LEFT JOIN projects p ON p.id = j.project_id
      WHERE j.status IN ('queued', 'running') ORDER BY j.created_at`,
  );
  const now = Date.parse(nowIso);
  const out: StuckJob[] = [];
  for (const r of rows) {
    const since = r.status === "running" ? r.started_at ?? r.created_at : r.created_at;
    const minutes = (now - Date.parse(since)) / 60_000;
    const limit = r.status === "running" ? STUCK_MINUTES[r.kind] ?? STUCK_DEFAULT_MINUTES : STUCK_QUEUED_MINUTES;
    if (minutes <= limit) continue;
    out.push({
      id: r.id, kind: r.kind, status: r.status, title: r.title, projectId: r.project_id, projectName: r.project_name, videoId: r.video_id,
      createdAt: r.created_at, startedAt: r.started_at, nodeId: r.node_id, minutes: Math.round(minutes),
    });
  }
  return out;
}

export async function diagnosticsOverview(db: StudioDb, p: DiagnosticsPeriod, nowIso: string): Promise<DiagnosticsOverview> {
  const prev = previousPeriod(p);
  const offset = Math.trunc(p.tzOffsetMinutes ?? 0);
  const day = (col: string) => `to_char(${col} AT TIME ZONE 'UTC' + ?::int * interval '1 minute', 'YYYY-MM-DD')`;
  const jobDays = await db.all<{ day: string; n: number; failed: number }>(
    `SELECT ${day("created_at")} AS day, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM project_jobs WHERE created_at >= ? AND created_at < ? GROUP BY day`,
    [offset, p.from, p.to],
  );
  const turnDays = await db.all<{ day: string; n: number; failed: number }>(
    `SELECT ${day("created_at")} AS day, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status IN ('failed', 'rate_limited'))::int AS failed
       FROM agent_messages WHERE role = 'assistant' AND created_at >= ? AND created_at < ? GROUP BY day`,
    [offset, p.from, p.to],
  );
  const days = new Map<string, DiagnosticsDay>();
  const at = (d: string) => days.get(d) ?? days.set(d, { day: d, jobs: 0, jobsFailed: 0, turns: 0, turnsFailed: 0 }).get(d)!;
  for (const r of jobDays) Object.assign(at(r.day), { jobs: r.n, jobsFailed: r.failed });
  for (const r of turnDays) Object.assign(at(r.day), { turns: r.n, turnsFailed: r.failed });
  const accounts = await db.all<{ id: string; label: string; last_error: string; last_error_at: string; rate_limited_until: string | null }>(
    `SELECT id, name AS label, last_error, last_error_at, rate_limited_until FROM claude_accounts
      WHERE last_error IS NOT NULL AND last_error_at >= ? AND last_error_at < ? ORDER BY last_error_at DESC`,
    [p.from, p.to],
  );
  return {
    jobs: await jobCounts(db, p),
    previousJobs: await jobCounts(db, prev),
    turns: await turnSummary(db, p),
    previousTurns: await turnSummary(db, prev),
    stuck: await stuckJobs(db, nowIso),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, lastError: a.last_error, lastErrorAt: a.last_error_at, rateLimitedUntil: a.rate_limited_until })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Errors grouped by their shape

/** Where an error was recorded. */
export const DIAGNOSTIC_ERROR_SOURCES = ["job", "turn", "action", "http", "tool"] as const;
export type DiagnosticErrorSource = (typeof DIAGNOSTIC_ERROR_SOURCES)[number] | `log:${string}`;

export interface ErrorOccurrence {
  source: DiagnosticErrorSource;
  /** Job kind, turn trigger, card kind, API action, tool name or log level. */
  kind: string;
  message: string;
  at: string;
  projectId: string | null;
  projectName: string | null;
  videoId: string | null;
  /** The job, thread, card or request it belongs to. */
  ref: string | null;
  /** A log line said this many times within a minute (`error_events.repeats`); absent: once. */
  repeats?: number;
}

export interface ErrorGroup {
  /** `source|signature`, stable between periods. */
  key: string;
  source: DiagnosticErrorSource;
  signature: string;
  kinds: string[];
  count: number;
  projects: number;
  firstAt: string;
  lastAt: string;
  previousCount: number;
  /** `new`: not seen in the period before; `same`: seen then too. */
  trend: "new" | "same";
  examples: ErrorOccurrence[];
}

export interface DiagnosticsErrors {
  groups: ErrorGroup[];
  /** Groups of the period before that did not happen in this one. */
  gone: { key: string; source: DiagnosticErrorSource; signature: string; previousCount: number }[];
  total: number;
  /** True when a source had more rows than one request reads (`ERROR_ROWS_LIMIT`). */
  truncated: boolean;
}

/** Rows read per source and period. */
export const ERROR_ROWS_LIMIT = 5000;
const EXAMPLES = 5;
const SIGNATURE_LENGTH = 160;

/**
 * The shape of an error message, so the same failure with other ids, numbers, paths or an HTML error page groups as
 * one: whitespace collapsed, an HTML page cut to `<html>`, uuids `<id>`, long hex `<hex>`, numbers `N` (an HTTP status
 * stays), quoted strings `"…"`, cut to 160 characters.
 */
export function errorSignature(message: string): string {
  let s = message.replace(/\s+/g, " ").trim();
  const html = s.search(/<!DOCTYPE|<html/i);
  if (html >= 0) s = `${s.slice(0, html)}<html>`;
  s = s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(?:0x)?(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/(?<!HTTP |HTTP\/|status |code )\b\d+(?:[.,]\d+)?\b/gi, "N");
  return s.length > SIGNATURE_LENGTH ? `${s.slice(0, SIGNATURE_LENGTH - 1)}…` : s;
}

interface OccurrenceRow { repeats?: number; source: string; kind: string | null; message: string; at: string; project_id: string | null; project_name: string | null; video_id: string | null; ref: string | null }

/** Every error of the period, newest first, at most `ERROR_ROWS_LIMIT` per source. */
export async function errorOccurrences(db: StudioDb, p: DiagnosticsPeriod): Promise<{ rows: ErrorOccurrence[]; truncated: boolean }> {
  const range = [p.from, p.to];
  const queries: string[] = [
    `SELECT 'job' AS source, j.kind, j.error AS message, j.created_at AS at, j.project_id, pr.name AS project_name, j.video_id, j.id AS ref
       FROM project_jobs j LEFT JOIN projects pr ON pr.id = j.project_id
      WHERE j.status = 'failed' AND j.error IS NOT NULL AND j.created_at >= ? AND j.created_at < ?`,
    `SELECT 'turn' AS source, m.trigger AS kind, COALESCE(m.error, m.status) AS message, m.created_at AS at, t.project_id, pr.name AS project_name, t.video_id, m.thread_id AS ref
       FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id LEFT JOIN projects pr ON pr.id = t.project_id
      WHERE m.role = 'assistant' AND m.status IN ('failed', 'rate_limited') AND m.created_at >= ? AND m.created_at < ?`,
    `SELECT 'action' AS source, a.kind, a.error AS message, a.created_at AS at, a.project_id, pr.name AS project_name, a.video_id, a.id AS ref
       FROM agent_actions a LEFT JOIN projects pr ON pr.id = a.project_id
      WHERE a.status = 'failed' AND a.error IS NOT NULL AND a.created_at >= ? AND a.created_at < ?`,
    // job and turn rows of the activity log say again what project_jobs and agent_messages hold
    `SELECT l.kind AS source, l.action AS kind, COALESCE(l.summary, l.action) AS message, l.at, l.project_id, pr.name AS project_name, l.video_id,
            COALESCE(l.request_id, l.thread_id, l.id) AS ref
       FROM audit_log l LEFT JOIN projects pr ON pr.id = l.project_id
      WHERE l.outcome = 'error' AND l.kind IN ('http', 'tool') AND l.at >= ? AND l.at < ?`,
    // errors that would only be in a container's log (migration 0012)
    `SELECT 'log:' || e.service AS source, e.level AS kind, e.message, e.at, e.project_id, pr.name AS project_name, e.video_id, COALESCE(e.request_id, e.id) AS ref, e.repeats
       FROM error_events e LEFT JOIN projects pr ON pr.id = e.project_id
      WHERE e.at >= ? AND e.at < ?`,
  ];
  const rows: ErrorOccurrence[] = [];
  let truncated = false;
  for (const sql of queries) {
    const part = await db.all<OccurrenceRow>(`${sql} ORDER BY at DESC LIMIT ${ERROR_ROWS_LIMIT + 1}`, range);
    if (part.length > ERROR_ROWS_LIMIT) { truncated = true; part.length = ERROR_ROWS_LIMIT; }
    for (const r of part) {
      rows.push({
        source: r.source as DiagnosticErrorSource, kind: r.kind ?? "", message: r.message, at: r.at, projectId: r.project_id, projectName: r.project_name,
        videoId: r.video_id, ref: r.ref, ...(r.repeats && r.repeats > 1 ? { repeats: r.repeats } : {}),
      });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return { rows, truncated };
}

/** Groups occurrences by source and signature, most frequent first, marked against the period before. */
export function groupErrors(current: readonly ErrorOccurrence[], previous: readonly ErrorOccurrence[]): Pick<DiagnosticsErrors, "groups" | "gone"> {
  const keyOf = (o: ErrorOccurrence) => `${o.source}|${errorSignature(o.message)}`;
  const before = new Map<string, { o: ErrorOccurrence; n: number }>();
  for (const o of previous) {
    const k = keyOf(o);
    const hit = before.get(k);
    if (hit) hit.n += o.repeats ?? 1;
    else before.set(k, { o, n: o.repeats ?? 1 });
  }
  const groups = new Map<string, ErrorGroup & { projectSet: Set<string>; kindSet: Set<string> }>();
  for (const o of current) {
    const k = keyOf(o);
    let g = groups.get(k);
    if (!g) {
      const prev = before.get(k)?.n ?? 0;
      g = {
        key: k, source: o.source, signature: errorSignature(o.message), kinds: [], count: 0, projects: 0, firstAt: o.at, lastAt: o.at,
        previousCount: prev, trend: prev ? "same" : "new", examples: [], projectSet: new Set(), kindSet: new Set(),
      };
      groups.set(k, g);
    }
    g.count += o.repeats ?? 1;
    if (o.projectId) g.projectSet.add(o.projectId);
    if (o.kind) g.kindSet.add(o.kind);
    if (o.at < g.firstAt) g.firstAt = o.at;
    if (o.at > g.lastAt) g.lastAt = o.at;
    if (g.examples.length < EXAMPLES) g.examples.push(o);
  }
  const out = [...groups.values()].map(({ projectSet, kindSet, ...g }) => ({ ...g, projects: projectSet.size, kinds: [...kindSet].sort() }));
  out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  const gone = [...before.entries()].filter(([k]) => !groups.has(k))
    .map(([k, { o, n }]) => ({ key: k, source: o.source, signature: errorSignature(o.message), previousCount: n }))
    .sort((a, b) => b.previousCount - a.previousCount);
  return { groups: out, gone };
}

export async function diagnosticsErrors(db: StudioDb, p: DiagnosticsPeriod): Promise<DiagnosticsErrors> {
  const now = await errorOccurrences(db, p);
  const before = await errorOccurrences(db, previousPeriod(p));
  return { ...groupErrors(now.rows, before.rows), total: now.rows.reduce((n, o) => n + (o.repeats ?? 1), 0), truncated: now.truncated };
}

/** Days between two ISO times, for the API's range check. */
export function periodDays(p: DiagnosticsPeriod): number { return (Date.parse(p.to) - Date.parse(p.from)) / DAY_MS; }
export { seconds as secondsBetween, round as roundTo };
