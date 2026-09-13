import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessError, isHarnessError, type Clock, type HarnessConfig, type Lease, type ProductionProfile, type Run, type StageResult, type StageRun, type StateStore } from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";
import { directoryDigest, listDirectoryFiles, copyTree } from "../artifacts/directory.js";
import { acceptedInputsFor } from "../artifacts/registry.js";
import { materializeInputs } from "../environment/workspace.js";
import { isTerminal } from "../state/transitions.js";
import { Verifier } from "../verification/verifier.js";
import { stageDefinitionDigest } from "./cache.js";
import { Controller } from "./controller.js";
import { Planner, eventFor } from "./planner.js";
import type { LoadedWorkflow } from "./registry.js";
import { buildStageRequest, mimeTypesFor, stageDefinitionFor } from "./request.js";

export interface GateDeps {
  store: StateStore; planner: Planner; controller: Controller; verifier: Verifier; clock: Clock;
  harness: HarnessConfig; profiles: (id: string) => ProductionProfile; workflows: (ref: string) => LoadedWorkflow; owner?: string;
}
export interface SubmitReport {
  stageRunId: string; stageState: string; runState: string; missing: string[];
  failed: { check_id: string; evidence: Record<string, unknown> }[]; artifacts: string[];
}

/** Verify/commit a `WAITING_HUMAN` gate stage's `output/`, the same path a worker would take: `harness stage submit`. */
export async function submitGate(d: GateDeps, p: { stageRunId: string; fromDir?: string }): Promise<SubmitReport> {
  const { store, clock } = d;
  const stageRun = store.getStageRun(p.stageRunId);
  if (!stageRun) throw new HarnessError("NOT_FOUND", `stage run not found: ${p.stageRunId}`, { stageRunId: p.stageRunId });
  if (stageRun.state !== "WAITING_HUMAN" || stageRun.executor.type !== "gate") {
    throw new HarnessError("INVALID_TRANSITION", `stage ${p.stageRunId} is not a WAITING_HUMAN gate (state=${stageRun.state}, executor=${stageRun.executor.type})`, { stageRunId: p.stageRunId, state: stageRun.state, executor: stageRun.executor.type });
  }
  const run = store.getRun(stageRun.run_id);
  if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${stageRun.run_id}`, { runId: stageRun.run_id });
  if (isTerminal("run", run.state)) throw new HarnessError("INVALID_TRANSITION", `run ${run.run_id} is terminal (${run.state})`, { runId: run.run_id, state: run.state });

  const attempts = store.listAttempts(stageRun.stage_run_id);
  const lastAttempt = attempts[attempts.length - 1];
  if (!lastAttempt?.workspace_uri) throw new HarnessError("NOT_FOUND", `no gate attempt/workspace for stage ${p.stageRunId}`, { stageRunId: p.stageRunId });
  const ws = fileURLToPath(lastAttempt.workspace_uri);

  if (p.fromDir) await copyTree(p.fromDir, join(ws, "output"));

  const def = stageDefinitionFor(d.workflows, run, stageRun.stage_key);
  const expectedOutputs = def?.outputs ?? [];
  const missing: string[] = [];
  const outputs: { path: string; type: string; checksum: string; size_bytes: number; kind: "file" | "directory" }[] = [];
  for (const o of expectedOutputs) {
    if (!o.name) throw new HarnessError("CONFIG_INVALID", `gate stage ${stageRun.stage_key}: output "${o.type}" has no name`, { stage: stageRun.stage_key, type: o.type });
    const rel = `output/${o.name}`;
    const abs = join(ws, "output", o.name);
    if (!existsSync(abs)) { missing.push(rel); continue; }
    const digest = o.kind === "directory" ? directoryDigest(await listDirectoryFiles(abs)) : await sha256File(abs);
    outputs.push({ path: rel, type: o.type, checksum: digest.checksum, size_bytes: digest.size_bytes, kind: o.kind });
  }

  const rejectedReport = (failed: SubmitReport["failed"]): SubmitReport => {
    store.appendEvent(eventFor(run, stageRun, lastAttempt, "stage.submit_rejected", "warn", { missing, failed }));
    return { stageRunId: p.stageRunId, stageState: stageRun.state, runState: run.state, missing, failed, artifacts: [] };
  };

  if (missing.length) return rejectedReport([]);

  const requestDeps = { store, clock, harness: d.harness, profiles: d.profiles, workflows: d.workflows };
  const preInputArtifacts = acceptedInputsFor(store, stageRun);

  // Rule 5: pre-verify against the gate attempt that is already parked, before touching any state.
  const preInputs = await materializeInputs(ws, preInputArtifacts);
  const preLease: Lease = { stage_run_id: stageRun.stage_run_id, attempt_id: lastAttempt.attempt_id, owner: lastAttempt.lease_owner, expires_at: clock.now(), fencing_token: lastAttempt.fencing_token, resources: [] };
  const preRequest = buildStageRequest(requestDeps, { run, stageRun, attempt: lastAttempt, lease: preLease, inputs: preInputs, workspaceDir: ws, capabilities: stageRun.required_capabilities });
  const preResult: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: lastAttempt.attempt_id, outcome: "succeeded", outputs, checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] };
  const preVerify = await d.verifier.verify({ request: preRequest, result: preResult, workspaceDir: ws }, stageRun.required_checks);
  if (preVerify.missing.length || preVerify.results.some((r) => r.verdict === "fail")) {
    const failed = [
      ...preVerify.results.filter((r) => r.verdict === "fail").map((r) => ({ check_id: r.check_id, evidence: r.evidence })),
      ...preVerify.missing.map((id) => ({ check_id: id, evidence: { reason: "no checker registered" } })),
    ];
    return rejectedReport(failed);
  }

  // Rule 6: clean — move the stage back to READY, claim it like a worker would, and commit for real.
  // The transition and the targeted claim commit together: in between the stage is plain READY, so a worker
  // polling at that instant would claim it, re-run GateExecutor and orphan the operator's output.
  const owner = d.owner ?? "cli-submit";
  const claim = store.transaction(() => {
    store.transition("stage_run", stageRun.stage_run_id, "WAITING_HUMAN", "READY", eventFor(run, stageRun, null, "stage.submitted"));
    const fresh = store.getStageRun(stageRun.stage_run_id)!;
    store.updateStageRun({ ...fresh, ready_at: clock.now(), not_before: clock.now() });
    // the run parked in WAITING while the gate sat WAITING_HUMAN (no other active stage); a READY stage
    // is "active" for the planner, so nudge it back to RUNNING now, the way `harness retry` does.
    if (run.state === "WAITING") d.planner.advance(run.run_id);
    const c = store.claim({ owner, capabilities: stageRun.required_capabilities, now: clock.now(), leaseSeconds: d.harness.lease_seconds, stageRunId: stageRun.stage_run_id });
    if (!c) throw new HarnessError("STALE_STATE", `could not claim gate stage ${stageRun.stage_run_id} for submit`, { stageRunId: stageRun.stage_run_id });
    return c;
  });

  store.transaction(() => {
    store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "attempt.started"));
    store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "stage.started"));
  });
  store.updateAttempt({ ...store.getAttempt(claim.attempt.attempt_id)!, workspace_uri: pathToFileURL(ws).href });
  const attempt = store.getAttempt(claim.attempt.attempt_id)!;
  const defDigest = def ? stageDefinitionDigest(def) : canonicalDigest({ key: stageRun.stage_key });

  try {
    const inputArtifacts = acceptedInputsFor(store, claim.stageRun);
    const inputs = await materializeInputs(ws, inputArtifacts);
    const request = buildStageRequest(requestDeps, { run, stageRun: claim.stageRun, attempt, lease: claim.lease, inputs, workspaceDir: ws, capabilities: stageRun.required_capabilities });
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs, checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] };
    const verify = await d.verifier.verify({ request, result, workspaceDir: ws }, claim.stageRun.required_checks);
    const out = await d.controller.commit({
      stageRun: claim.stageRun, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws,
      executorVersion: "cli-submit@0.1.0", inputArtifactIds: inputArtifacts.map((a) => a.artifact_id), mimeTypes: mimeTypesFor(def), stageDefinitionDigest: defDigest,
    });
    const failed = verify.results.filter((r) => r.verdict !== "pass").map((r) => ({ check_id: r.check_id, evidence: r.evidence }));
    return { stageRunId: p.stageRunId, stageState: out.stageState, runState: out.runState, missing: verify.missing, failed, artifacts: out.artifacts.map((a) => a.artifact_id) };
  } catch (e) {
    // a stale reused input, a swept artifact, or any other post-claim failure must not strand the new
    // attempt CLAIMED/RUNNING with a live lease until the reaper runs: commit a synthetic failure so the
    // lease is released and the stage is parked the same way the worker parks an equivalent setup failure.
    // FENCING_REJECTED means someone else already owns this attempt; let it propagate as it did before.
    if (isHarnessError(e, "FENCING_REJECTED")) throw e;
    const kind = isHarnessError(e, "STALE_STATE") || isHarnessError(e, "CHECKSUM_MISMATCH") ? "contract" : "transient";
    const message = e instanceof Error ? e.message : String(e);
    const failedResult: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details: { phase: "submit", ...(isHarnessError(e) ? { code: e.code } : {}) } }] };
    const out = await d.controller.commit({
      stageRun: claim.stageRun, attempt, fencingToken: claim.lease.fencing_token, result: failedResult, verify: { results: [], allRequiredPassed: false, missing: [] }, workspaceDir: ws,
      executorVersion: "cli-submit@0.1.0", inputArtifactIds: [], mimeTypes: {}, stageDefinitionDigest: defDigest,
    });
    return { stageRunId: p.stageRunId, stageState: out.stageState, runState: out.runState, missing: [], failed: [{ check_id: "submit", evidence: { error: message } }], artifacts: [] };
  }
}

/** Warn once per `windowSeconds` when a gate has sat `WAITING_HUMAN` past its `gate_deadline_seconds`. */
export function gateOverdue(store: StateStore, now: string, windowSeconds: number): { run: Run; stage: StageRun; overdue_seconds: number }[] {
  const out: { run: Run; stage: StageRun; overdue_seconds: number }[] = [];
  for (const run of [...store.listRuns({ state: "WAITING" }), ...store.listRuns({ state: "RUNNING" })]) {
    for (const s of store.listStageRuns(run.run_id)) {
      if (s.state !== "WAITING_HUMAN" || s.executor.type !== "gate" || !s.gate_deadline_seconds) continue;
      const overdue = (Date.parse(now) - Date.parse(s.updated_at)) / 1000 - s.gate_deadline_seconds;
      if (overdue < 0) continue;
      const recent = store.listEvents({ run_id: run.run_id, limit: 200, newest: true }).some((e) => e.event_type === "stage.gate_overdue" && e.stage_run_id === s.stage_run_id && Date.parse(now) - Date.parse(e.occurred_at) < windowSeconds * 1000);
      if (recent) continue;
      store.appendEvent(eventFor(run, s, null, "stage.gate_overdue", "warn", { overdue_seconds: Math.floor(overdue), deadline_seconds: s.gate_deadline_seconds }));
      out.push({ run, stage: s, overdue_seconds: Math.floor(overdue) });
    }
  }
  return out;
}
