/**
 * What a chat turn is about (spec local-chat §3.1): which scope a new message goes to, the document on show there,
 * the prompt head the reply starts from and the check a proposal must pass.
 *
 * - gate: the head is the source stage's own prompt head (same inputs, same order, same team rules), so a prompt
 *   cache hit covers it, and a proposal is checked by the stage's own validator against the same inputs;
 * - failed: the same for an agent stage that failed its check twice; the chat explains, a retry carries the feedback;
 * - timeline: the episode's latest revision; a proposal is a list of edits run through `layout.ts` and `timelineIssues`;
 * - intake: the production before its run; a proposal is the whole draft of what the series needs.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  IntakeDraftSchema, STUDIO_CHAT_SKILL_STEP, STUDIO_SKILL_OUTPUTS, STUDIO_SKILL_STEP, StudioEpisodeSchema, TimelineChatProposalSchema,
  TimelineV3Schema, teamGuidesForStep,
  type IntakeDraft, type StudioChatSkill, type StudioSkill, type TeamGuide, type TimelineChatProposal, type TimelineV3,
} from "@harness/contracts";
import {
  acceptedInputsFor, applyTimelineOps, buildStageRequest, isTerminal, layoutTimeline, materializeInputs, timelineIssues, TimelineOpError,
} from "@harness/core";
import { studioPromptHead, studioValidator, teamGuidesSection } from "@harness/executors";
import type { StudioEngineCore } from "./core.js";
import { currentProposal, type ChatProblem, type ChatScopeKey } from "./chat-db.js";
import { readStageDocument, StudioRunError, STUDIO_GATES } from "./run-control.js";
import {
  getEpisode, getProduction, latestEpisodeRevision, productionChannels, productionHints, productionSources, type ProductionRecord, type StudioDb,
} from "./studio-db.js";
import { teamGuides } from "./team-skills.js";

/** Title a production has until the intake chat names it. */
export const DRAFT_PRODUCTION_TITLE = "Video mới";

/** Each gate the chat can work on: the stage that wrote the document, the skill that knows it, the file it is. */
export const GATE_SOURCES: Record<string, { stage: string; skill: StudioSkill | "studio-timeline"; file: string }> = {
  "approve-trend-report": { stage: "trend-report", skill: "studio-trend-report", file: "trend-report.json" },
  "approve-rnd": { stage: "rnd", skill: "studio-rnd", file: "rnd.json" },
  "approve-branding": { stage: "branding", skill: "studio-branding", file: "branding.json" },
  "approve-plan": { stage: "plan-episodes", skill: "studio-plan-episodes", file: "series-plan.json" },
  "approve-youtube-kit": { stage: "youtube-kit", skill: "studio-youtube-kit", file: "youtube-kit.json" },
  "approve-timeline": { stage: "build-timeline", skill: "studio-timeline", file: "timeline.json" },
};

export interface ChatValidation { ok: boolean; value: unknown; problems: ChatProblem[]; warnings: ChatProblem[] }

/** A timeline proposal as kept in the chat: the edits, the timeline they give, and the revision they apply to. */
export interface TimelineProposal extends TimelineChatProposal { base_revision: number; timeline: TimelineV3 }

export interface ChatContext {
  key: ChatScopeKey;
  skill: StudioSkill | StudioChatSkill;
  /** The document on show: the newest proposal, else what the stage wrote (timeline: the latest revision). */
  current: unknown;
  /** The turn `current` comes from (null: the stage's own document). */
  currentTurnId: string | null;
  /** What the stage wrote, before any chat (null for intake and timeline). */
  draft: unknown;
  /** Why the stage failed (failed scope). */
  problems: ChatProblem[];
  /** What Claude proposes in this scope (the `proposal` of its reply). */
  proposalSchema: z.ZodTypeAny;
  /** Readies the inputs in `ws` and gives the prompt head and the check of a proposal. */
  prepare(ws: string): Promise<{ head: string; validate(raw: unknown): ChatValidation }>;
}

// ---------------------------------------------------------------------------
// Which scope a message goes to
// ---------------------------------------------------------------------------

const AGENT_FAILED = new Set(["FAILED", "WAITING_HUMAN"]);

/**
 * The scope a new message about a production (or one of its episodes) goes to, from where its run is now. Refused
 * (conflict, with a `code`) while Claude or a render is still working, or when nothing is left to discuss.
 */
