/**
 * What a person does from the chat (spec local-chat §2, §3.1): start a video with one message, send a message, apply
 * a proposal (intake, timeline), start the series, approve the document on show. The API calls these; they check
 * the scope again so a stale screen cannot approve or apply the wrong thing.
 */
import { randomUUID } from "node:crypto";
import { intakeMissing, IntakeDraftSchema, type IntakeDraft, type IntakeField } from "@harness/contracts";
import { chatContext, chatScopeFor, DRAFT_PRODUCTION_TITLE, GATE_SOURCES, type TimelineProposal } from "./chat-context.js";
import {
  currentProposal, getTurn, insertSystemTurn, insertUserTurn, listTurns,
  markTurnApplied, type ChatMention, type ChatProblem, type ChatScopeKey, type ChatTurn,
} from "./chat-db.js";
import type { StudioEngineCore } from "./core.js";
import { latestAcceptedCall, recordHumanEdit, type HumanEditKind } from "./llm-log.js";
import { startPlanRun, StudioRunError, submitEpisodeTimelineGate, submitStudioGate } from "./run-control.js";
import { getProduction, saveEpisodeRevision, type StudioDb } from "./studio-db.js";

/** `@[Kyoto 2025](folder:<id>)` in a message: the folders it names. */
export function messageMentions(text: string): ChatMention[] {
  const out: ChatMention[] = [];
  for (const m of text.matchAll(/@\[([^\]\n]{1,200})\]\(folder:([^)\s]{1,200})\)/g)) {
    if (!out.some((x) => x.id === m[2])) out.push({ kind: "folder", id: m[2]!, name: m[1]! });
  }
  return out;
}

/** A production that exists only as a chat: it has a team and an owner, everything else comes from the intake. */
export function createDraftProduction(db: StudioDb, teamId: string, ownerUserId: string, now: string): string {
  const id = randomUUID();
  db.run(
    "INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, language) VALUES (?, ?, ?, 'draft', ?, ?, ?, 'vi')",
    [id, teamId, DRAFT_PRODUCTION_TITLE, now, now, ownerUserId],
  );
  return id;
}

export interface SendChatMessage {
  productionId: string;
  episodeId?: string | null;
  text: string;
  userId: string;
  /** Snapshot sent along (the ag-go folders the person sees, for the intake). */
  context?: unknown;
}

/** A person's message, to the scope the production (or episode) is at now; Claude's reply waits in line. */
export function sendChatMessage(core: StudioEngineCore, db: StudioDb, m: SendChatMessage): { key: ChatScopeKey; user: ChatTurn; assistant: ChatTurn | null } {
  const text = m.text.trim();
  if (!text) throw new StudioRunError("invalid", "tin nhắn trống");
  const key = chatScopeFor(core, db, m.productionId, m.episodeId ?? null);
  const r = insertUserTurn(db, key, { text, createdBy: m.userId, mentions: messageMentions(text), context: m.context }, core.clock.now());
  return { key, ...r };
}

/** A version written by hand (⋯ → Sửa tay): it becomes the document on show; Claude is not asked anything. */
export function saveManualEdit(core: StudioEngineCore, db: StudioDb, p: { productionId: string; episodeId?: string | null; stageKey: string; document: unknown; userId: string }): ChatTurn {
  const key = chatScopeFor(core, db, p.productionId, p.episodeId ?? null);
  if (key.stageKey !== p.stageKey || (key.scope !== "gate" && key.scope !== "intake")) {
    throw new StudioRunError("conflict", `bước ${p.stageKey} không còn chờ duyệt`, { code: "stale_step", stage: key.stageKey });
  }
  const ctx = chatContext(core, db, key);
  if (ctx.skill === "studio-timeline") throw new StudioRunError("invalid", "timeline được sửa tay trong editor");
  const parsed = ctx.proposalSchema.safeParse(p.document);
  if (!parsed.success) throw new StudioRunError("rejected", "tài liệu không hợp lệ", { failed: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) });
  return insertUserTurn(db, key, { text: "Sửa tay", createdBy: p.userId, proposal: parsed.data, ask: false }, core.clock.now()).user;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const list = (v: string[]) => (v.length ? JSON.stringify(v) : null);

