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
export type MessageTrigger = "user" | "job" | "action" | "autofix" | "system" | "timeout";
export type ActorRole = "viewer" | "editor" | "producer" | "owner";
/** Who a turn acts for: the person and their role in the team when they asked (a Studio admin counts as owner). */
export interface TurnActor { id: string; role: ActorRole }

export interface ThreadRecord {
  id: string; project_id: string; video_id: string | null; kind: ThreadKind; title: string;
  claude_session_id: string; session_started: boolean; session_cwd: string | null; use_lessons: boolean;
  created_by: string; created_at: string; updated_at: string; archived_at: string | null;
}

export interface MessageRecord {
  id: string; thread_id: string; seq: number; role: MessageRole; status: MessageStatus; text: string;
  parts: AgentPart[] | null; phase: AgentPhase | null; attachments: string[] | null; trigger: MessageTrigger;
  not_before: string | null; error: string | null; cancel_requested: boolean; attempts: number;
  llm_call_id: string | null; cost_usd: number | null; created_by: string | null; actor_role: ActorRole | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
  /** `ChangedFile[]` written after the turn (migration 0038); null before it or for turns that changed nothing yet. */
  changed_files?: ChangedFile[] | null;
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

export function messageView(m: MessageRecord): MessageView {
  return {
    id: m.id, threadId: m.thread_id, seq: m.seq, role: m.role, status: m.status, text: m.text,
    parts: Array.isArray(m.parts) ? m.parts : [], phase: m.phase ?? null, attachments: Array.isArray(m.attachments) ? m.attachments : [],
    trigger: m.trigger, notBefore: m.not_before, error: m.error, cancelRequested: m.cancel_requested === true, costUsd: m.cost_usd,
    createdBy: m.created_by, actorRole: m.actor_role, startedAt: m.started_at, finishedAt: m.finished_at, createdAt: m.created_at, updatedAt: m.updated_at,
    changedFiles: Array.isArray(m.changed_files) ? m.changed_files : null,
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export async function createThread(db: StudioDb, p: { projectId: string; videoId?: string | null; kind: ThreadKind; title: string; createdBy: string; useLessons?: boolean }, now = new Date().toISOString()): Promise<ThreadRecord> {
  return (await db.get<ThreadRecord>(
    `INSERT INTO agent_threads (id, project_id, video_id, kind, title, claude_session_id, use_lessons, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [randomUUID(), p.projectId, p.videoId ?? null, p.kind, p.title, randomUUID(), p.useLessons !== false, p.createdBy, now, now],
  ))!;
}

export async function getThread(db: StudioDb, id: string): Promise<ThreadRecord | undefined> {
  return db.get<ThreadRecord>("SELECT * FROM agent_threads WHERE id = ?", [id]);
}

export async function requireThread(db: StudioDb, id: string): Promise<ThreadRecord> {
  const t = await getThread(db, id);
  if (!t) throw new StudioRunError("not_found", `luồng chat ${id} không tồn tại`);
  return t;
}

/** The video's main thread, made on first use. */
export async function videoThread(db: StudioDb, p: { projectId: string; videoId: string; title: string; createdBy: string }, now = new Date().toISOString()): Promise<ThreadRecord> {
  return db.tx(async () => {
    const found = await db.get<ThreadRecord>("SELECT * FROM agent_threads WHERE video_id = ? AND kind = 'video' AND archived_at IS NULL", [p.videoId]);
    return found ?? createThread(db, { projectId: p.projectId, videoId: p.videoId, kind: "video", title: p.title, createdBy: p.createdBy }, now);
  });
}

export interface ThreadListRow extends ThreadRecord {
  message_count: number;
  last_message_at: string | null;
  running: number;
}

/** A project's threads (or one video's), most recently active first. */
export async function listThreads(db: StudioDb, projectId: string, opts: { videoId?: string; archived?: boolean } = {}): Promise<ThreadListRow[]> {
  const where = ["t.project_id = ?", "(t.archived_at IS NOT NULL) = ?"];
  const params: (string | boolean)[] = [projectId, opts.archived === true];
  if (opts.videoId) { where.push("t.video_id = ?"); params.push(opts.videoId); }
  return db.all<ThreadListRow>(
    `SELECT * FROM (
       SELECT t.*,
              (SELECT COUNT(*) FROM agent_messages m WHERE m.thread_id = t.id) AS message_count,
              (SELECT MAX(m.created_at) FROM agent_messages m WHERE m.thread_id = t.id) AS last_message_at,
              (SELECT COUNT(*) FROM agent_messages m WHERE m.thread_id = t.id AND m.status IN ('pending', 'running')) AS running
         FROM agent_threads t WHERE ${where.join(" AND ")}
     ) x ORDER BY COALESCE(x.last_message_at, x.created_at) DESC`,
    params,
  );
}

export async function renameThread(db: StudioDb, id: string, title: string, now = new Date().toISOString()): Promise<ThreadRecord> {
  await requireThread(db, id);
  await db.run("UPDATE agent_threads SET title = ?, updated_at = ? WHERE id = ?", [title, now, id]);
  return requireThread(db, id);
}

export async function archiveThread(db: StudioDb, id: string, now = new Date().toISOString()): Promise<void> {
  await requireThread(db, id);
  await db.run("UPDATE agent_threads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

/** After a turn ran in the session: later turns `--resume` it. */
export async function markSessionStarted(db: StudioDb, threadId: string, cwd: string): Promise<void> {
  await db.run("UPDATE agent_threads SET session_started = true, session_cwd = ? WHERE id = ?", [cwd, threadId]);
}

/** The CLI lost the session: the next turn starts a new one (with a recap of the thread). */
export async function resetSession(db: StudioDb, threadId: string): Promise<string> {
  const id = randomUUID();
  await db.run("UPDATE agent_threads SET claude_session_id = ?, session_started = false, session_cwd = NULL WHERE id = ?", [id, threadId]);
  return id;
}

// ---------------------------------------------------------------------------
// Thread references (learning from earlier chats)
// ---------------------------------------------------------------------------

export interface ThreadRef { ref_thread_id: string; mode: "summary" | "full"; title: string; video_id: string | null }

export async function setThreadRef(db: StudioDb, p: { threadId: string; refThreadId: string; mode: "summary" | "full"; addedBy: string }, now = new Date().toISOString()): Promise<void> {
  const t = await requireThread(db, p.threadId);
  const ref = await requireThread(db, p.refThreadId);
  if (ref.project_id !== t.project_id) throw new StudioRunError("invalid", "chỉ học được từ luồng cùng dự án", { code: "other_project" });
  if (ref.id === t.id) throw new StudioRunError("invalid", "một luồng không học từ chính nó", { code: "self_ref" });
  await db.run(
    `INSERT INTO thread_refs (thread_id, ref_thread_id, mode, added_by, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, ref_thread_id) DO UPDATE SET mode = excluded.mode`,
    [p.threadId, p.refThreadId, p.mode, p.addedBy, now],
  );
}

export async function removeThreadRef(db: StudioDb, threadId: string, refThreadId: string): Promise<void> {
  await db.run("DELETE FROM thread_refs WHERE thread_id = ? AND ref_thread_id = ?", [threadId, refThreadId]);
}

/**
 * What a thread learns from earlier chats (spec agent-workspace §4): the project's lessons or not, and the earlier
 * threads it reads (each as a summary or the full history). Replaces what was set before.
 */
export async function setThreadLearning(db: StudioDb, p: { threadId: string; useLessons: boolean; refs: { threadId: string; mode: "summary" | "full" }[]; addedBy: string }, now = new Date().toISOString()): Promise<void> {
  await db.tx(async () => {
    await db.run("UPDATE agent_threads SET use_lessons = ?, updated_at = ? WHERE id = ?", [p.useLessons, now, p.threadId]);
    await db.run("DELETE FROM thread_refs WHERE thread_id = ?", [p.threadId]);
    for (const r of p.refs) await setThreadRef(db, { threadId: p.threadId, refThreadId: r.threadId, mode: r.mode, addedBy: p.addedBy }, now);
  });
}

export async function listThreadRefs(db: StudioDb, threadId: string): Promise<ThreadRef[]> {
  return db.all<ThreadRef>(
    `SELECT r.ref_thread_id, r.mode, t.title, t.video_id FROM thread_refs r JOIN agent_threads t ON t.id = r.ref_thread_id
      WHERE r.thread_id = ? ORDER BY r.added_at`,
    [threadId],
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The next `seq` of the thread is taken in the INSERT; callers run it in `tx` so two messages never race for one. */
async function insertMessage(db: StudioDb, p: {
  threadId: string; role: MessageRole; status: MessageStatus; text?: string; attachments?: string[]; trigger?: MessageTrigger; actor?: TurnActor | null; now: string;
}): Promise<MessageRecord> {
  return (await db.get<MessageRecord>(
    `INSERT INTO agent_messages (id, thread_id, seq, role, status, text, attachments, trigger, created_by, actor_role, created_at, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_messages WHERE thread_id = ?), ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?) RETURNING *`,
    [randomUUID(), p.threadId, p.threadId, p.role, p.status, p.text ?? "", p.attachments?.length ? JSON.stringify(p.attachments) : null,
      p.trigger ?? "user", p.actor?.id ?? null, p.actor?.role ?? null, p.now, p.now],
  ))!;
}

/** A turn waiting to start is moved after `upTo` so it answers that message too. Answers the waiting turn, if any. */
async function queueTurn(db: StudioDb, threadId: string, trigger: MessageTrigger, actor: TurnActor | null, now: string): Promise<MessageRecord | null> {
  const running = await db.get("SELECT 1 FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND status = 'running'", [threadId]);
  await db.run("DELETE FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND status IN ('pending', 'rate_limited') AND started_at IS NULL", [threadId]);
  if (running) return null; // the follow-up turn is queued when the running one finishes
  return insertMessage(db, { threadId, role: "assistant", status: "pending", trigger, actor, now });
}

/** A person's message, and the turn that will answer it. 409 `thread_archived` on an archived thread. */
export async function postUserMessage(db: StudioDb, p: { threadId: string; text: string; attachments?: string[]; actor: TurnActor }, now = new Date().toISOString()): Promise<{ user: MessageRecord; turn: MessageRecord | null }> {
  return db.tx(async () => {
    const t = await requireThread(db, p.threadId);
    if (t.archived_at) throw new StudioRunError("conflict", "luồng đã lưu trữ", { code: "thread_archived" });
    const user = await insertMessage(db, { threadId: p.threadId, role: "user", status: "done", text: p.text, attachments: p.attachments ?? [], actor: p.actor, now });
    const turn = await queueTurn(db, p.threadId, "user", p.actor, now);
    await db.run("UPDATE agent_threads SET updated_at = ? WHERE id = ?", [now, p.threadId]);
    return { user, turn };
  });
}

/**
 * A note from Studio (a job finished, an action ran); with `continueAgent` the agent gets a turn to act on it, for
 * `actor` (the person who started the job or confirmed the action).
 */
export async function postSystemMessage(db: StudioDb, p: { threadId: string; text: string; trigger: MessageTrigger; continueAgent?: boolean; actor?: TurnActor | null }, now = new Date().toISOString()): Promise<{ system: MessageRecord; turn: MessageRecord | null }> {
  return db.tx(async () => {
    const system = await insertMessage(db, { threadId: p.threadId, role: "system", status: "done", text: p.text, trigger: p.trigger, now });
    const turn = p.continueAgent ? await queueTurn(db, p.threadId, p.trigger, p.actor ?? null, now) : null;
    return { system, turn };
  });
}

export async function getMessage(db: StudioDb, id: string): Promise<MessageRecord | undefined> {
  return db.get<MessageRecord>("SELECT * FROM agent_messages WHERE id = ?", [id]);
}

export async function listMessages(db: StudioDb, threadId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<MessageRecord[]> {
  return db.all<MessageRecord>(
    "SELECT * FROM agent_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    [threadId, opts.afterSeq ?? 0, opts.limit ?? 500],
  );
}

/** What a turn answers: the user and system messages since the thread's previous turn. */
export async function turnInput(db: StudioDb, turn: MessageRecord): Promise<MessageRecord[]> {
  const prev = (await db.get<{ seq: number | null }>(
    "SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND seq < ? AND status <> 'pending'",
    [turn.thread_id, turn.seq],
  ))?.seq ?? 0;
  return db.all<MessageRecord>(
    "SELECT * FROM agent_messages WHERE thread_id = ? AND role IN ('user', 'system') AND seq > ? AND seq < ? ORDER BY seq",
    [turn.thread_id, prev, turn.seq],
  );
}

/** Turns ready to run: the oldest waiting one of each thread that has none running, past its `not_before`. */
export async function nextPendingAgentTurns(db: StudioDb, now: string, limit: number): Promise<MessageRecord[]> {
  return db.all<MessageRecord>(
    `SELECT m.* FROM agent_messages m
      WHERE m.role = 'assistant' AND m.status IN ('pending', 'rate_limited') AND (m.not_before IS NULL OR m.not_before <= ?)
        AND m.seq = (SELECT MIN(x.seq) FROM agent_messages x WHERE x.thread_id = m.thread_id AND x.role = 'assistant' AND x.status IN ('pending', 'rate_limited'))
        AND NOT EXISTS (SELECT 1 FROM agent_messages r WHERE r.thread_id = m.thread_id AND r.status = 'running')
      ORDER BY m.created_at LIMIT ?`,
    [now, limit],
  );
}

/** Pending → running, unless another worker took it first (or a message replaced it). */
export async function markAgentTurnRunning(db: StudioDb, id: string, now: string): Promise<boolean> {
  return db.tx(async () => (await db.run(
    "UPDATE agent_messages SET status = 'running', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'rate_limited')",
    [now, now, id],
  )).changes === 1);
}

/** What the running turn has said and done so far. */
export async function updateRunningTurn(db: StudioDb, id: string, p: { text: string; parts: AgentPart[]; phase: AgentPhase }, now: string): Promise<void> {
  await db.run("UPDATE agent_messages SET text = ?, parts = ?, phase = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    [p.text, JSON.stringify(p.parts), JSON.stringify(p.phase), now, id]);
}

export async function finishTurn(db: StudioDb, id: string, p: {
  status: Exclude<MessageStatus, "pending" | "running">; text: string; parts: AgentPart[]; error?: string | null;
  costUsd?: number | null; llmCallId?: string | null; notBefore?: string | null;
}, now: string): Promise<void> {
  await db.run(
    `UPDATE agent_messages SET status = ?, text = ?, parts = ?, phase = NULL, error = ?, cost_usd = COALESCE(cost_usd, 0) + COALESCE(?::double precision, 0),
            llm_call_id = COALESCE(?, llm_call_id), not_before = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [p.status, p.text, JSON.stringify(p.parts), p.error ?? null, p.costUsd ?? null, p.llmCallId ?? null, p.notBefore ?? null,
      p.status === "rate_limited" ? null : now, now, id],
  );
}

/** After a turn: the files it changed (`turnChangedFiles`), shown under its answer. */
export async function setTurnChangedFiles(db: StudioDb, id: string, files: ChangedFile[], now: string): Promise<void> {
  await db.run("UPDATE agent_messages SET changed_files = ?, updated_at = ? WHERE id = ?", [JSON.stringify(files), now, id]);
}

/** A turn a stopped worker left running goes back in line (it resumes its session, it does not start over). */
export async function requeueAgentTurn(db: StudioDb, id: string, now: string): Promise<void> {
  await db.run("UPDATE agent_messages SET status = 'pending', phase = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [now, id]);
}

/** Running turns that no live process holds a slot for (their worker stopped). */
export async function orphanedAgentTurns(db: StudioDb, live: string[]): Promise<string[]> {
  const rows = await db.all<{ id: string }>("SELECT id FROM agent_messages WHERE role = 'assistant' AND status = 'running'");
  const alive = new Set(live);
  return rows.map((r) => r.id).filter((id) => !alive.has(id));
}

/** Stop: a waiting turn is cancelled now; a running one is asked to stop (the runner kills it). */
export async function requestCancel(db: StudioDb, id: string, now = new Date().toISOString()): Promise<MessageRecord> {
  return db.tx(async () => {
    const m = await getMessage(db, id);
    if (!m || m.role !== "assistant") throw new StudioRunError("not_found", `không có lượt ${id}`);
    if (m.status === "pending" || m.status === "rate_limited") {
      await db.run("UPDATE agent_messages SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    } else if (m.status === "running") {
      await db.run("UPDATE agent_messages SET cancel_requested = true, updated_at = ? WHERE id = ?", [now, id]);
    }
    return (await getMessage(db, id))!;
  });
}

export async function cancelRequested(db: StudioDb, id: string): Promise<boolean> {
  return (await db.get<{ c: boolean }>("SELECT cancel_requested AS c FROM agent_messages WHERE id = ?", [id]))?.c === true;
}

/** After a turn: messages that came in while it ran get the next turn. */
export async function queueFollowUp(db: StudioDb, threadId: string, now: string): Promise<MessageRecord | null> {
  return db.tx(async () => {
    const lastTurn = (await db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'assistant'", [threadId]))?.seq ?? 0;
    const waiting = await db.get<{ created_by: string | null; actor_role: ActorRole | null }>(
      "SELECT created_by, actor_role FROM agent_messages WHERE thread_id = ? AND role = 'user' AND seq > ? ORDER BY seq DESC LIMIT 1", [threadId, lastTurn]);
    if (!waiting) return null;
    const actor = waiting.created_by && waiting.actor_role ? { id: waiting.created_by, role: waiting.actor_role } : null;
    return insertMessage(db, { threadId, role: "assistant", status: "pending", trigger: "user", actor, now });
  });
}

/** How many turns jobs, actions or a timed out turn may start in a row before a person speaks again. */
export const AUTO_TURNS_IN_A_ROW = 3;

/** Turns started by jobs or actions in a row since the last person's message (auto-continue stops at a few). */
export async function automaticTurnsInARow(db: StudioDb, threadId: string): Promise<number> {
  const lastUser = (await db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM agent_messages WHERE thread_id = ? AND role = 'user'", [threadId]))?.seq ?? 0;
  return (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = 'assistant' AND seq > ? AND trigger <> 'user'",
    [threadId, lastUser],
  ))?.n ?? 0;
}
