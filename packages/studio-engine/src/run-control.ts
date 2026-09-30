/**
 * What the web drives through the API (plan GĐ4 item 1): start a production run, watch it, read what each
 * stage produced, submit a gate (approve-treatment, shot-board, edit) and retry a stage.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventFor, isTerminal, submitGate, type SubmitReport } from "@harness/core";
import type { StageRun } from "@harness/contracts";
import { STUDIO_FLOWS, STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, type StudioEngineCore } from "./core.js";
import { getProduction, latestRevision, productionSources, type StudioDb } from "./studio-db.js";

export type StudioRunErrorCode = "not_found" | "conflict" | "invalid" | "rejected";
export class StudioRunError extends Error {
  constructor(readonly code: StudioRunErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StudioRunError";
  }
}

/** Gates of the workflow and the one document each of them submits. */
export const STUDIO_GATES: Record<string, string> = {
  "approve-treatment": "treatment.json",
  "shot-board": "selection.json",
  edit: "timeline.json",
};

export function startRun(core: StudioEngineCore, db: StudioDb, productionId: string): { runId: string } {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (p.run_id) {
    const current = core.store.getRun(p.run_id);
    if (current && !isTerminal("run", current.state)) throw new StudioRunError("conflict", `production already has an active run ${p.run_id} (${current.state})`, { run_id: p.run_id, state: current.state });
  }
  if (!productionSources(db, productionId).length) throw new StudioRunError("invalid", "chọn ít nhất một folder nguồn trước khi chạy");
  if (!p.target_seconds) throw new StudioRunError("invalid", "đặt thời lượng đích trước khi chạy");
  const flow = STUDIO_FLOWS[core.flow];
  const run = core.planner.plan({
    workflow: core.workflows(flow.workflow), profile: core.profiles(flow.profile), harness: core.harness,
    projectId: STUDIO_PROJECT_ID, portfolioId: STUDIO_PORTFOLIO_ID, reuse: false,
  });
  // The link must exist before `intake` can be claimed: it finds its production by run id.
  db.run("UPDATE productions SET run_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?", [run.run_id, new Date().toISOString(), productionId]);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id };
}

export interface StageView {
  key: string; executor: string; state: string; attempts: number; is_gate: boolean;
  error: string | null; failed_checks: { check_id: string; evidence: Record<string, unknown> }[];
  outputs: { name: string; type: string; size_bytes: number }[];
}
export interface RunView {
  run_id: string; state: string; created_at: string; updated_at: string; cost_usd: number;
  /** The gate waiting for a person, if any. */
  waiting_gate: string | null;
  stages: StageView[];
  latest_revision: number | null;
}

function currentRunId(db: StudioDb, productionId: string): string {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (!p.run_id) throw new StudioRunError("not_found", `production ${productionId} has no run yet`);
  return p.run_id;
}

function stageOf(core: StudioEngineCore, runId: string, key: string): StageRun {
  const s = core.store.listStageRuns(runId).find((x) => x.stage_key === key);
  if (!s) throw new StudioRunError("not_found", `run ${runId} has no stage ${key}`);
  return s;
}

function acceptedOutputs(core: StudioEngineCore, s: StageRun) {
  // a stage kept from an earlier run (resumeRunFrom) owns no artifacts: it points at that run's
  const artifacts = s.reused_artifact_ids
    ? s.reused_artifact_ids.map((id) => core.store.getArtifact(id)).filter((a): a is NonNullable<typeof a> => !!a && a.status === "ACCEPTED")
    : core.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" });
  return artifacts.map((a) => ({ a, name: basename(fileURLToPath(a.uri)) }));
}

export function runView(core: StudioEngineCore, db: StudioDb, productionId: string): RunView {
  const runId = currentRunId(db, productionId);
  const run = core.store.getRun(runId);
  if (!run) throw new StudioRunError("not_found", `run ${runId} not found`);
  const stages = core.store.listStageRuns(runId).map((s): StageView => {
    const attempts = core.store.listAttempts(s.stage_run_id);
    const last = attempts[attempts.length - 1];
    const failed = last ? core.store.listCheckResults(last.attempt_id).filter((c) => c.verdict === "fail").map((c) => ({ check_id: c.check_id, evidence: c.evidence })) : [];
    return {
      key: s.stage_key, executor: s.executor.type, state: s.state, attempts: attempts.length, is_gate: s.executor.type === "gate",
      error: last?.error_summary ?? null, failed_checks: failed,
      outputs: acceptedOutputs(core, s).map(({ a, name }) => ({ name, type: a.type, size_bytes: a.size_bytes })),
    };
  });
  const waiting = stages.find((s) => s.is_gate && s.state === "WAITING_HUMAN");
  return {
    run_id: run.run_id, state: run.state, created_at: run.created_at, updated_at: run.updated_at, cost_usd: run.total_cost_usd,
    waiting_gate: waiting?.key ?? null, stages, latest_revision: latestRevision(db, productionId)?.revision ?? null,
  };
}

