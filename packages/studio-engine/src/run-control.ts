/**
 * GĐ2 run control: start/view plan runs and episode runs, submit gates, retry/resume stages.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventFor, isTerminal, layoutTimeline, submitGate, type SubmitReport } from "@harness/core";
import { StudioExportSchema, type StageRun, type StudioExport } from "@harness/contracts";
import { STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, STUDIO_WORKFLOWS, type StudioEngineCore } from "./core.js";
import {
  getEpisode, getProduction, latestEpisodeRevision, listEpisodes, productionSources, type StudioDb,
} from "./studio-db.js";

export type StudioRunErrorCode = "not_found" | "conflict" | "invalid" | "rejected";
export class StudioRunError extends Error {
  constructor(readonly code: StudioRunErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StudioRunError";
  }
}

/** Gates and the document each submits: only the plan is approved by a person; episodes run on their own. */
export const STUDIO_GATES: Record<string, string> = {
  "approve-plan": "series-plan.json",
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

export type EpisodeStatus = "planned" | "producing" | "ready" | "failed" | "cancelled";

/**
 * An episode's status is its run's state (never stored separately, so it cannot go stale): no run -> planned;
 * SUCCEEDED -> ready; FAILED -> failed; CANCELLED (or being cancelled) -> cancelled; anything else -> producing.
 * `current_stage` is the first stage of the run that has not succeeded; `render_job_id` the latest farm job of
 * render-final (its progress is the episode's progress while it renders).
 */
/**
 * Status of an episode from its run. The episode workflow has no gate, so a stage waiting for a person (a contract
 * failure the engine will not retry by itself) is a failed episode: it needs someone to retry it, and "producing"
 * would have them wait forever.
 */
export function episodeStatusOf(runState: string, stageStates: string[]): EpisodeStatus {
  if (runState === "SUCCEEDED") return "ready";
  if (runState === "FAILED") return "failed";
  if (runState === "CANCELLED" || runState === "CANCEL_REQUESTED") return "cancelled";
  if (stageStates.includes("WAITING_HUMAN") || stageStates.includes("FAILED")) return "failed";
  return "producing";
}

export function episodeState(core: StudioEngineCore, db: StudioDb, ep: { run_id: string | null }): { status: EpisodeStatus; current_stage: string | null; render_job_id: string | null } {
  if (!ep.run_id) return { status: "planned", current_stage: null, render_job_id: null };
  const run = core.store.getRun(ep.run_id);
  if (!run) return { status: "planned", current_stage: null, render_job_id: null };
  const status = episodeStatusOf(run.state, core.store.listStageRuns(ep.run_id).map((s) => s.state));
  const current = status === "ready" ? null : core.store.listStageRuns(ep.run_id).find((s) => s.state !== "SUCCEEDED")?.stage_key ?? null;
  const job = db.get<{ farm_job_id: string }>("SELECT farm_job_id FROM studio_farm_jobs WHERE run_id = ? AND stage_key = ? ORDER BY created_at DESC LIMIT 1", [ep.run_id, EPISODE_RENDER_STAGE]);
  return { status, current_stage: current, render_job_id: job?.farm_job_id ?? null };
}

// ---------------------------------------------------------------------------
// Stage view helpers (shared between plan and episode views)
// ---------------------------------------------------------------------------

export interface StageView {
  key: string; executor: string; state: string; attempts: number; is_gate: boolean;
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

function buildRunView(core: StudioEngineCore, runId: string, latestRevision: number | null): RunView {
  const run = core.store.getRun(runId);
  if (!run) throw new StudioRunError("not_found", `run ${runId} not found`);
  const stages = core.store.listStageRuns(runId).map((s): StageView => {
    const attempts = core.store.listAttempts(s.stage_run_id);
    const last = attempts[attempts.length - 1];
    const failed = last ? core.store.listCheckResults(last.attempt_id).filter((c) => c.verdict === "fail").map((c) => ({ check_id: c.check_id, evidence: c.evidence })) : [];
    return {
      key: s.stage_key, executor: s.executor.type, state: s.state, attempts: attempts.length,
      is_gate: s.executor.type === "gate",
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

/**
 * Start a plan run (one per production). Checks: folders set, description present,
 * episode_target_seconds and max_episodes set, no active plan run, no episode producing.
 */
export function startPlanRun(core: StudioEngineCore, db: StudioDb, productionId: string): { runId: string } {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (p.run_id) {
    const current = core.store.getRun(p.run_id);
    if (current && !isTerminal("run", current.state)) {
      throw new StudioRunError("conflict", `production already has an active plan run ${p.run_id} (${current.state})`, { run_id: p.run_id, state: current.state });
    }
  }
  if (!productionSources(db, productionId).length) throw new StudioRunError("invalid", "chọn ít nhất một folder nguồn trước khi chạy");
  if (!(p.brief?.trim())) throw new StudioRunError("invalid", "nhập mô tả (description) trước khi chạy");
  if (!p.episode_target_seconds) throw new StudioRunError("invalid", "đặt episode_target_seconds trước khi chạy");
  if (!p.max_episodes) throw new StudioRunError("invalid", "đặt max_episodes trước khi chạy");
  assertNoEpisodeProducing(core, db, productionId);
  const flow = STUDIO_WORKFLOWS.plan;
  const run = core.planner.plan({
    workflow: core.workflows(flow.workflow), profile: core.profiles(flow.profile),
    harness: core.harness, projectId: STUDIO_PROJECT_ID, portfolioId: STUDIO_PORTFOLIO_ID, reuse: false,
  });
  db.run("UPDATE productions SET run_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?",
    [run.run_id, new Date().toISOString(), productionId]);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id };
}

/** A new plan replaces the production's episodes: refused while one of them is still producing. */
function assertNoEpisodeProducing(core: StudioEngineCore, db: StudioDb, productionId: string): void {
  const producing = listEpisodes(db, productionId).find((e) => episodeState(core, db, e).status === "producing");
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

export function startEpisodeRun(core: StudioEngineCore, db: StudioDb, episodeId: string): { runId: string } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (ep.run_id) {
    const current = core.store.getRun(ep.run_id);
    if (current && !isTerminal("run", current.state)) {
      throw new StudioRunError("conflict", `episode already has an active run ${ep.run_id}`, { run_id: ep.run_id });
    }
  }
  const flow = STUDIO_WORKFLOWS.episode;
  const run = core.planner.plan({
    workflow: core.workflows(flow.workflow), profile: core.profiles(flow.profile),
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
 * "Render lại": render the episode's latest timeline revision.
 * - no run yet: start one;
 * - run ended (ready, failed, cancelled): a new run resumed from freeze-timeline (it takes the latest revision;
 *   everything before it, Claude's YouTube kit included, is kept);
 * - run parked at freeze-timeline (the timeline had errors, now fixed in the editor): retry that stage;
 * - otherwise it is still producing: conflict.
 */
export function rerenderEpisode(core: StudioEngineCore, db: StudioDb, episodeId: string): { runId: string; reused: string[] } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (!ep.run_id) return { ...startEpisodeRun(core, db, episodeId), reused: [] };
  const run = core.store.getRun(ep.run_id);
  if (run && !isTerminal("run", run.state)) {
    const freeze = core.store.listStageRuns(ep.run_id).find((s) => s.stage_key === EPISODE_FREEZE_STAGE);
    if (freeze && (freeze.state === "WAITING_HUMAN" || freeze.state === "FAILED")) {
      retryStage(core, ep.run_id, EPISODE_FREEZE_STAGE);
      return { runId: ep.run_id, reused: [] };
    }
    throw new StudioRunError("conflict", "tập đang được sản xuất; chờ xong rồi render lại", { code: "episode_running", state: run.state });
  }
  return resumeRunFrom(core, ep.run_id, (newRunId) => {
    db.run("UPDATE episodes SET run_id = ?, updated_at = ? WHERE id = ?", [newRunId, new Date().toISOString(), episodeId]);
  }, EPISODE_FREEZE_STAGE);
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
  const rerun = new Set([fromStage]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of oldStages) {
      if (rerun.has(s.stage_key)) continue;
      if ([...s.depends_on, ...s.depends_on_optional].some((d) => rerun.has(d))) { rerun.add(s.stage_key); grew = true; }
    }
  }
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
