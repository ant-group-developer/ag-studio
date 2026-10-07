/**
 * GĐ2 run control: start/view plan runs and episode runs, submit gates, retry/resume stages.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { eventFor, isTerminal, layoutTimeline, submitGate, type SubmitReport } from "@harness/core";
import { StudioExportSchema, type RenderMachine, type StageRun, type StudioEditStyle, type StudioExport } from "@harness/contracts";
import { STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, STUDIO_WORKFLOWS, type StudioEngineCore } from "./core.js";
import {
  getEpisode, getProduction, latestEpisodeRevision, listEpisodes, productionChannels, productionSources, type EpisodeRecord, type StudioDb,
} from "./studio-db.js";
import { defaultRenderMachine, machineOfRequirements, renderChoiceFor, setRenderChoice } from "./render-choice.js";

export type StudioRunErrorCode = "not_found" | "conflict" | "invalid" | "rejected";
export class StudioRunError extends Error {
  constructor(readonly code: StudioRunErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StudioRunError";
  }
}

/** Gates and the document each submits: the trend report (plan 3.0.0), the R&D, the branding, the episode plan, and
 *  for an episode (1.3.0) its timeline and YouTube kit. */
export const STUDIO_GATES: Record<string, string> = {
  "approve-trend-report": "trend-report.json",
  "approve-rnd": "rnd.json",
  "approve-branding": "branding.json",
  "approve-plan": "series-plan.json",
  // episode 1.3.0 and shot-cut 1.0.0
  "approve-timeline": "timeline.json",
  "approve-youtube-kit": "youtube-kit.json",
  // shot-cut episode 1.0.0: the scene selection and the edit plan
  "approve-survey": "survey.json",
  "approve-edit-plan": "edit-plan.json",
};

/** True while the run can still do work (not ended, not being cancelled). */
export function isRunActive(core: StudioEngineCore, runId: string): boolean {
  const run = core.store.getRun(runId);
  return !!run && !isTerminal("run", run.state) && run.state !== "CANCEL_REQUESTED";
}

/** Length of the episode's latest timeline revision in seconds, null before it has one. */
export function episodeTimelineSeconds(db: StudioDb, episodeId: string): number | null {
  const rev = latestEpisodeRevision(db, episodeId);
  return rev ? layoutTimeline(rev.data).duration : null;
}

/** The `export.json` of the episode's current run once its export stage succeeded, else null. */
export function episodeExport(core: StudioEngineCore, ep: { run_id: string | null }): StudioExport | null {
  if (!ep.run_id) return null;
  const stage = core.store.listStageRuns(ep.run_id).find((s) => s.stage_key === EPISODE_EXPORT_STAGE);
  if (stage?.state !== "SUCCEEDED") return null;
  return StudioExportSchema.parse(readStageDocument(core, ep.run_id, EPISODE_EXPORT_STAGE, "export.json"));
}

/** Stage keys of the episode workflow the API and web read. */
export const EPISODE_RENDER_STAGE = "render-final";
export const EPISODE_FREEZE_STAGE = "freeze-timeline";
export const EPISODE_EXPORT_STAGE = "export";
export const EPISODE_TIMELINE_GATE = "approve-timeline";
/** The last gate of an episode 1.3.0: approving it starts freeze-timeline and the final render. */
export const EPISODE_KIT_GATE = "approve-youtube-kit";

/** The episode release without gates, which plans before the chat (1.0.0, 2.0.0) keep spawning. */
export const EPISODE_WITHOUT_GATES = "ag-studio-episode@1.2.0";

/**
 * The release a plan run's episodes run on: a chat-first plan (3.0.0 on) spawns the current one, with gates; a plan
 * started before keeps spawning episodes without gates, so a series begun on the old screens ends as it began.
 */
export function episodeWorkflowForPlan(planVersion: string): string {
  return Number(planVersion.split(".")[0]) >= 3 ? STUDIO_WORKFLOWS.episode.workflow : EPISODE_WITHOUT_GATES;
}

/** The shot-cut episode release (timeline v4, spec local-chat §3.3). */
export const EPISODE_CUT_WORKFLOW = STUDIO_WORKFLOWS.episodeCut.workflow;