/** Writes an intake draft into the production (before its run): title, folders, channels, keywords, format, hints. */
function writeIntake(db: StudioDb, productionId: string, d: IntakeDraft, now: string): void {
  db.immediate(() => {
    db.run(
      `UPDATE productions SET title = ?, aspect = ?, language = ?, keywords = ?, own_channels = ?, youtube_channels = ?,
         brief = ?, goal = ?, audience = ?, tone = ?, notes = ?, episode_target_seconds = ?, max_episodes = ?, updated_at = ? WHERE id = ?`,
      [d.title ?? DRAFT_PRODUCTION_TITLE, d.aspect, d.language, list(d.keywords),
        list(d.channels.filter((c) => c.role === "own").map((c) => c.url)), list(d.channels.filter((c) => c.role === "reference").map((c) => c.url)),
        d.hints.description || null, d.hints.goal || null, d.hints.audience || null, d.hints.tone || null, d.hints.notes || null,
        d.hints.episode_target_seconds, d.hints.max_episodes, now, productionId],
    );
    db.run("DELETE FROM production_sources WHERE production_id = ?", [productionId]);
    for (const f of d.folder_ids) db.run("INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)", [productionId, f, now]);
  });
}

/**
 * Applies a proposal: the intake draft (written into the production) or timeline edits (saved as a new revision;
 * refused with a conflict when someone saved another revision since). Other documents are applied by approving.
 */
export function applyChatProposal(core: StudioEngineCore, db: StudioDb, p: { productionId: string; turnId: string; userId: string }): { revision?: number } {
  const turn = getTurn(db, p.turnId);
  if (!turn || turn.production_id !== p.productionId || turn.proposal === null) throw new StudioRunError("not_found", `no proposal ${p.turnId}`);
  if (turn.applied_at) throw new StudioRunError("conflict", "đề xuất này đã được áp dụng", { code: "already_applied" });
  const key: ChatScopeKey = { productionId: turn.production_id, episodeId: turn.episode_id, runId: turn.run_id, stageKey: turn.stage_key, scope: turn.scope };
  const latest = currentProposal(db, key);
  if (latest?.id !== turn.id) throw new StudioRunError("conflict", "đã có bản đề xuất mới hơn", { code: "superseded", latest: latest?.id ?? null });
  const now = core.clock.now();
  if (turn.scope === "intake") {
    if (getProduction(db, p.productionId)?.run_id) throw new StudioRunError("conflict", "video đã bắt đầu", { code: "started" });
    writeIntake(db, p.productionId, IntakeDraftSchema.parse(turn.proposal), now);
    markTurnApplied(db, turn.id, now);
    return {};
  }
  const isTimeline = turn.stage_key === "timeline" || GATE_SOURCES[turn.stage_key]?.skill === "studio-timeline";
  if (!isTimeline || !turn.episode_id) throw new StudioRunError("invalid", "đề xuất này được áp dụng khi bấm Duyệt");
  const prop = turn.proposal as TimelineProposal;
  const { revision } = saveEpisodeRevision(db, turn.episode_id, { baseRevision: prop.base_revision, data: prop.timeline, authorId: p.userId, label: "chat" });
  markTurnApplied(db, turn.id, now);
  insertSystemTurn(db, key, `Đã áp dụng vào timeline (bản ${revision}).`, now);
  return { revision };
}

