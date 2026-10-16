/**
 * Claude chat turns one by one (the detail behind `claude-stats`): each agent turn of `llm_calls` (source
 * `claude-agent`) with where it ran, who it acted for, how it ended, tokens (with the prompt cache), cost and time;
 * and one turn in full — the message that asked for it, its answer, every tool it called, the files it changed.
 */
import type { AgentPart } from "@harness/adapter-agent-cli";
import type { StudioDb } from "./studio-db.js";

export const CLAUDE_TURN_OUTCOMES = ["accepted", "failed", "rate_limited"] as const;
export type ClaudeTurnOutcome = (typeof CLAUDE_TURN_OUTCOMES)[number];
export const CLAUDE_TURN_SORTS = ["at", "cost", "wall", "tokens"] as const;
export type ClaudeTurnSort = (typeof CLAUDE_TURN_SORTS)[number];

export interface ClaudeTurnsQuery {
  /** ISO times: `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  /** Only these teams (a team owner); absent: every team (a Studio admin). */
  teamIds?: string[];
  projectId?: string;
  /** A video's turns; `""`: the project's own chats (no video). */
  videoId?: string;
  userId?: string;
  threadId?: string;
  outcome?: ClaudeTurnOutcome;
  sortBy?: ClaudeTurnSort;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ClaudeTurnRow {
  id: string;
  at: string;
  teamId: string | null;
  projectId: string | null;
  projectName: string | null;
  videoId: string | null;
  videoTitle: string | null;
  threadId: string;
  threadTitle: string | null;
  messageId: string;
  userId: string | null;
  model: string;
  outcome: string;
  /** The message's own state (done, failed, cancelled…); null when the message is gone. */
  status: string | null;
  trigger: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  wallSeconds: number;
  /** Steps of the CLI in the turn. */
  numTurns: number | null;
  /** Tools the turn called. */
  toolCount: number;
  /** The start of the message that asked for the turn. */
  prompt: string | null;
}

export interface ClaudeTurnTool {
  id: string; name: string; input: unknown; result: string | null; isError: boolean; startedAt: string; endedAt: string | null;
}

export interface ClaudeTurnDetail extends ClaudeTurnRow {
  /** The whole message that asked for the turn (a person's, or Studio's when a job ended). */
  promptText: string | null;
  promptBy: string | null;
  /** What the agent answered. */
  text: string | null;
  error: string | null;
  attempts: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  tools: ClaudeTurnTool[];
  /** Files the turn changed (from the activity log, while it keeps them). */
  changed: string[];
}

const PROMPT_PREVIEW = 160;
const TOOL_TEXT_MAX = 4000;

const SORT_SQL: Record<ClaudeTurnSort, string> = {
  at: "c.created_at", cost: "c.cost_usd", wall: "c.wall_seconds", tokens: "(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0))",
};

interface Raw {
  id: string; created_at: string; team_id: string | null; production_id: string | null; project_name: string | null; episode_id: string | null;
  video_title: string | null; run_id: string; thread_title: string | null; attempt_id: string; user_id: string | null; model: string; outcome: string;
  status: string | null; trigger: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null;
  cache_creation_tokens: number | null; cost_usd: number; wall_seconds: number; num_turns: number | null; parts: unknown; prompt: string | null;
}

const SELECT = `SELECT c.id, c.created_at, c.team_id, c.production_id, p.name AS project_name, c.episode_id, v.title AS video_title, c.run_id,
    t.title AS thread_title, c.attempt_id, c.user_id, c.model, c.outcome, m.status, m.trigger, c.input_tokens, c.output_tokens, c.cache_read_tokens,
    c.cache_creation_tokens, c.cost_usd, c.wall_seconds, c.num_turns, m.parts,
    (SELECT u.text FROM agent_messages u WHERE u.thread_id = m.thread_id AND u.role IN ('user', 'system') AND u.seq < m.seq ORDER BY u.seq DESC LIMIT 1) AS prompt
  FROM llm_calls c
  LEFT JOIN projects p ON p.id = c.production_id
  LEFT JOIN videos v ON v.id = c.episode_id
  LEFT JOIN agent_threads t ON t.id = c.run_id
  LEFT JOIN agent_messages m ON m.id = c.attempt_id`;

const parseParts = (raw: unknown): AgentPart[] => (Array.isArray(raw) ? (raw as AgentPart[]) : []);
const toolParts = (parts: AgentPart[]) => parts.filter((p): p is Extract<AgentPart, { kind: "tool" }> => p.kind === "tool");

function row(r: Raw): ClaudeTurnRow {
  const prompt = r.prompt?.trim() ?? null;
  return {
    id: r.id, at: r.created_at, teamId: r.team_id, projectId: r.production_id, projectName: r.project_name, videoId: r.episode_id, videoTitle: r.video_title,
    threadId: r.run_id, threadTitle: r.thread_title, messageId: r.attempt_id, userId: r.user_id, model: r.model, outcome: r.outcome, status: r.status,
    trigger: r.trigger, inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0, cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheCreationTokens: r.cache_creation_tokens ?? 0, costUsd: Math.round(r.cost_usd * 1e6) / 1e6, wallSeconds: Math.round(r.wall_seconds * 10) / 10,
    numTurns: r.num_turns, toolCount: toolParts(parseParts(r.parts)).length,
    prompt: prompt ? (prompt.length > PROMPT_PREVIEW ? `${prompt.slice(0, PROMPT_PREVIEW)}…` : prompt) : null,
  };
}

/** The agent's turns over a period, newest first (or by cost, time, tokens), a page at a time. */
export async function claudeTurns(db: StudioDb, q: ClaudeTurnsQuery): Promise<{ items: ClaudeTurnRow[]; total: number; page: number; pageSize: number }> {
  const where = ["c.source = 'claude-agent'", "c.created_at >= ?", "c.created_at < ?"];
  const params: (string | number)[] = [q.from, q.to];
  if (q.teamIds) {
    if (!q.teamIds.length) return { items: [], total: 0, page: 1, pageSize: q.pageSize ?? 50 };
    where.push(`c.team_id IN (${q.teamIds.map(() => "?").join(", ")})`);
    params.push(...q.teamIds);
  }
  if (q.projectId) { where.push("c.production_id = ?"); params.push(q.projectId); }
  if (q.videoId !== undefined) {
    if (q.videoId === "") where.push("c.episode_id IS NULL");
    else { where.push("c.episode_id = ?"); params.push(q.videoId); }
  }
  if (q.userId) { where.push("c.user_id = ?"); params.push(q.userId); }
  if (q.threadId) { where.push("c.run_id = ?"); params.push(q.threadId); }
  if (q.outcome) { where.push("c.outcome = ?"); params.push(q.outcome); }
  const filter = where.join(" AND ");
  const total = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_calls c WHERE ${filter}`, params))?.n ?? 0;
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  const order = `${SORT_SQL[q.sortBy ?? "at"]} ${q.sortOrder === "asc" ? "ASC" : "DESC"}, c.created_at DESC, c.id`;
  const items = (await db.all<Raw>(`${SELECT} WHERE ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])).map(row);
  return { items, total, page, pageSize };
}