export function chatScopeFor(core: StudioEngineCore, db: StudioDb, productionId: string, episodeId: string | null = null): ChatScopeKey {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  const base = { productionId, episodeId };
  let runId: string | null;
  if (episodeId) {
    const ep = getEpisode(db, episodeId);
    if (!ep || ep.production_id !== productionId) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
    runId = ep.run_id;
    if (!runId) return { ...base, runId: null, stageKey: "timeline", scope: "timeline" };
  } else {
    runId = p.run_id;
    if (!runId) return { ...base, runId: null, stageKey: "intake", scope: "intake" };
  }
  const run = core.store.getRun(runId);
  if (!run) throw new StudioRunError("not_found", `run ${runId} not found`);
  const stages = core.store.listStageRuns(runId);
  const gate = stages.find((s) => s.state === "WAITING_HUMAN" && s.executor.type === "gate" && GATE_SOURCES[s.stage_key]);
  if (gate && !isTerminal("run", run.state)) return { ...base, runId, stageKey: gate.stage_key, scope: "gate" };
  const failed = stages.find((s) => AGENT_FAILED.has(s.state) && s.executor.type === "agent");
  if (failed) return { ...base, runId, stageKey: failed.stage_key, scope: "failed" };
  if (episodeId && isTerminal("run", run.state)) return { ...base, runId, stageKey: "timeline", scope: "timeline" };
  if (!isTerminal("run", run.state)) {
    const at = stages.find((s) => s.state !== "SUCCEEDED" && s.state !== "PENDING")?.stage_key ?? null;
    throw new StudioRunError("conflict", "Claude hoặc máy render đang làm bước này; chờ xong rồi nhắn", { code: "busy", stage: at });
  }
  throw new StudioRunError("conflict", "không còn bước nào để trao đổi", { code: "nothing_to_chat" });
}

// ---------------------------------------------------------------------------
// The context of a scope
// ---------------------------------------------------------------------------

function guidesFor(db: StudioDb, teamId: string, skill: StudioSkill | StudioChatSkill): TeamGuide[] {
  const step = skill in STUDIO_SKILL_STEP ? STUDIO_SKILL_STEP[skill as StudioSkill] : STUDIO_CHAT_SKILL_STEP[skill as StudioChatSkill];
  return teamGuidesForStep(teamGuides(db, teamId), step);
}

/** The request the stage ran with, rebuilt with its inputs materialised in `ws` (same paths as in its workspace). */
async function stageRequestIn(core: StudioEngineCore, runId: string, stageKey: string, ws: string) {
  const run = core.store.getRun(runId)!;
  const stageRun = core.store.listStageRuns(runId).find((s) => s.stage_key === stageKey);
  if (!stageRun) throw new StudioRunError("not_found", `run ${runId} has no stage ${stageKey}`);
  mkdirSync(join(ws, "output"), { recursive: true });
  const inputs = await materializeInputs(ws, acceptedInputsFor(core.store, stageRun));
  const now = core.clock.now();
  const attempt = { schema_version: "harness.attempt/v1", attempt_id: "attempt_chat", stage_run_id: stageRun.stage_run_id, run_id: runId, lease_owner: "studio-chat", fencing_token: 1, state: "RUNNING", started_at: now, created_at: now, updated_at: now } as const;
  const lease = { stage_run_id: stageRun.stage_run_id, attempt_id: "attempt_chat", owner: "studio-chat", expires_at: now, fencing_token: 1, resources: [] };
  return buildStageRequest(
    { store: core.store, clock: core.clock, harness: core.harness, profiles: core.profiles, workflows: core.workflows },
    { run, stageRun, attempt, lease, inputs, workspaceDir: ws, capabilities: [] },
  );
}

function stageDocContext(core: StudioEngineCore, db: StudioDb, key: ChatScopeKey, p: ProductionRecord, o: {
  sourceStage: string; skill: StudioSkill; draft: unknown; problems: ChatProblem[];
}): ChatContext {
  const proposal = currentProposal(db, key);
  return {
    key, skill: o.skill, draft: o.draft, problems: o.problems,
    current: proposal ? proposal.proposal : o.draft, currentTurnId: proposal?.id ?? null,
    proposalSchema: STUDIO_SKILL_OUTPUTS[o.skill],
    prepare: async (ws) => {
      const request = await stageRequestIn(core, key.runId!, o.sourceStage, ws);
      const check = studioValidator(o.skill);
      return {
        head: studioPromptHead(request, ws, guidesFor(db, p.team_id, o.skill)),
        validate: (raw) => {
          try { return check(raw, request, ws); }
          catch (e) { return { ok: false, value: undefined, problems: [{ code: "validator_error", message: e instanceof Error ? e.message : String(e) }], warnings: [] }; }
        },
      };
    },
  };
}