/** JSON document a stage produced (for gates: what the person submitted; else the stage's own output). */
export function readStageDocument(core: StudioEngineCore, db: StudioDb, productionId: string, stageKey: string, name: string): unknown {
  const runId = currentRunId(db, productionId);
  const s = stageOf(core, runId, stageKey);
  const hit = acceptedOutputs(core, s).find((x) => x.name === name);
  if (!hit) throw new StudioRunError("not_found", `stage ${stageKey} has no accepted ${name}`);
  if (!name.endsWith(".json")) throw new StudioRunError("invalid", `${name} is not a JSON document`);
  return JSON.parse(readFileSync(fileURLToPath(hit.a.uri), "utf8"));
}

/**
 * Submit a gate. `approve-treatment`/`shot-board` take the (possibly edited) document; `edit` takes nothing:
 * the latest saved timeline revision is what gets submitted (the editor autosaves every change).
 */
export async function submitStudioGate(core: StudioEngineCore, db: StudioDb, productionId: string, gate: string, document?: unknown): Promise<SubmitReport> {
  const file = STUDIO_GATES[gate];
  if (!file) throw new StudioRunError("invalid", `${gate} is not a Studio gate`);
  const runId = currentRunId(db, productionId);
  const s = stageOf(core, runId, gate);
  if (s.state !== "WAITING_HUMAN") throw new StudioRunError("conflict", `gate ${gate} is ${s.state}, not waiting for input`, { state: s.state });
  let body = document;
  if (gate === "edit") {
    const rev = latestRevision(db, productionId);
    if (!rev) throw new StudioRunError("invalid", "chưa có revision timeline nào để nộp");
    body = rev.data;
  }
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

/** Move a FAILED or WAITING_HUMAN (non-gate) stage back to READY -- the web's "Chạy lại" button. */
export function retryStage(core: StudioEngineCore, db: StudioDb, productionId: string, stageKey: string): void {
  const runId = currentRunId(db, productionId);
  const run = core.store.getRun(runId)!;
  // A FAILED run is terminal in the harness (same rule as `harness retry`): the production starts a new run.
  if (isTerminal("run", run.state) || run.state === "CANCEL_REQUESTED") throw new StudioRunError("conflict", `run is ${run.state}; start a new run instead`, { state: run.state });
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
 * "Chạy lại từ bước này" after the run ended (FAILED or CANCELLED): a new run of the production in which
 * every stage that is neither `fromStage` nor depends on it keeps what the previous run accepted -- Claude's
 * documents and the gates people already submitted included -- so only `fromStage` and what follows it run
 * again. The kept stages point at the previous run's artifacts (`reused_artifact_ids`, the harness' cache
 * mechanism), so the stages that run read them as their inputs as usual.
 */
export function resumeRunFrom(core: StudioEngineCore, db: StudioDb, productionId: string, fromStage: string): { runId: string; reused: string[] } {
  const oldRunId = currentRunId(db, productionId);
  const old = core.store.getRun(oldRunId);
  if (!old) throw new StudioRunError("not_found", `run ${oldRunId} not found`);
  if (!isTerminal("run", old.state)) throw new StudioRunError("conflict", `run is ${old.state}; retry the stage instead`, { state: old.state });
  const oldStages = core.store.listStageRuns(oldRunId);
  if (!oldStages.some((s) => s.stage_key === fromStage)) throw new StudioRunError("not_found", `run ${oldRunId} has no stage ${fromStage}`);

  // fromStage and everything downstream of it run again
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
      throw new StudioRunError("invalid", `bước ${s.stage_key} chưa xong ở lần chạy trước (${s.state}); chạy lại từ ${s.stage_key}`, { stage: s.stage_key, state: s.state });
    }
    const ids = s.reused_artifact_ids ?? core.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }).map((a) => a.artifact_id);
    keep.set(s.stage_key, ids);
  }

  // the new run keeps the old one's workflow and profile, whatever flow new runs use now
  const run = core.planner.plan({
    workflow: core.workflows(`${old.workflow_release.id}@${old.workflow_release.version}`), profile: core.profiles(old.profile_snapshot.id),
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
  // as in startRun: the production must point at the run before any of its stages can be claimed
  db.run("UPDATE productions SET run_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?", [run.run_id, new Date().toISOString(), productionId]);
  core.planner.enqueue(run.run_id);
  return { runId: run.run_id, reused: [...keep.keys()] };
}

export function cancelRun(core: StudioEngineCore, db: StudioDb, productionId: string): void {
  core.planner.cancel(currentRunId(db, productionId));
}