/** Starts the series from the chat: applies the newest intake draft, refuses (with what is missing) until complete. */
export function startFromIntake(core: StudioEngineCore, db: StudioDb, productionId: string): { runId: string } {
  const key = chatScopeFor(core, db, productionId);
  if (key.scope !== "intake") throw new StudioRunError("conflict", "video đã bắt đầu", { code: "started" });
  const ctx = chatContext(core, db, key);
  const draft = IntakeDraftSchema.parse(ctx.current);
  const missing: IntakeField[] = intakeMissing(draft);
  if (missing.length) throw new StudioRunError("invalid", "còn thiếu thông tin để bắt đầu", { code: "intake_incomplete", missing });
  const now = core.clock.now();
  writeIntake(db, productionId, draft, now);
  if (ctx.currentTurnId) markTurnApplied(db, ctx.currentTurnId, now);
  const started = startPlanRun(core, db, productionId);
  insertSystemTurn(db, key, "Đã bắt đầu: nghiên cứu thị trường, rồi từng bước dừng lại chờ bạn duyệt.", now);
  return started;
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

const EDIT_KINDS: Record<string, HumanEditKind> = {
  "approve-trend-report": "trend_report", "approve-rnd": "rnd", "approve-branding": "branding", "approve-plan": "series_plan",
  "approve-youtube-kit": "youtube_kit",
};

/**
 * Approves the document on show at a gate (spec local-chat §2.5: always a button, never a chat word). `turnId`, when
 * given, must be that document's turn: a screen that has not seen the newest version cannot approve an older one.
 */
export async function approveChatScope(core: StudioEngineCore, db: StudioDb, p: {
  productionId: string; episodeId?: string | null; stageKey: string; turnId?: string | null; userId: string;
}): Promise<{ stageState: string; runState: string; revision?: number }> {
  const key = chatScopeFor(core, db, p.productionId, p.episodeId ?? null);
  if (key.scope !== "gate" || key.stageKey !== p.stageKey) {
    throw new StudioRunError("conflict", `bước ${p.stageKey} không còn chờ duyệt`, { code: "stale_step", stage: key.stageKey });
  }
  const ctx = chatContext(core, db, key);
  const now = core.clock.now();
  if (ctx.skill === "studio-timeline") {
    const pending = currentProposal(db, key);
    if (pending && !pending.applied_at && p.turnId === pending.id) {
      throw new StudioRunError("conflict", "áp dụng đề xuất trước khi duyệt", { code: "not_applied" });
    }
    const r = await submitEpisodeTimelineGate(core, db, p.episodeId!);
    insertSystemTurn(db, key, `Đã duyệt timeline (bản ${r.revision}).`, now);
    return { stageState: r.stageState, runState: r.runState, revision: r.revision };
  }
  if ((p.turnId ?? null) !== ctx.currentTurnId) {
    throw new StudioRunError("conflict", "đã có bản mới hơn; xem lại rồi duyệt", { code: "stale_version", current: ctx.currentTurnId });
  }
  const report = await submitStudioGate(core, db, key.runId!, key.stageKey, ctx.current);
  if (ctx.currentTurnId) markTurnApplied(db, ctx.currentTurnId, now);
  const kind = EDIT_KINDS[key.stageKey];
  if (kind) {
    try {
      recordHumanEdit(db, {
        userId: p.userId, productionId: p.productionId, episodeId: p.episodeId ?? null, kind, before: ctx.draft, after: ctx.current,
        llmCallId: latestAcceptedCall(db, key.runId!, GATE_SOURCES[key.stageKey]!.stage),
      });
    } catch { /* the dataset never blocks an approval */ }
  }
  insertSystemTurn(db, key, "Đã duyệt.", now);
  return { stageState: report.stageState, runState: report.runState };
}

// ---------------------------------------------------------------------------
// Reading the chat
// ---------------------------------------------------------------------------

export interface ChatThreadView {
  turns: ChatTurn[];
  /** Where a new message would go now, or why none can be sent (`busy`, `nothing_to_chat`). */
  scope: ChatScopeKey | null;
  blocked: { code: string; stage: string | null } | null;
  /** The document on show and its turn (null: what the stage wrote), for the result pane. */
  current: { turnId: string | null; document: unknown; draft: unknown; pendingApply: boolean; problems: ChatProblem[] } | null;
  /** Replies waiting for a Claude slot before the oldest one of this thread. */
  queueAhead: number;
}

export function chatThread(core: StudioEngineCore, db: StudioDb, productionId: string, o: { episodeId?: string | null; after?: number } = {}): ChatThreadView {
  const turns = listTurns(db, productionId, { episodeId: o.episodeId ?? null, ...(o.after !== undefined ? { after: o.after } : {}) });
  let scope: ChatScopeKey | null = null;
  let blocked: ChatThreadView["blocked"] = null;
  try { scope = chatScopeFor(core, db, productionId, o.episodeId ?? null); }
  catch (e) {
    if (!(e instanceof StudioRunError) || e.code !== "conflict") throw e;
    const d = e.details as { code?: string; stage?: string | null };
    blocked = { code: d.code ?? "busy", stage: d.stage ?? null };
  }
  let current: ChatThreadView["current"] = null;
  if (scope) {
    try {
      const ctx = chatContext(core, db, scope);
      const pending = scope.scope === "timeline" || ctx.skill === "studio-timeline" ? currentProposal(db, scope) : undefined;
      current = { turnId: ctx.currentTurnId, document: ctx.current, draft: ctx.draft, pendingApply: !!pending && !pending.applied_at, problems: ctx.problems };
    } catch { current = null; }
  }
  const mine = db.get<{ created_at: string }>(
    "SELECT MIN(created_at) AS created_at FROM stage_chat_turns WHERE production_id = ? AND episode_id IS ? AND role = 'assistant' AND status IN ('pending', 'rate_limited')",
    [productionId, o.episodeId ?? null]);
  const queueAhead = mine?.created_at
    ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stage_chat_turns WHERE role = 'assistant' AND status IN ('pending', 'rate_limited') AND created_at < ?", [mine.created_at])?.n ?? 0
    : 0;
  return { turns, scope, blocked, current, queueAhead };
}