/**
 * The release one episode runs on: from plan 3.1.0 on, an episode the plan cuts shot by shot runs the shot-cut
 * workflow; anything else as `episodeWorkflowForPlan` (a 3.0.0 plan that says "cut" still spawns 1.3.0).
 */
export function episodeWorkflowFor(planVersion: string, editStyle: StudioEditStyle | undefined): string {
  const [major = 0, minor = 0] = planVersion.split(".").map(Number);
  if (editStyle === "cut" && (major > 3 || (major === 3 && minor >= 1))) return EPISODE_CUT_WORKFLOW;
  return episodeWorkflowForPlan(planVersion);
}

export type EpisodeStatus = "planned" | "producing" | "waiting_approval" | "ready" | "failed" | "cancelled";

/**
 * An episode's status is its run's state (never stored separately, so it cannot go stale): no run -> planned;
 * SUCCEEDED -> ready; FAILED -> failed; CANCELLED (or being cancelled) -> cancelled; anything else -> producing.
 * `current_stage` is the first stage of the run that has not succeeded; `render_job_id` the latest farm job of
 * render-final (its progress is the episode's progress while it renders).
 */
/**
 * Status of an episode from its run. A gate waiting (episode 1.3.0: approve-timeline, approve-youtube-kit) is an
 * episode waiting for approval. Any other stage waiting for a person (a contract failure the engine will not retry
 * by itself) is a failed episode: it needs someone to retry it, and "producing" would have them wait forever.
 */
export function episodeStatusOf(runState: string, stages: { state: string; gate: boolean }[]): EpisodeStatus {
  if (runState === "SUCCEEDED") return "ready";
  if (runState === "FAILED") return "failed";
  if (runState === "CANCELLED" || runState === "CANCEL_REQUESTED") return "cancelled";
  if (stages.some((x) => x.state === "FAILED" || (x.state === "WAITING_HUMAN" && !x.gate))) return "failed";
  if (stages.some((x) => x.state === "WAITING_HUMAN" && x.gate)) return "waiting_approval";
  return "producing";
}

export function episodeState(core: StudioEngineCore, db: StudioDb, ep: { run_id: string | null }): { status: EpisodeStatus; current_stage: string | null; render_job_id: string | null } {
  if (!ep.run_id) return { status: "planned", current_stage: null, render_job_id: null };
  const run = core.store.getRun(ep.run_id);
  if (!run) return { status: "planned", current_stage: null, render_job_id: null };
  const status = episodeStatusOf(run.state, core.store.listStageRuns(ep.run_id).map((s) => ({ state: s.state, gate: s.executor.type === "gate" })));
  const current = status === "ready" ? null : core.store.listStageRuns(ep.run_id).find((s) => s.state !== "SUCCEEDED")?.stage_key ?? null;
  const job = db.get<{ farm_job_id: string }>("SELECT farm_job_id FROM studio_farm_jobs WHERE run_id = ? AND stage_key = ? ORDER BY created_at DESC LIMIT 1", [ep.run_id, EPISODE_RENDER_STAGE]);
  return { status, current_stage: current, render_job_id: job?.farm_job_id ?? null };
}

// ---------------------------------------------------------------------------
// Stage view helpers (shared between plan and episode views)
// ---------------------------------------------------------------------------

export interface StageView {
  key: string; executor: string; state: string; attempts: number; is_gate: boolean;
  /** Kept from an earlier run when this one was resumed from a later stage (its documents are that run's). */
  reused: boolean;
  error: string | null; failed_checks: { check_id: string; evidence: Record<string, unknown> }[];
  outputs: { name: string; type: string; size_bytes: number }[];
}
export interface RunView {
  run_id: string; state: string; created_at: string; updated_at: string; cost_usd: number;
  waiting_gate: string | null;
  stages: StageView[];
  latest_revision: number | null;
}

function acceptedOutputs(core: StudioEngineCore, s: StageRun) {
  const artifacts = s.reused_artifact_ids
    ? s.reused_artifact_ids.map((id) => core.store.getArtifact(id)).filter((a): a is NonNullable<typeof a> => !!a && a.status === "ACCEPTED")
    : core.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" });
  return artifacts.map((a) => ({ a, name: basename(fileURLToPath(a.uri)) }));
}

