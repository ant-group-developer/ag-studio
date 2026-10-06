/**
 * The chat of a production (migration 0019, spec local-chat §3.1). The API writes a person's message together with a
 * pending reply; the worker's chat loop runs the reply. Nothing a reply proposes is applied until someone presses
 * Apply/Approve, so a proposal only lives here.
 */
import { randomUUID } from "node:crypto";
import type { StudioDb } from "./studio-db.js";

export type ChatScope = "intake" | "gate" | "failed" | "timeline";
export type ChatRole = "user" | "assistant" | "system";
export type ChatTurnStatus = "pending" | "running" | "done" | "failed" | "rate_limited";
export type ChatAction = "answer" | "revise" | "suggest_approve" | "render" | "export" | "retry";

/** Where a turn belongs: one gate of one run, the intake of a production not started yet, the timeline of an episode… */
export interface ChatScopeKey {
  productionId: string;
  episodeId: string | null;
  runId: string | null;
  stageKey: string;
  scope: ChatScope;
}

export interface ChatMention { kind: "folder"; id: string; name: string }
export interface ChatProblem { code: string; message: string }

export interface ChatTurn {
  id: string;
  production_id: string;
  episode_id: string | null;
  run_id: string | null;
  scope: ChatScope;
  stage_key: string;
  turn: number;
  role: ChatRole;
  text: string;
  mentions: ChatMention[];
  context: unknown;
  proposal: unknown;
  action: ChatAction | null;
  status: ChatTurnStatus;
  not_before: string | null;
  problems: ChatProblem[];
  llm_call_id: string | null;
  created_by: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatTurnRow extends Omit<ChatTurn, "mentions" | "context" | "proposal" | "problems"> {
  mentions: string; context: string | null; proposal: string | null; problems: string;
}

function toTurn(r: ChatTurnRow): ChatTurn {
  return {
    ...r,
    mentions: JSON.parse(r.mentions) as ChatMention[],
    context: r.context === null ? null : JSON.parse(r.context),
    proposal: r.proposal === null ? null : JSON.parse(r.proposal),
    problems: JSON.parse(r.problems) as ChatProblem[],
  };
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** SQL matching one scope; `IS` so a NULL episode/run compares equal. */
const SCOPE_WHERE = "production_id = ? AND episode_id IS ? AND run_id IS ? AND stage_key = ?";
const scopeParams = (k: ChatScopeKey) => [k.productionId, k.episodeId, k.runId, k.stageKey];

function insertTurn(db: StudioDb, k: ChatScopeKey, t: {
  role: ChatRole; text: string; status: ChatTurnStatus; mentions?: ChatMention[] | undefined; context?: unknown; proposal?: unknown; createdBy?: string | null | undefined;
}, now: string): ChatTurn {
  const next = db.get<{ n: number }>("SELECT COALESCE(MAX(turn), 0) + 1 AS n FROM stage_chat_turns WHERE production_id = ?", [k.productionId])!.n;
  const id = randomUUID();
  db.run(
    `INSERT INTO stage_chat_turns (id, production_id, episode_id, run_id, scope, stage_key, turn, role, text, mentions, context, proposal,
       status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, k.productionId, k.episodeId, k.runId, k.scope, k.stageKey, next, t.role, t.text, JSON.stringify(t.mentions ?? []),
      json(t.context), json(t.proposal), t.status, t.createdBy ?? null, now, now],
  );
  return getTurn(db, id)!;
}

export function getTurn(db: StudioDb, id: string): ChatTurn | undefined {
  const r = db.get<ChatTurnRow>("SELECT * FROM stage_chat_turns WHERE id = ?", [id]);
  return r ? toTurn(r) : undefined;
}

/**
 * A person's message. With `ask` (the default) Claude is asked to reply: a reply still waiting in the scope is moved
 * after this message so Claude answers both at once; a reply already running gets a new one queued behind it.
 * `ask: false` is a message nobody answers — a manual edit, which carries its document as `proposal`.
 */
export function insertUserTurn(db: StudioDb, k: ChatScopeKey, m: {
  text: string; createdBy: string; mentions?: ChatMention[] | undefined; context?: unknown; proposal?: unknown; ask?: boolean | undefined;
}, now: string): { user: ChatTurn; assistant: ChatTurn | null } {
  return db.immediate(() => {
    if (m.ask !== false) db.run(`DELETE FROM stage_chat_turns WHERE ${SCOPE_WHERE} AND role = 'assistant' AND status = 'pending'`, scopeParams(k));
    const user = insertTurn(db, k, { role: "user", text: m.text, status: "done", mentions: m.mentions, context: m.context, proposal: m.proposal, createdBy: m.createdBy }, now);
    const assistant = m.ask === false ? null : insertTurn(db, k, { role: "assistant", text: "", status: "pending" }, now);
    return { user, assistant };
  });
}

/** A line from Studio itself ("Bạn đã sửa tay timeline (bản 4)"). */
export function insertSystemTurn(db: StudioDb, k: ChatScopeKey, text: string, now: string): ChatTurn {
  return db.immediate(() => insertTurn(db, k, { role: "system", text, status: "done" }, now));
}

/** The thread of a production (episodeId omitted) or of one of its episodes, in order; `after` = a turn number. */
export function listTurns(db: StudioDb, productionId: string, o: { episodeId?: string | null; after?: number } = {}): ChatTurn[] {
  return db.all<ChatTurnRow>(
    "SELECT * FROM stage_chat_turns WHERE production_id = ? AND episode_id IS ? AND turn > ? ORDER BY turn",
    [productionId, o.episodeId ?? null, o.after ?? 0],
  ).map(toTurn);
}

/** Every turn of one scope, in order (the history a reply is written from). */
export function scopeTurns(db: StudioDb, k: ChatScopeKey): ChatTurn[] {
  return db.all<ChatTurnRow>(`SELECT * FROM stage_chat_turns WHERE ${SCOPE_WHERE} ORDER BY turn`, scopeParams(k)).map(toTurn);
}

/**
 * Replies ready to run, oldest first: at most one per scope (the oldest), none for a scope with a reply running,
 * a rate-limited one only once `not_before` has passed.
 */
export function nextPendingTurns(db: StudioDb, now: string, limit: number): ChatTurn[] {
  return db.all<ChatTurnRow>(
    `SELECT t.* FROM stage_chat_turns t
      WHERE t.role = 'assistant'
        AND (t.status = 'pending' OR (t.status = 'rate_limited' AND t.not_before <= ?))
        AND NOT EXISTS (SELECT 1 FROM stage_chat_turns o
                         WHERE o.production_id = t.production_id AND o.episode_id IS t.episode_id AND o.run_id IS t.run_id
                           AND o.stage_key = t.stage_key AND o.role = 'assistant'
                           AND (o.status = 'running' OR (o.status IN ('pending', 'rate_limited') AND o.turn < t.turn)))
      ORDER BY t.created_at, t.turn LIMIT ?`,
    [now, limit],
  ).map(toTurn);
}

/** Takes a waiting reply; false if someone else took it first. */
export function markTurnRunning(db: StudioDb, id: string, now: string): boolean {
  return db.run(
    "UPDATE stage_chat_turns SET status = 'running', updated_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'rate_limited' AND not_before <= ?))",
    [now, id, now],
  ).changes === 1;
}

export function completeTurn(db: StudioDb, id: string, r: {
  text: string; action: ChatAction; proposal: unknown; problems: ChatProblem[]; llmCallId: string | null;
}, now: string): void {
  db.run(
    "UPDATE stage_chat_turns SET status = 'done', text = ?, action = ?, proposal = ?, problems = ?, llm_call_id = ?, not_before = NULL, updated_at = ? WHERE id = ?",
    [r.text, r.action, json(r.proposal), JSON.stringify(r.problems), r.llmCallId, now, id],
  );
}

export function failTurn(db: StudioDb, id: string, r: { text: string; problems: ChatProblem[]; llmCallId?: string | null }, now: string): void {
  db.run(
    "UPDATE stage_chat_turns SET status = 'failed', text = ?, problems = ?, llm_call_id = ?, not_before = NULL, updated_at = ? WHERE id = ?",
    [r.text, JSON.stringify(r.problems), r.llmCallId ?? null, now, id],
  );
}

/** The plan's limit was hit: the reply waits and runs again at `notBefore`. */
export function rateLimitTurn(db: StudioDb, id: string, notBefore: string, now: string): void {
  db.run("UPDATE stage_chat_turns SET status = 'rate_limited', not_before = ?, updated_at = ? WHERE id = ?", [notBefore, now, id]);
}

/** The document on show in a scope: its newest proposal, by Claude or by a manual edit. */
export function currentProposal(db: StudioDb, k: ChatScopeKey): ChatTurn | undefined {
  const r = db.get<ChatTurnRow>(`SELECT * FROM stage_chat_turns WHERE ${SCOPE_WHERE} AND proposal IS NOT NULL ORDER BY turn DESC LIMIT 1`, scopeParams(k));
  return r ? toTurn(r) : undefined;
}

export function markTurnApplied(db: StudioDb, id: string, now: string): void {
  db.run("UPDATE stage_chat_turns SET applied_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

/** Puts a reply back in line (its process stopped before it finished). */
export function requeueTurn(db: StudioDb, id: string, now: string): void {
  db.run("UPDATE stage_chat_turns SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'running'", [now, id]);
}

/** Replies marked running that hold no slot: their process died. */
export function orphanedRunningTurns(db: StudioDb, holding: readonly string[]): string[] {
  const held = new Set(holding);
  return db.all<{ id: string }>("SELECT id FROM stage_chat_turns WHERE role = 'assistant' AND status = 'running'").map((r) => r.id).filter((id) => !held.has(id));
}

/** What people said in the chat about a failed stage, oldest first: it goes into the prompt when the stage runs again. */
export function chatFeedback(db: StudioDb, runId: string, stageKey: string): string[] {
  return db.all<{ text: string }>(
    "SELECT text FROM stage_chat_turns WHERE scope = 'failed' AND role = 'user' AND run_id = ? AND stage_key = ? AND text <> '' ORDER BY turn",
    [runId, stageKey],
  ).map((r) => r.text);
}
