/**
 * Claude chat statistics (migration 0037): the agent's turns (`llm_calls`, source `claude-agent`) and the messages
 * people sent, over a period, by team, project, video or the person a turn acted for — calls, threads, tokens (with the
 * prompt cache), cost, time, failures — and a series by day. Thread summaries are not agent turns and are not counted.
 */
import type { StudioDb } from "./studio-db.js";

export const CLAUDE_STATS_GROUPS = ["team", "project", "video", "user"] as const;
export type ClaudeStatsGroup = (typeof CLAUDE_STATS_GROUPS)[number];

export interface ClaudeStatsQuery {
  /** ISO times: `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  groupBy: ClaudeStatsGroup;
  /** Only these teams (a team owner); absent: every team (a Studio admin). */
  teamIds?: string[];
  projectId?: string;
  /** Minutes east of UTC of the viewer, for the days of the series (Vietnam: 420). */
  tzOffsetMinutes?: number;
}

export interface ClaudeStatsMetrics {
  /** Agent turns run (a turn retried after the plan's limit counts each time). */
  turns: number;
  threads: number;
  userMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  wallSeconds: number;
  failed: number;
  rateLimited: number;
}

export interface ClaudeStatsRow extends ClaudeStatsMetrics {
  /** The team, project, video or person; `null` for a video row: chats of the project, not of a video. */
  key: string | null;
  label: string | null;
  teamId: string | null;
  projectId: string | null;
}

export interface ClaudeStatsDay { day: string; turns: number; costUsd: number; inputTokens: number; outputTokens: number }

export interface ClaudeStats { totals: ClaudeStatsMetrics; rows: ClaudeStatsRow[]; daily: ClaudeStatsDay[] }

const CALL_KEY: Record<ClaudeStatsGroup, string> = { team: "c.team_id", project: "c.production_id", video: "c.episode_id", user: "c.user_id" };
const MESSAGE_KEY: Record<ClaudeStatsGroup, string> = { team: "p.team_id", project: "t.project_id", video: "t.video_id", user: "m.created_by" };

const zero = (): ClaudeStatsMetrics => ({
  turns: 0, threads: 0, userMessages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, wallSeconds: 0, failed: 0, rateLimited: 0,
});

interface CallRow {
  key: string | null; turns: number; threads: number; input: number | null; output: number | null; cache_read: number | null; cache_creation: number | null;
  cost: number | null; wall: number | null; failed: number | null; rate_limited: number | null;
}

function scope(q: ClaudeStatsQuery, team: string, project: string): { sql: string; params: string[] } {
  const c: string[] = [];
  const p: string[] = [];
  if (q.teamIds) {
    if (!q.teamIds.length) return { sql: " AND false", params: [] };
    c.push(`${team} IN (${q.teamIds.map(() => "?").join(", ")})`);
    p.push(...q.teamIds);
  }
  if (q.projectId) { c.push(`${project} = ?`); p.push(q.projectId); }
  return { sql: c.map((x) => ` AND ${x}`).join(""), params: p };
}