/** Where an accepted output of a stage is on this machine (null when the stage or the file is not there). */
export function stageArtifactPath(core: StudioEngineCore, runId: string, stageKey: string, name: string): string | null {
  const s = core.store.listStageRuns(runId).find((x) => x.stage_key === stageKey);
  const hit = s ? acceptedOutputs(core, s).find((x) => x.name === name) : undefined;
  return hit ? fileURLToPath(hit.a.uri) : null;
}

function buildRunView(core: StudioEngineCore, runId: string, latestRevision: number | null): RunView {
  const run = core.store.getRun(runId);
  if (!run) throw new StudioRunError("not_found", `run ${runId} not found`);
  const stages = core.store.listStageRuns(runId).map((s): StageView => {
    const attempts = core.store.listAttempts(s.stage_run_id);
    const last = attempts[attempts.length - 1];
    const failed = last ? core.store.listCheckResults(last.attempt_id).filter((c) => c.verdict === "fail").map((c) => ({ check_id: c.check_id, evidence: c.evidence })) : [];
    return {
      key: s.stage_key, executor: s.executor.type, state: s.state, attempts: attempts.length,
      is_gate: s.executor.type === "gate", reused: !!s.reused_artifact_ids,
      error: last?.error_summary ?? null, failed_checks: failed,
      outputs: acceptedOutputs(core, s).map(({ a, name }) => ({ name, type: a.type, size_bytes: a.size_bytes })),
    };
  });
  const waiting = stages.find((s) => s.is_gate && s.state === "WAITING_HUMAN");
  return {
    run_id: run.run_id, state: run.state, created_at: run.created_at, updated_at: run.updated_at,
    cost_usd: run.total_cost_usd, waiting_gate: waiting?.key ?? null, stages, latest_revision: latestRevision,
  };
}

function stageOf(core: StudioEngineCore, runId: string, key: string): StageRun {
  const s = core.store.listStageRuns(runId).find((x) => x.stage_key === key);
  if (!s) throw new StudioRunError("not_found", `run ${runId} has no stage ${key}`);
  return s;
}

// ---------------------------------------------------------------------------
// Plan run
// ---------------------------------------------------------------------------

/** The plan release before the research-first flow: it needs the description, episode length and count typed in. */
const PLAN_V1 = "ag-studio-series-plan@1.0.0";

/**
 * Start a plan run (one per production) on `opts.workflow` (default: the current plan release). Checks: no active
 * plan run, no episode producing, at least one footage folder, and — research first — at least one channel or
 * keyword to research (the R&D proposes the rest). The 1.0.0 release still needs description, length and count.
 */
export function startPlanRun(core: StudioEngineCore, db: StudioDb, productionId: string, opts: { workflow?: string } = {}): { runId: string } {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (p.run_id) {
    const current = core.store.getRun(p.run_id);
    if (current && !isTerminal("run", current.state)) {
      throw new StudioRunError("conflict", `production already has an active plan run ${p.run_id} (${current.state})`, { run_id: p.run_id, state: current.state });
    }
  }
  assertNoEpisodeProducing(core, db, productionId);
  const workflow = opts.workflow ?? STUDIO_WORKFLOWS.plan.workflow;
  if (!productionSources(db, productionId).length) throw new StudioRunError("invalid", "chọn ít nhất một folder nguồn trước khi chạy");
  if (workflow === PLAN_V1) {
    if (!(p.brief?.trim())) throw new StudioRunError("invalid", "nhập mô tả (description) trước khi chạy");
    if (!p.episode_target_seconds) throw new StudioRunError("invalid", "đặt episode_target_seconds trước khi chạy");
    if (!p.max_episodes) throw new StudioRunError("invalid", "đặt max_episodes trước khi chạy");
  } else {
    const keywords = p.keywords ? (JSON.parse(p.keywords) as string[]) : [];
    if (!productionChannels(p).length && !keywords.length) {
      throw new StudioRunError("invalid", "nhập ít nhất một kênh YouTube (của mình hoặc tham khảo) hoặc một từ khoá để nghiên cứu", { code: "nothing_to_research" });
    }
  }
  const flow = STUDIO_WORKFLOWS.plan;
  const run = core.planner.plan({
    workflow: core.workflows(workflow), profile: core.profiles(flow.profile),
    harness: core.harness, projectId: STUDIO_PROJECT_ID, portfolioId: STUDIO_PORTFOLIO_ID, reuse: false,
  });
  db.run("UPDATE productions SET run_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?",
    [run.run_id, new Date().toISOString(), productionId]);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id };
}

