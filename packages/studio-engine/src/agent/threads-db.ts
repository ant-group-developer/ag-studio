/**
 * Chat threads with the agent and their messages (migration 0031, spec 2026-10-10 agent-workspace §3.2, §4).
 * A user message queues one assistant turn; messages sent before it starts join that turn (it is moved after them),
 * messages sent while it runs get the next turn. One turn runs per thread at a time (one CLI session per thread).
 */
import { randomUUID } from "node:crypto";
import type { AgentPart, AgentPhase } from "@harness/adapter-agent-cli";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import type { ChangedFile } from "../workspace/file-changes.js";

export type ThreadKind = "project" | "video";
export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "pending" | "running" | "done" | "failed" | "rate_limited" | "cancelled";
export type MessageTrigger = "user" | "job" | "action" | "autofix" | "system";
export type ActorRole = "viewer" | "editor" | "producer" | "owner";
/** Who a turn acts for: the person and their role in the team when they asked (a Studio admin counts as owner). */
export interface TurnActor { id: string; role: ActorRole }

export interface ThreadRecord {
  id: string; project_id: string; video_id: string | null; kind: ThreadKind; title: string;
  claude_session_id: string; session_started: number; session_cwd: string | null; use_lessons: number;
  created_by: string; created_at: string; updated_at: string; archived_at: string | null;
}

export interface MessageRecord {
  id: string; thread_id: string; seq: number; role: MessageRole; status: MessageStatus; text: string;
  parts: string | null; phase: string | null; attachments: string | null; trigger: MessageTrigger;
  not_before: string | null; error: string | null; cancel_requested: number; attempts: number;
  llm_call_id: string | null; cost_usd: number | null; created_by: string | null; actor_role: ActorRole | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
  /** JSON `ChangedFile[]` written after the turn (migration 0038); null before it or for turns that changed nothing yet. */
  changed_files?: string | null;
}

/** A message as the API answers it (JSON columns parsed). */
export interface MessageView {
  id: string; threadId: string; seq: number; role: MessageRole; status: MessageStatus; text: string;
  parts: AgentPart[]; phase: AgentPhase | null; attachments: string[]; trigger: MessageTrigger;
  notBefore: string | null; error: string | null; cancelRequested: boolean; costUsd: number | null;
  createdBy: string | null; actorRole: ActorRole | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
  /** The files the turn changed; null when unknown (turns before migration 0038, or not finished). */
  changedFiles: ChangedFile[] | null;
}

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