export async function claudeStats(db: StudioDb, q: ClaudeStatsQuery): Promise<ClaudeStats> {
  const calls = scope(q, "c.team_id", "c.production_id");
  const range = [q.from, q.to];
  const sums = `COUNT(*) AS turns, COUNT(DISTINCT c.run_id) AS threads, SUM(c.input_tokens) AS input, SUM(c.output_tokens) AS output,
    SUM(c.cache_read_tokens) AS cache_read, SUM(c.cache_creation_tokens) AS cache_creation, SUM(c.cost_usd) AS cost, SUM(c.wall_seconds) AS wall,
    COUNT(*) FILTER (WHERE c.outcome = 'failed') AS failed, COUNT(*) FILTER (WHERE c.outcome = 'rate_limited') AS rate_limited`;
  const base = `FROM llm_calls c WHERE c.source = 'claude-agent' AND c.created_at >= ? AND c.created_at < ?${calls.sql}`;
  const grouped = await db.all<CallRow>(`SELECT ${CALL_KEY[q.groupBy]} AS key, ${sums} ${base} GROUP BY ${CALL_KEY[q.groupBy]}`, [...range, ...calls.params]);
  const total = await db.get<CallRow>(`SELECT NULL AS key, ${sums} ${base}`, [...range, ...calls.params]);

  const msgs = scope(q, "p.team_id", "t.project_id");
  const msgBase = `FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id JOIN projects p ON p.id = t.project_id
    WHERE m.role = 'user' AND m.created_at >= ? AND m.created_at < ?${msgs.sql}`;
  const said = await db.all<{ key: string | null; n: number }>(`SELECT ${MESSAGE_KEY[q.groupBy]} AS key, COUNT(*) AS n ${msgBase} GROUP BY ${MESSAGE_KEY[q.groupBy]}`, [...range, ...msgs.params]);
  const saidTotal = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n ${msgBase}`, [...range, ...msgs.params]))?.n ?? 0;

  const metrics = (r: CallRow | undefined, userMessages: number): ClaudeStatsMetrics => ({
    turns: r?.turns ?? 0, threads: r?.threads ?? 0, userMessages, inputTokens: r?.input ?? 0, outputTokens: r?.output ?? 0, cacheReadTokens: r?.cache_read ?? 0,
    cacheCreationTokens: r?.cache_creation ?? 0, costUsd: Math.round((r?.cost ?? 0) * 1e6) / 1e6, wallSeconds: Math.round((r?.wall ?? 0) * 10) / 10,
    failed: r?.failed ?? 0, rateLimited: r?.rate_limited ?? 0,
  });
  const byKey = new Map<string | null, ClaudeStatsRow>();
  for (const r of grouped) byKey.set(r.key, { key: r.key, label: null, teamId: null, projectId: null, ...metrics(r, 0) });
  for (const s of said) {
    const row = byKey.get(s.key) ?? { key: s.key, label: null, teamId: null, projectId: null, ...zero() };
    row.userMessages = s.n;
    byKey.set(s.key, row);
  }
  const rows = [...byKey.values()];
  for (const row of rows) await label(db, q.groupBy, row);
  rows.sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns || b.userMessages - a.userMessages);

  const offset = Math.trunc(q.tzOffsetMinutes ?? 0);
  const daily = (await db.all<{ day: string; turns: number; cost: number | null; input: number | null; output: number | null }>(
    `SELECT to_char(c.created_at AT TIME ZONE 'UTC' + ?::int * interval '1 minute', 'YYYY-MM-DD') AS day, COUNT(*) AS turns, SUM(c.cost_usd) AS cost, SUM(c.input_tokens) AS input, SUM(c.output_tokens) AS output
       ${base} GROUP BY day ORDER BY day`,
    [offset, ...range, ...calls.params],
  )).map((d) => ({ day: d.day, turns: d.turns, costUsd: Math.round((d.cost ?? 0) * 1e6) / 1e6, inputTokens: d.input ?? 0, outputTokens: d.output ?? 0 }));

  return { totals: metrics(total, saidTotal), rows, daily };
}

/** Names a row's team, project or video (people are named by the API from the Account API). */
async function label(db: StudioDb, by: ClaudeStatsGroup, row: ClaudeStatsRow): Promise<void> {
  if (!row.key) return;
  if (by === "team") {
    row.teamId = row.key;
    row.label = (await db.get<{ name: string }>("SELECT name FROM teams WHERE id = ?", [row.key]))?.name ?? null;
  } else if (by === "project") {
    const p = await db.get<{ name: string; team_id: string }>("SELECT name, team_id FROM projects WHERE id = ?", [row.key]);
    row.projectId = row.key;
    row.label = p?.name ?? null;
    row.teamId = p?.team_id ?? null;
  } else if (by === "video") {
    const v = await db.get<{ title: string; project_id: string; project_name: string; team_id: string }>(
      "SELECT v.title, v.project_id, p.name AS project_name, p.team_id FROM videos v JOIN projects p ON p.id = v.project_id WHERE v.id = ?", [row.key],
    );
    row.label = v ? `${v.project_name} · ${v.title}` : null;
    row.projectId = v?.project_id ?? null;
    row.teamId = v?.team_id ?? null;
  }
}