/** A new plan replaces the production's episodes: refused while one of them is still producing. */
export function assertNoEpisodeProducing(core: StudioEngineCore, db: StudioDb, productionId: string): void {
  const producing = listEpisodes(db, productionId).find((e) => ["producing", "waiting_approval"].includes(episodeState(core, db, e).status));
  if (producing) throw new StudioRunError("conflict", "một tập đang sản xuất; không thể lên kế hoạch lại", { code: "episode_producing", episode_id: producing.id });
}

export function planRunView(core: StudioEngineCore, db: StudioDb, productionId: string): RunView {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (!p.run_id) throw new StudioRunError("not_found", `production ${productionId} has no plan run yet`);
  return buildRunView(core, p.run_id, null);
}

// ---------------------------------------------------------------------------
// Episode run
// ---------------------------------------------------------------------------

export function startEpisodeRun(core: StudioEngineCore, db: StudioDb, episodeId: string, opts: { workflow?: string } = {}): { runId: string } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (ep.run_id) {
    const current = core.store.getRun(ep.run_id);
    if (current && !isTerminal("run", current.state)) {
      throw new StudioRunError("conflict", `episode already has an active run ${ep.run_id}`, { run_id: ep.run_id });
    }
  }
  // a new run of an episode follows its edit style ("Render lại" with no run yet starts here too)
  const flow = ep.edit_style === "cut" ? STUDIO_WORKFLOWS.episodeCut : STUDIO_WORKFLOWS.episode;
  const run = core.planner.plan({
    workflow: core.workflows(opts.workflow ?? flow.workflow), profile: core.profiles(flow.profile),
    harness: core.harness, projectId: STUDIO_PROJECT_ID, portfolioId: STUDIO_PORTFOLIO_ID, reuse: false,
  });
  db.run("UPDATE episodes SET run_id = ?, updated_at = ? WHERE id = ?", [run.run_id, new Date().toISOString(), episodeId]);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id };
}

export function episodeRunView(core: StudioEngineCore, db: StudioDb, episodeId: string): RunView & { farm_job_id: string | null } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (!ep.run_id) throw new StudioRunError("not_found", `episode ${episodeId} has no run yet`);
  const latest = latestEpisodeRevision(db, episodeId);
  const view = buildRunView(core, ep.run_id, latest?.revision ?? null);
  return { ...view, farm_job_id: episodeState(core, db, ep).render_job_id };
}

/**
 * "Render lại" for an episode:
 * - no run yet: start one;
 * - run ended (ready, failed, cancelled): a new run resumed from the step `renderRestartFrom` names. An episode
 *   1.3.0 whose latest revision is the timeline it approved renders again from render-final (nothing is asked or
 *   written again: no Claude, no approval); edited since, it goes from approve-timeline (the latest revision is
 *   approved again). An episode without gates (1.2.0) goes from freeze-timeline, which takes the latest revision;
 * - run parked at freeze-timeline (the timeline had errors, now fixed in the editor): retry that stage;
 * - otherwise it is still producing: conflict.
 * `machine` is the farm machine type the final render of that run uses (phase 3); none keeps the run's choice, or
 * `{}` for a new run.
 */
export function rerenderEpisode(
  core: StudioEngineCore, db: StudioDb, episodeId: string, o: { machine?: RenderMachine; by?: string } = {},
): { runId: string; reused: string[]; from: string } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  const choose = (runId: string) => {
    if (o.machine === undefined) return;
    setRenderChoice(db, { runId, stageKey: EPISODE_RENDER_STAGE, machine: o.machine, by: o.by ?? "studio-api", now: core.clock.now(), episodeId });
  };
  const from = renderRestartFrom(core, db, ep);
  if (from === null) {
    const run = ep.run_id ? core.store.getRun(ep.run_id) : undefined;
    throw new StudioRunError("conflict", "tập đang được sản xuất; chờ xong rồi render lại", { code: "episode_running", state: run?.state ?? null });
  }
  if (from === "start") {
    const started = startEpisodeRun(core, db, episodeId);
    choose(started.runId);
    return { ...started, reused: [], from };
  }
  const run = core.store.getRun(ep.run_id!)!;
  if (!isTerminal("run", run.state)) {
    // parked at freeze-timeline: render-final has not been submitted yet, so the choice still applies to this run
    choose(ep.run_id!);
    retryStage(core, ep.run_id!, EPISODE_FREEZE_STAGE);
    return { runId: ep.run_id!, reused: [], from };
  }
  const resumed = resumeRunFrom(core, ep.run_id!, (newRunId) => {
    choose(newRunId);
    db.run("UPDATE episodes SET run_id = ?, updated_at = ? WHERE id = ?", [newRunId, new Date().toISOString(), episodeId]);
  }, from);
  return { ...resumed, from };
}