export function messageView(m: MessageRecord): MessageView {
  return {
    id: m.id, threadId: m.thread_id, seq: m.seq, role: m.role, status: m.status, text: m.text,
    parts: parse<AgentPart[]>(m.parts, []), phase: parse<AgentPhase | null>(m.phase, null), attachments: parse<string[]>(m.attachments, []),
    trigger: m.trigger, notBefore: m.not_before, error: m.error, cancelRequested: m.cancel_requested === 1, costUsd: m.cost_usd,
    createdBy: m.created_by, actorRole: m.actor_role, startedAt: m.started_at, finishedAt: m.finished_at, createdAt: m.created_at, updatedAt: m.updated_at,
    changedFiles: parse<ChangedFile[] | null>(m.changed_files ?? null, null),
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export function createThread(db: StudioDb, p: { projectId: string; videoId?: string | null; kind: ThreadKind; title: string; createdBy: string; useLessons?: boolean }, now = new Date().toISOString()): ThreadRecord {
  const id = randomUUID();
  db.run(
    `INSERT INTO agent_threads (id, project_id, video_id, kind, title, claude_session_id, use_lessons, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.projectId, p.videoId ?? null, p.kind, p.title, randomUUID(), p.useLessons === false ? 0 : 1, p.createdBy, now, now],
  );
  return getThread(db, id)!;
}

export function getThread(db: StudioDb, id: string): ThreadRecord | undefined {
  return db.get<ThreadRecord>("SELECT * FROM agent_threads WHERE id = ?", [id]);
}

export function requireThread(db: StudioDb, id: string): ThreadRecord {
  const t = getThread(db, id);
  if (!t) throw new StudioRunError("not_found", `luồng chat ${id} không tồn tại`);
  return t;
}

/** The video's main thread, made on first use. */
export function videoThread(db: StudioDb, p: { projectId: string; videoId: string; title: string; createdBy: string }, now = new Date().toISOString()): ThreadRecord {
  const found = db.get<ThreadRecord>("SELECT * FROM agent_threads WHERE video_id = ? AND kind = 'video' AND archived_at IS NULL", [p.videoId]);
  return found ?? createThread(db, { projectId: p.projectId, videoId: p.videoId, kind: "video", title: p.title, createdBy: p.createdBy }, now);
}

export interface ThreadListRow extends ThreadRecord {
  message_count: number;
  last_message_at: string | null;
  running: number;
}

/** A project's threads (or one video's), most recently active first. */
export function listThreads(db: StudioDb, projectId: string, opts: { videoId?: string; archived?: boolean } = {}): ThreadListRow[] {
  const where = ["t.project_id = ?", "(t.archived_at IS NOT NULL) = ?"];
  const params: (string | number)[] = [projectId, opts.archived ? 1 : 0];
  if (opts.videoId) { where.push("t.video_id = ?"); params.push(opts.videoId); }
  return db.all<ThreadListRow>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM agent_messages m WHERE m.thread_id = t.id) AS message_count,
            (SELECT MAX(m.created_at) FROM agent_messages m WHERE m.thread_id = t.id) AS last_message_at,
            (SELECT COUNT(*) FROM agent_messages m WHERE m.thread_id = t.id AND m.status IN ('pending', 'running')) AS running
       FROM agent_threads t WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(last_message_at, t.created_at) DESC`,
    params,
  );
}

export function renameThread(db: StudioDb, id: string, title: string, now = new Date().toISOString()): ThreadRecord {
  requireThread(db, id);
  db.run("UPDATE agent_threads SET title = ?, updated_at = ? WHERE id = ?", [title, now, id]);
  return requireThread(db, id);
}

export function archiveThread(db: StudioDb, id: string, now = new Date().toISOString()): void {
  requireThread(db, id);
  db.run("UPDATE agent_threads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

/** After a turn ran in the session: later turns `--resume` it. */
export function markSessionStarted(db: StudioDb, threadId: string, cwd: string): void {
  db.run("UPDATE agent_threads SET session_started = 1, session_cwd = ? WHERE id = ?", [cwd, threadId]);
}

/** The CLI lost the session: the next turn starts a new one (with a recap of the thread). */
export function resetSession(db: StudioDb, threadId: string): string {
  const id = randomUUID();
  db.run("UPDATE agent_threads SET claude_session_id = ?, session_started = 0, session_cwd = NULL WHERE id = ?", [id, threadId]);
  return id;
}

// ---------------------------------------------------------------------------
// Thread references (learning from earlier chats)
// ---------------------------------------------------------------------------

export interface ThreadRef { ref_thread_id: string; mode: "summary" | "full"; title: string; video_id: string | null }

export function setThreadRef(db: StudioDb, p: { threadId: string; refThreadId: string; mode: "summary" | "full"; addedBy: string }, now = new Date().toISOString()): void {
  const t = requireThread(db, p.threadId);
  const ref = requireThread(db, p.refThreadId);
  if (ref.project_id !== t.project_id) throw new StudioRunError("invalid", "chỉ học được từ luồng cùng dự án", { code: "other_project" });
  if (ref.id === t.id) throw new StudioRunError("invalid", "một luồng không học từ chính nó", { code: "self_ref" });
  db.run(
    `INSERT INTO thread_refs (thread_id, ref_thread_id, mode, added_by, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, ref_thread_id) DO UPDATE SET mode = excluded.mode`,
    [p.threadId, p.refThreadId, p.mode, p.addedBy, now],
  );
}

export function removeThreadRef(db: StudioDb, threadId: string, refThreadId: string): void {
  db.run("DELETE FROM thread_refs WHERE thread_id = ? AND ref_thread_id = ?", [threadId, refThreadId]);
}

/**
 * What a thread learns from earlier chats (spec agent-workspace §4): the project's lessons or not, and the earlier
 * threads it reads (each as a summary or the full history). Replaces what was set before.
 */
export function setThreadLearning(db: StudioDb, p: { threadId: string; useLessons: boolean; refs: { threadId: string; mode: "summary" | "full" }[]; addedBy: string }, now = new Date().toISOString()): void {
  db.immediate(() => {
    db.run("UPDATE agent_threads SET use_lessons = ?, updated_at = ? WHERE id = ?", [p.useLessons ? 1 : 0, now, p.threadId]);
    db.run("DELETE FROM thread_refs WHERE thread_id = ?", [p.threadId]);
    for (const r of p.refs) setThreadRef(db, { threadId: p.threadId, refThreadId: r.threadId, mode: r.mode, addedBy: p.addedBy }, now);
  });
}

export function listThreadRefs(db: StudioDb, threadId: string): ThreadRef[] {
  return db.all<ThreadRef>(
    `SELECT r.ref_thread_id, r.mode, t.title, t.video_id FROM thread_refs r JOIN agent_threads t ON t.id = r.ref_thread_id
      WHERE r.thread_id = ? ORDER BY r.added_at`,
    [threadId],
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const nextSeq = (db: StudioDb, threadId: string) => (db.get<{ n: number | null }>("SELECT MAX(seq) AS n FROM agent_messages WHERE thread_id = ?", [threadId])?.n ?? 0) + 1;

function insertMessage(db: StudioDb, p: {
  threadId: string; role: MessageRole; status: MessageStatus; text?: string; attachments?: string[]; trigger?: MessageTrigger; actor?: TurnActor | null; now: string;
}): MessageRecord {
  const id = randomUUID();
  db.run(
    `INSERT INTO agent_messages (id, thread_id, seq, role, status, text, attachments, trigger, created_by, actor_role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.threadId, nextSeq(db, p.threadId), p.role, p.status, p.text ?? "", p.attachments?.length ? JSON.stringify(p.attachments) : null,
      p.trigger ?? "user", p.actor?.id ?? null, p.actor?.role ?? null, p.now, p.now],
  );
  return db.get<MessageRecord>("SELECT * FROM agent_messages WHERE id = ?", [id])!;
}

/** A turn waiting to start is moved after `upTo` so it answers that message too. Answers the waiting turn, if any. */
function queueTurn(db: StudioDb, threadId: string, trigger: MessageTrigger, actor: TurnActor | null, now: string): MessageRecord | null {
  const running = db.get("SELECT 1 FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND status = 'running'", [threadId]);
  db.run("DELETE FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND status IN ('pending', 'rate_limited') AND started_at IS NULL", [threadId]);
  if (running) return null; // the follow-up turn is queued when the running one finishes
  return insertMessage(db, { threadId, role: "assistant", status: "pending", trigger, actor, now });
}

/** A person's message, and the turn that will answer it. 409 `thread_archived` on an archived thread. */
export function postUserMessage(db: StudioDb, p: { threadId: string; text: string; attachments?: string[]; actor: TurnActor }, now = new Date().toISOString()): { user: MessageRecord; turn: MessageRecord | null } {
  return db.immediate(() => {
    const t = requireThread(db, p.threadId);
    if (t.archived_at) throw new StudioRunError("conflict", "luồng đã lưu trữ", { code: "thread_archived" });
    const user = insertMessage(db, { threadId: p.threadId, role: "user", status: "done", text: p.text, attachments: p.attachments ?? [], actor: p.actor, now });
    const turn = queueTurn(db, p.threadId, "user", p.actor, now);
    db.run("UPDATE agent_threads SET updated_at = ? WHERE id = ?", [now, p.threadId]);
    return { user, turn };
  });
}

/**
 * A note from Studio (a job finished, an action ran); with `continueAgent` the agent gets a turn to act on it, for
 * `actor` (the person who started the job or confirmed the action).
 */
export function postSystemMessage(db: StudioDb, p: { threadId: string; text: string; trigger: MessageTrigger; continueAgent?: boolean; actor?: TurnActor | null }, now = new Date().toISOString()): { system: MessageRecord; turn: MessageRecord | null } {
  return db.immediate(() => {
    const system = insertMessage(db, { threadId: p.threadId, role: "system", status: "done", text: p.text, trigger: p.trigger, now });
    const turn = p.continueAgent ? queueTurn(db, p.threadId, p.trigger, p.actor ?? null, now) : null;
    return { system, turn };
  });
}

export function getMessage(db: StudioDb, id: string): MessageRecord | undefined {
  return db.get<MessageRecord>("SELECT * FROM agent_messages WHERE id = ?", [id]);
}

export function listMessages(db: StudioDb, threadId: string, opts: { afterSeq?: number; limit?: number } = {}): MessageRecord[] {
  return db.all<MessageRecord>(
    "SELECT * FROM agent_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    [threadId, opts.afterSeq ?? 0, opts.limit ?? 500],
  );
}

/** What a turn answers: the user and system messages since the thread's previous turn. */
export function turnInput(db: StudioDb, turn: MessageRecord): MessageRecord[] {
  const prev = db.get<{ seq: number }>(
    "SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND seq < ? AND status <> 'pending'",
    [turn.thread_id, turn.seq],
  )?.seq ?? 0;
  return db.all<MessageRecord>(
    "SELECT * FROM agent_messages WHERE thread_id = ? AND role IN ('user', 'system') AND seq > ? AND seq < ? ORDER BY seq",
    [turn.thread_id, prev, turn.seq],
  );
}

/** Turns ready to run: the oldest waiting one of each thread that has none running, past its `not_before`. */
export function nextPendingAgentTurns(db: StudioDb, now: string, limit: number): MessageRecord[] {
  return db.all<MessageRecord>(
    `SELECT m.* FROM agent_messages m
      WHERE m.role = 'assistant' AND m.status IN ('pending', 'rate_limited') AND (m.not_before IS NULL OR m.not_before <= ?)
        AND m.seq = (SELECT MIN(x.seq) FROM agent_messages x WHERE x.thread_id = m.thread_id AND x.role = 'assistant' AND x.status IN ('pending', 'rate_limited'))
        AND NOT EXISTS (SELECT 1 FROM agent_messages r WHERE r.thread_id = m.thread_id AND r.status = 'running')
      ORDER BY m.created_at LIMIT ?`,
    [now, limit],
  );
}

/** Pending → running, unless another worker took it first. */
export function markAgentTurnRunning(db: StudioDb, id: string, now: string): boolean {
  return db.run(
    "UPDATE agent_messages SET status = 'running', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'rate_limited')",
    [now, now, id],
  ).changes === 1;
}

/** What the running turn has said and done so far. */
export function updateRunningTurn(db: StudioDb, id: string, p: { text: string; parts: AgentPart[]; phase: AgentPhase }, now: string): void {
  db.run("UPDATE agent_messages SET text = ?, parts = ?, phase = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    [p.text, JSON.stringify(p.parts), JSON.stringify(p.phase), now, id]);
}

export function finishTurn(db: StudioDb, id: string, p: {
  status: Exclude<MessageStatus, "pending" | "running">; text: string; parts: AgentPart[]; error?: string | null;
  costUsd?: number | null; llmCallId?: string | null; notBefore?: string | null;
}, now: string): void {
  db.run(
    `UPDATE agent_messages SET status = ?, text = ?, parts = ?, phase = NULL, error = ?, cost_usd = COALESCE(cost_usd, 0) + COALESCE(?, 0),
            llm_call_id = COALESCE(?, llm_call_id), not_before = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [p.status, p.text, JSON.stringify(p.parts), p.error ?? null, p.costUsd ?? null, p.llmCallId ?? null, p.notBefore ?? null,
      p.status === "rate_limited" ? null : now, now, id],
  );
}

/** After a turn: the files it changed (`turnChangedFiles`), shown under its answer. */
export function setTurnChangedFiles(db: StudioDb, id: string, files: ChangedFile[], now: string): void {
  db.run("UPDATE agent_messages SET changed_files = ?, updated_at = ? WHERE id = ?", [JSON.stringify(files), now, id]);
}

/** A turn a stopped worker left running goes back in line (it resumes its session, it does not start over). */
export function requeueAgentTurn(db: StudioDb, id: string, now: string): void {
  db.run("UPDATE agent_messages SET status = 'pending', phase = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [now, id]);
}

/** Running turns that no live process holds a slot for (their worker stopped). */
export function orphanedAgentTurns(db: StudioDb, live: string[]): string[] {
  const rows = db.all<{ id: string }>("SELECT id FROM agent_messages WHERE role = 'assistant' AND status = 'running'");
  const alive = new Set(live);
  return rows.map((r) => r.id).filter((id) => !alive.has(id));
}

/** Stop: a waiting turn is cancelled now; a running one is asked to stop (the runner kills it). */
export function requestCancel(db: StudioDb, id: string, now = new Date().toISOString()): MessageRecord {
  const m = getMessage(db, id);
  if (!m || m.role !== "assistant") throw new StudioRunError("not_found", `không có lượt ${id}`);
  if (m.status === "pending" || m.status === "rate_limited") {
    db.run("UPDATE agent_messages SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  } else if (m.status === "running") {
    db.run("UPDATE agent_messages SET cancel_requested = 1, updated_at = ? WHERE id = ?", [now, id]);
  }
  return getMessage(db, id)!;
}

export function cancelRequested(db: StudioDb, id: string): boolean {
  return db.get<{ c: number }>("SELECT cancel_requested AS c FROM agent_messages WHERE id = ?", [id])?.c === 1;
}

/** After a turn: messages that came in while it ran get the next turn. */
export function queueFollowUp(db: StudioDb, threadId: string, now: string): MessageRecord | null {
  return db.immediate(() => {
    const lastTurn = db.get<{ seq: number }>("SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'assistant'", [threadId])?.seq ?? 0;
    const waiting = db.get<{ created_by: string | null; actor_role: ActorRole | null }>(
      "SELECT created_by, actor_role FROM agent_messages WHERE thread_id = ? AND role = 'user' AND seq > ? ORDER BY seq DESC LIMIT 1", [threadId, lastTurn]);
    if (!waiting) return null;
    const actor = waiting.created_by && waiting.actor_role ? { id: waiting.created_by, role: waiting.actor_role } : null;
    return insertMessage(db, { threadId, role: "assistant", status: "pending", trigger: "user", actor, now });
  });
}

/** Turns started by jobs or actions in a row since the last person's message (auto-continue stops at a few). */
export function automaticTurnsInARow(db: StudioDb, threadId: string): number {
  const lastUser = db.get<{ seq: number }>("SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'user'", [threadId])?.seq ?? 0;
  return db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND seq > ? AND trigger <> 'user'",
    [threadId, lastUser],
  )?.n ?? 0;
}