/** The answer the failed stage gave last (its output, rejected), if it is still on disk. */
function rejectedOutput(core: StudioEngineCore, runId: string, stageKey: string, file: string): unknown {
  const s = core.store.listStageRuns(runId).find((x) => x.stage_key === stageKey);
  const last = s ? core.store.listAttempts(s.stage_run_id).at(-1) : undefined;
  if (!last?.workspace_uri) return null;
  try { return JSON.parse(readFileSync(join(fileURLToPath(last.workspace_uri), "output", file), "utf8")); } catch { return null; }
}

function lastProblems(db: StudioDb, runId: string, stageKey: string): ChatProblem[] {
  const row = db.get<{ problems: string }>(
    "SELECT problems FROM llm_calls WHERE run_id = ? AND stage_key = ? AND outcome IN ('rejected', 'failed') ORDER BY created_at DESC LIMIT 1", [runId, stageKey]);
  return row ? (JSON.parse(row.problems) as ChatProblem[]).map((x) => ({ code: x.code, message: x.message })) : [];
}

function timelineContext(core: StudioEngineCore, db: StudioDb, key: ChatScopeKey, p: ProductionRecord): ChatContext {
  const ep = getEpisode(db, key.episodeId!);
  if (!ep) throw new StudioRunError("not_found", `episode ${key.episodeId} not found`);
  const latest = latestEpisodeRevision(db, ep.id);
  if (!latest) throw new StudioRunError("conflict", "tập chưa có timeline", { code: "no_timeline" });
  const proposal = currentProposal(db, key);
  const pending = proposal && !proposal.applied_at ? proposal : undefined;
  const episode = ep.run_id ? (() => { try { return StudioEpisodeSchema.parse(readStageDocument(core, ep.run_id!, "episode-intake", "episode.json")); } catch { return null; } })() : null;
  const allowed = { ...(episode?.assets ?? {}), ...latest.data.assets };
  return {
    key, skill: "studio-timeline", draft: null, problems: [],
    current: latest.data, currentTurnId: pending?.id ?? null,
    proposalSchema: TimelineChatProposalSchema,
    prepare: async () => {
      const laid = layoutTimeline(latest.data);
      const head = [
        `Tập ${ep.idx}: ${ep.title}. Timeline hiện tại là bản ${latest.revision}. Clip ghép nguyên video, nối tiếp nhau, không cắt.`,
        ...(() => { const g = guidesFor(db, p.team_id, "studio-timeline"); return g.length ? ["", ...teamGuidesSection(g)] : []; })(),
        "", "# Dữ liệu vào",
        "", "## Video tập này được dùng (asset_id → mô tả)", "```json", JSON.stringify(allowed, null, 2), "```",
        "", "## Timeline (thời điểm tính bằng giây)", "```json",
        JSON.stringify({
          clips: laid.clips.map((c, i) => ({ index: i, clip_id: c.clip_id, asset_id: c.asset_id, start: c.start, end: c.end, section_title: c.section_title })),
          texts: latest.data.texts, music: latest.data.music, source_audio: latest.data.source_audio, duration: laid.duration,
        }, null, 2), "```",
        ...(episode ? ["", "## Kế hoạch của tập", "```json", JSON.stringify({ title: episode.title, hook: episode.hook, logline: episode.logline }, null, 2), "```"] : []),
      ].join("\n");
      return {
        head,
        validate: (raw) => {
          const parsed = TimelineChatProposalSchema.safeParse(raw);
          if (!parsed.success) return { ok: false, value: undefined, problems: parsed.error.issues.map((x) => ({ code: "schema", message: `${x.path.join(".")}: ${x.message}` })), warnings: [] };
          let timeline: TimelineV3;
          try { timeline = TimelineV3Schema.parse(applyTimelineOps(latest.data, parsed.data.ops, allowed)); }
          catch (e) {
            const code = e instanceof TimelineOpError ? e.code : "schema";
            return { ok: false, value: undefined, problems: [{ code, message: e instanceof Error ? e.message : String(e) }], warnings: [] };
          }
          const issues = timelineIssues(timeline, p.episode_target_seconds ? { targetSeconds: p.episode_target_seconds } : {});
          const errors = issues.filter((i) => i.severity === "error").map((i) => ({ code: i.code, message: i.message }));
          const warnings = issues.filter((i) => i.severity === "warning").map((i) => ({ code: i.code, message: i.message }));
          const value: TimelineProposal = { ops: parsed.data.ops, base_revision: latest.revision, timeline };
          return { ok: errors.length === 0, value, problems: errors, warnings };
        },
      };
    },
  };
}