/**
 * Where "Render lại" would start for this episode now (see `rerenderEpisode`): `start` (no run), a stage key, or
 * null while the run is producing.
 */
export function renderRestartFrom(core: StudioEngineCore, db: StudioDb, ep: EpisodeRecord): "start" | typeof EPISODE_RENDER_STAGE | typeof EPISODE_TIMELINE_GATE | typeof EPISODE_FREEZE_STAGE | null {
  if (!ep.run_id) return "start";
  const run = core.store.getRun(ep.run_id);
  if (!run) return "start";
  const stages = core.store.listStageRuns(ep.run_id);
  const freeze = stages.find((s) => s.stage_key === EPISODE_FREEZE_STAGE);
  if (!isTerminal("run", run.state)) {
    return freeze && (freeze.state === "WAITING_HUMAN" || freeze.state === "FAILED") ? EPISODE_FREEZE_STAGE : null;
  }
  const gate = stages.find((s) => s.stage_key === EPISODE_TIMELINE_GATE);
  if (!gate) return EPISODE_FREEZE_STAGE;
  if (freeze?.state !== "SUCCEEDED") return EPISODE_TIMELINE_GATE;
  const latest = latestEpisodeRevision(db, ep.id);
  let approved: unknown;
  try { approved = readStageDocument(core, ep.run_id, EPISODE_TIMELINE_GATE, "timeline.json"); }
  catch { return EPISODE_TIMELINE_GATE; }
  return latest && isDeepStrictEqual(latest.data, approved) ? EPISODE_RENDER_STAGE : EPISODE_TIMELINE_GATE;
}

/** The final render of an episode as the render pickers and the result pane show it. */
export interface EpisodeRenderInfo {
  /** The type chosen for the current run's render, if any. */
  machine: RenderMachine | null;
  /** What a picker starts on: the run's choice, else the production's latest, else any. */
  defaultMachine: RenderMachine;
  restartFrom: ReturnType<typeof renderRestartFrom>;
  /** The latest final render job of the episode (any run), with the type it was sent with (null: unknown). */
  job: { farmJobId: string; runId: string; machine: RenderMachine | null; createdAt: string } | null;
}