const cut = (s: string | null | undefined) => (s == null ? null : s.length > TOOL_TEXT_MAX ? `${s.slice(0, TOOL_TEXT_MAX)}…` : s);
/** A tool's input with long text fields (a whole file written) shortened. */
function shortInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? cut(v) : v]));
}

/** One turn in full; undefined when it is not an agent turn (or not in `teamIds`, when given). */
export async function claudeTurn(db: StudioDb, id: string, opts: { teamIds?: string[] } = {}): Promise<ClaudeTurnDetail | undefined> {
  const r = await db.get<Raw>(`${SELECT} WHERE c.id = ? AND c.source = 'claude-agent'`, [id]);
  if (!r || (opts.teamIds && !opts.teamIds.includes(r.team_id ?? ""))) return undefined;
  const m = await db.get<{ thread_id: string; seq: number; text: string; error: string | null; attempts: number; started_at: string | null; finished_at: string | null }>(
    "SELECT thread_id, seq, text, error, attempts, started_at, finished_at FROM agent_messages WHERE id = ?", [r.attempt_id],
  );
  const asked = m
    ? await db.get<{ text: string; created_by: string | null }>(
      "SELECT text, created_by FROM agent_messages WHERE thread_id = ? AND role IN ('user', 'system') AND seq < ? ORDER BY seq DESC LIMIT 1", [m.thread_id, m.seq],
    )
    : undefined;
  const audit = await db.get<{ details: unknown }>("SELECT details FROM audit_log WHERE kind = 'turn' AND message_id = ? ORDER BY at DESC LIMIT 1", [r.attempt_id]);
  const d = audit?.details && typeof audit.details === "object" ? (audit.details as { changed?: unknown }) : null;
  const changed = Array.isArray(d?.changed) ? d.changed.filter((x): x is string => typeof x === "string") : [];
  return {
    ...row(r),
    promptText: asked?.text ?? null, promptBy: asked?.created_by ?? null, text: m?.text || null, error: m?.error ?? null, attempts: m?.attempts ?? null,
    startedAt: m?.started_at ?? null, finishedAt: m?.finished_at ?? null,
    tools: toolParts(parseParts(r.parts)).map((p) => ({
      id: p.id, name: p.name, input: shortInput(p.input), result: cut(p.result ?? null), isError: p.is_error === true, startedAt: p.started_at, endedAt: p.ended_at ?? null,
    })),
    changed,
  };
}