/** The intake draft as the production row has it (before the chat proposed anything). */
export function productionIntakeDraft(db: StudioDb, p: ProductionRecord): IntakeDraft {
  const keywords = p.keywords ? (JSON.parse(p.keywords) as string[]) : [];
  return {
    schema_version: "studio.intake-draft/v1",
    title: p.title && p.title !== DRAFT_PRODUCTION_TITLE ? p.title : null,
    folder_ids: productionSources(db, p.id), channels: productionChannels(p), keywords,
    aspect: p.aspect === "16:9" || p.aspect === "9:16" ? p.aspect : null, language: p.language ?? null,
    hints: productionHints(p), questions: [],
  };
}

export interface IntakeFolder { id: string; name: string; usableVideos?: number | null }

function intakeContext(db: StudioDb, key: ChatScopeKey, p: ProductionRecord, folders: IntakeFolder[]): ChatContext {
  const proposal = currentProposal(db, key);
  const draft = productionIntakeDraft(db, p);
  const known = new Set(folders.map((f) => f.id));
  return {
    key, skill: "studio-intake", draft, problems: [],
    current: proposal ? proposal.proposal : draft, currentTurnId: proposal?.id ?? null,
    proposalSchema: IntakeDraftSchema,
    prepare: async () => {
      const g = guidesFor(db, p.team_id, "studio-intake");
      const head = [
        "Người dùng muốn làm một series video từ footage trên ag-go. Hiểu yêu cầu của họ thành bản nháp (intake draft).",
        ...(g.length ? ["", ...teamGuidesSection(g)] : []),
        "", "# Dữ liệu vào",
        "", "## Folder footage người dùng xem được (id, tên, số video dùng được)", "```json",
        JSON.stringify(folders.map((f) => ({ id: f.id, name: f.name, usable_videos: f.usableVideos ?? null })), null, 2), "```",
      ].join("\n");
      return {
        head,
        validate: (raw) => {
          const parsed = IntakeDraftSchema.safeParse(raw);
          if (!parsed.success) return { ok: false, value: undefined, problems: parsed.error.issues.map((x) => ({ code: "schema", message: `${x.path.join(".")}: ${x.message}` })), warnings: [] };
          const unknown = parsed.data.folder_ids.filter((id) => !known.has(id));
          if (unknown.length) return { ok: false, value: undefined, problems: [{ code: "unknown_folder", message: `folder không có trong danh sách: ${unknown.join(", ")}` }], warnings: [] };
          return { ok: true, value: parsed.data, problems: [], warnings: [] };
        },
      };
    },
  };
}

/**
 * The context of a scope. `folders`: the ag-go folders the person sees (intake only; the API takes them from ag-go
 * when the message is sent and keeps them on the turn).
 */
export function chatContext(core: StudioEngineCore, db: StudioDb, key: ChatScopeKey, o: { folders?: IntakeFolder[] } = {}): ChatContext {
  const p = getProduction(db, key.productionId);
  if (!p) throw new StudioRunError("not_found", `production ${key.productionId} not found`);
  if (key.scope === "intake") return intakeContext(db, key, p, o.folders ?? []);
  if (key.scope === "timeline") return timelineContext(core, db, key, p);
  if (key.scope === "gate") {
    const src = GATE_SOURCES[key.stageKey];
    if (!src || !STUDIO_GATES[key.stageKey]) throw new StudioRunError("invalid", `${key.stageKey} is not a gate the chat knows`);
    if (src.skill === "studio-timeline") return timelineContext(core, db, key, p);
    return stageDocContext(core, db, key, p, {
      sourceStage: src.stage, skill: src.skill, problems: [], draft: readStageDocument(core, key.runId!, src.stage, src.file),
    });
  }
  // failed: an agent stage whose answer did not pass its check
  const stage = core.store.listStageRuns(key.runId!).find((s) => s.stage_key === key.stageKey);
  if (!stage || stage.executor.type !== "agent") throw new StudioRunError("invalid", `${key.stageKey} is not a Claude stage`);
  const skill = stage.executor.skill as StudioSkill;
  const file = Object.values(GATE_SOURCES).find((g) => g.stage === key.stageKey)?.file ?? `${key.stageKey}.json`;
  return stageDocContext(core, db, key, p, {
    sourceStage: key.stageKey, skill, draft: rejectedOutput(core, key.runId!, key.stageKey, file), problems: lastProblems(db, key.runId!, key.stageKey),
  });
}