export function episodeRenderInfo(core: StudioEngineCore, db: StudioDb, episodeId: string): EpisodeRenderInfo {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  const machine = ep.run_id ? renderChoiceFor(db, ep.run_id, EPISODE_RENDER_STAGE) : null;
  const job = db.get<{ farm_job_id: string; run_id: string; requirements: string | null; created_at: string }>(
    "SELECT farm_job_id, run_id, requirements, created_at FROM studio_farm_jobs WHERE episode_id = ? AND stage_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [episodeId, EPISODE_RENDER_STAGE]);
  return {
    machine,
    defaultMachine: machine ?? defaultRenderMachine(db, ep.production_id),
    restartFrom: renderRestartFrom(core, db, ep),
    job: job ? { farmJobId: job.farm_job_id, runId: job.run_id, machine: machineOfRequirements(job.requirements), createdAt: job.created_at } : null,
  };
}

/**
 * True once the episode's current run approved its timeline (episode 1.3.0): a revision saved from then on is not
 * rendered until the run goes again from approve-timeline ("Render lại").
 */
export function episodeTimelineApproved(core: StudioEngineCore, db: StudioDb, episodeId: string): boolean {
  const ep = getEpisode(db, episodeId);
  if (!ep?.run_id) return false;
  return core.store.listStageRuns(ep.run_id).some((s) => s.stage_key === EPISODE_TIMELINE_GATE && s.state === "SUCCEEDED");
}

/**
 * Approves an episode's timeline (episode 1.3.0, gate approve-timeline): the document submitted is the episode's
 * latest revision, whatever the person saved in the editor or applied from the chat.
 */
export async function submitEpisodeTimelineGate(core: StudioEngineCore, db: StudioDb, episodeId: string): Promise<SubmitReport & { revision: number }> {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (!ep.run_id) throw new StudioRunError("conflict", `episode ${episodeId} has no run`);
  const latest = latestEpisodeRevision(db, episodeId);
  if (!latest) throw new StudioRunError("conflict", `episode ${episodeId} has no timeline yet`);
  const report = await submitStudioGate(core, db, ep.run_id, EPISODE_TIMELINE_GATE, latest.data);
  return { ...report, revision: latest.revision };
}

// ---------------------------------------------------------------------------
// Stage documents
// ---------------------------------------------------------------------------

export function readStageDocument(core: StudioEngineCore, runId: string, stageKey: string, name: string): unknown {
  const run = core.store.getRun(runId);
  if (!run) throw new StudioRunError("not_found", `run ${runId} not found`);
  const s = stageOf(core, runId, stageKey);
  const hit = acceptedOutputs(core, s).find((x) => x.name === name);
  if (!hit) throw new StudioRunError("not_found", `stage ${stageKey} has no accepted ${name}`);
  if (!name.endsWith(".json")) throw new StudioRunError("invalid", `${name} is not a JSON document`);
  return JSON.parse(readFileSync(fileURLToPath(hit.a.uri), "utf8"));
}

// ---------------------------------------------------------------------------
// Gate submission
// ---------------------------------------------------------------------------

export async function submitStudioGate(
  core: StudioEngineCore, db: StudioDb, runId: string, gate: string, document?: unknown,
): Promise<SubmitReport> {
  const file = STUDIO_GATES[gate];
  if (!file) throw new StudioRunError("invalid", `${gate} is not a Studio gate`);
  const s = stageOf(core, runId, gate);
  if (s.state !== "WAITING_HUMAN") throw new StudioRunError("conflict", `gate ${gate} is ${s.state}, not waiting for input`, { state: s.state });
  const body = document;
  if (body === undefined) throw new StudioRunError("invalid", `gate ${gate} needs a ${file}`);
  const dir = mkdtempSync(join(tmpdir(), "studio-gate-"));
  try {
    writeFileSync(join(dir, file), JSON.stringify(body, null, 2));
    const report = await submitGate({ ...core, owner: "studio-api" }, { stageRunId: s.stage_run_id, fromDir: dir });
    if (report.missing.length || report.failed.length) {
      throw new StudioRunError("rejected", `gate ${gate} refused its input`, { missing: report.missing, failed: report.failed });
    }
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Retry / resume
// ---------------------------------------------------------------------------

export function retryStage(core: StudioEngineCore, runId: string, stageKey: string): void {
  const run = core.store.getRun(runId)!;
  if (isTerminal("run", run.state) || run.state === "CANCEL_REQUESTED") {
    throw new StudioRunError("conflict", `run is ${run.state}; start a new run instead`, { state: run.state });
  }
  const s = stageOf(core, runId, stageKey);
  if (s.executor.type === "gate") throw new StudioRunError("invalid", `${stageKey} is a gate: submit it instead`);
  if (s.state !== "FAILED" && s.state !== "WAITING_HUMAN") throw new StudioRunError("conflict", `stage ${stageKey} is ${s.state}`);
  core.store.transaction(() => {
    core.store.transition("stage_run", s.stage_run_id, s.state, "READY", eventFor(run, s, null, "stage.manual_retry", "warn", { by: "studio-api" }));
    const fresh = core.store.getStageRun(s.stage_run_id)!;
    core.store.updateStageRun({ ...fresh, ready_at: core.clock.now(), not_before: core.clock.now() });
    if (run.state === "WAITING") core.planner.advance(runId);
  });
}

/** `fromStage` and every stage that depends on it, transitively: what a resume from it runs again (run order). */
export function stagesFrom(stages: readonly { stage_key: string; depends_on: string[]; depends_on_optional: string[] }[], fromStage: string): string[] {
  const rerun = new Set([fromStage]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of stages) {
      if (rerun.has(s.stage_key)) continue;
      if ([...s.depends_on, ...s.depends_on_optional].some((d) => rerun.has(d))) { rerun.add(s.stage_key); grew = true; }
    }
  }
  return stages.filter((s) => rerun.has(s.stage_key)).map((s) => s.stage_key);
}

/**
 * Resume a terminal run from `fromStage` (creating a new run that reuses the stages before it).
 * `updateLink` is called with the new run id so the production/episode can point at it.
 */
function resumeRunFrom(
  core: StudioEngineCore,
  oldRunId: string,
  updateLink: (newRunId: string) => void,
  fromStage: string,
): { runId: string; reused: string[] } {
  const old = core.store.getRun(oldRunId);
  if (!old) throw new StudioRunError("not_found", `run ${oldRunId} not found`);
  if (!isTerminal("run", old.state)) throw new StudioRunError("conflict", `run is ${old.state}; retry the stage instead`, { state: old.state });
  const oldStages = core.store.listStageRuns(oldRunId);
  if (!oldStages.some((s) => s.stage_key === fromStage)) throw new StudioRunError("not_found", `run ${oldRunId} has no stage ${fromStage}`);
  const rerun = new Set(stagesFrom(oldStages, fromStage));
  const keep = new Map<string, string[]>();
  for (const s of oldStages) {
    if (rerun.has(s.stage_key)) continue;
    if (s.state !== "SUCCEEDED") {
      throw new StudioRunError("invalid", `bước ${s.stage_key} chưa xong ở lần chạy trước (${s.state})`, { stage: s.stage_key, state: s.state });
    }
    const ids = s.reused_artifact_ids ?? core.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }).map((a) => a.artifact_id);
    keep.set(s.stage_key, ids);
  }
  const run = core.planner.plan({
    workflow: core.workflows(`${old.workflow_release.id}@${old.workflow_release.version}`),
    profile: core.profiles(old.profile_snapshot.id),
    harness: core.harness, projectId: STUDIO_PROJECT_ID, portfolioId: STUDIO_PORTFOLIO_ID, reuse: false,
  });
  core.store.transaction(() => {
    for (const s of core.store.listStageRuns(run.run_id)) {
      const ids = keep.get(s.stage_key);
      if (!ids) continue;
      core.store.transition("stage_run", s.stage_run_id, "PENDING", "SUCCEEDED",
        eventFor(run, s, null, "stage.reused", "info", { artifacts: ids, from_run: oldRunId, resumed_from: fromStage, by: "studio-api" }));
      core.store.updateStageRun({ ...core.store.getStageRun(s.stage_run_id)!, reused_artifact_ids: ids });
    }
  });
  updateLink(run.run_id);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id, reused: [...keep.keys()] };
}

/** An episode's ended run resumed from `fromStage` (see `resumeRunFrom`), the episode pointing at the new run. */
export function resumeEpisodeRunFrom(core: StudioEngineCore, db: StudioDb, episodeId: string, fromStage: string): { runId: string; reused: string[] } {
  const ep = getEpisode(db, episodeId);
  if (!ep?.run_id) throw new StudioRunError("not_found", `episode ${episodeId} has no run`);
  return resumeRunFrom(core, ep.run_id, (newRunId) => {
    db.run("UPDATE episodes SET run_id = ?, updated_at = ? WHERE id = ?", [newRunId, new Date().toISOString(), episodeId]);
  }, fromStage);
}

export function resumePlanRunFrom(core: StudioEngineCore, db: StudioDb, productionId: string, fromStage: string): { runId: string; reused: string[] } {
  const p = getProduction(db, productionId);
  if (!p?.run_id) throw new StudioRunError("not_found", `production ${productionId} has no plan run`);
  assertNoEpisodeProducing(core, db, productionId);
  return resumeRunFrom(core, p.run_id, (newRunId) => {
    db.run("UPDATE productions SET run_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?",
      [newRunId, new Date().toISOString(), productionId]);
  }, fromStage);
}

export function cancelPlan(core: StudioEngineCore, db: StudioDb, productionId: string): void {
  const p = getProduction(db, productionId);
  if (!p?.run_id) throw new StudioRunError("not_found", `production ${productionId} has no plan run`);
  core.planner.cancel(p.run_id);
}

export function cancelEpisode(core: StudioEngineCore, db: StudioDb, episodeId: string): void {
  const ep = getEpisode(db, episodeId);
  if (!ep?.run_id) throw new StudioRunError("not_found", `episode ${episodeId} has no run`);
  core.planner.cancel(ep.run_id);
}
