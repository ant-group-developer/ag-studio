import { pathToFileURL } from "node:url";
import { isHarnessError, type Artifact, type ClaimResult, type Clock, type HarnessConfig, type ProjectConfig, type Run, type StageRequest, type StageResult, type StateStore } from "@harness/contracts";
import { acceptedInputsFor, addSeconds, ArtifactRegistry, Controller, createWorkspace, eventFor, materializeInputs, Planner, Verifier, workspacePath, type HarnessLogger } from "@harness/core";
import type { ExecutorRegistry } from "@harness/executors";
import { startHeartbeat } from "./heartbeat.js";

export interface WorkerDeps {
  store: StateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; executors: ExecutorRegistry;
  harness: HarnessConfig; project: ProjectConfig; dataRoot: string; owner: string; capabilities: string[]; logger: HarnessLogger; clock: Clock;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const onAbort = () => { clearTimeout(t); res(); };
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); res(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Worker {
  constructor(private readonly d: WorkerDeps) {}

  async runForever(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let r: "idle" | "done" | "lost";
      try { r = await this.runOnce(signal); }
      catch (e) { this.d.logger.error("runOnce failed; worker keeps polling", { error: e instanceof Error ? e.message : String(e) }); r = "idle"; }
      if (r === "idle" && !signal.aborted) await sleepUnlessAborted(this.d.harness.poll_seconds * 1000, signal);
    }
  }

  async runOnce(signal?: AbortSignal): Promise<"idle" | "done" | "lost"> {
    const { store, clock, logger } = this.d;
    const reaped = store.reapExpiredLeases(clock.now());
    for (const r of reaped) logger.warn("reaped expired lease", r);
    for (const runId of new Set(reaped.map((r) => r.run_id))) {
      try { this.d.planner.advance(runId); } // a reaper-completed cancel or requeue may settle the run
      catch (e) { logger.warn("advance after reap failed", { run_id: runId, error: e instanceof Error ? e.message : String(e) }); }
    }
    // the run is unknown until the claim lands, so claim on the harness default and widen afterwards
    const defaultLeaseSeconds = this.d.harness.lease_seconds;
    const claim = store.claim({ owner: this.d.owner, capabilities: this.d.capabilities, now: clock.now(), leaseSeconds: defaultLeaseSeconds });
    if (!claim) return "idle";
    const run = store.getRun(claim.stageRun.run_id)!;
    const snapshotLease = Number(run.effective_config_snapshot.lease_seconds);
    const leaseSeconds = Number.isFinite(snapshotLease) ? snapshotLease : defaultLeaseSeconds;
    if (leaseSeconds !== defaultLeaseSeconds) store.heartbeat(claim.attempt.attempt_id, claim.lease.fencing_token, addSeconds(clock.now(), leaseSeconds));
    const log = logger.child({ run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, owner: this.d.owner });
    const ev = (type: string, severity: "info" | "warn" | "error" = "info", payload: Record<string, unknown> = {}) => eventFor(run, claim.stageRun, claim.attempt, type, severity, payload);

    store.transaction(() => {
      store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev("attempt.started"));
      store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev("stage.started"));
    });

    let workspaceDir = workspacePath(this.d.dataRoot, run.run_id, claim.stageRun.stage_key, claim.attempt.attempt_id);
    let inputArtifacts: Artifact[] = [];
    let request: StageRequest;
    try {
      workspaceDir = await createWorkspace(this.d.dataRoot, run.run_id, claim.stageRun.stage_key, claim.attempt.attempt_id);
      store.updateAttempt({ ...store.getAttempt(claim.attempt.attempt_id)!, workspace_uri: pathToFileURL(workspaceDir).href });
      inputArtifacts = acceptedInputsFor(store, claim.stageRun);
      const inputs = await materializeInputs(workspaceDir, inputArtifacts);
      request = this.buildRequest(claim, run.effective_config_snapshot, inputs, workspaceDir);
    } catch (e) {
      log.error("stage setup failed", { error: e instanceof Error ? e.message : String(e) });
      const failed: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: e instanceof Error ? e.message : String(e), details: { phase: "setup" } }] };
      await this.d.controller.commit({ stageRun: claim.stageRun, attempt: claim.attempt, fencingToken: claim.lease.fencing_token, result: failed, verify: { results: [], allRequiredPassed: false, missing: [] }, workspaceDir, executorVersion: "worker-setup", inputArtifactIds: [], mimeTypes: {} });
      return "done";
    }

    const abort = new AbortController();
    const onParentAbort = () => abort.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });
    const hb = startHeartbeat({ store, attemptId: claim.attempt.attempt_id, fencingToken: claim.lease.fencing_token, leaseSeconds, intervalMs: this.d.harness.heartbeat_seconds * 1000, clock, onLost: () => abort.abort() });
    const executor = this.d.executors.resolve(claim.stageRun.executor);
    let result: StageResult;
    try {
      result = await executor.execute(request, { workspaceDir, logger: log, clock, signal: abort.signal });
    } catch (e) {
      const kind = isHarnessError(e, "NOT_FOUND") || isHarnessError(e, "SCHEMA_INVALID") ? "contract" : "transient";
      result = { schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message: e instanceof Error ? e.message : String(e), details: isHarnessError(e) ? { code: e.code, ...e.details } : {} }] };
    } finally { hb.stop(); signal?.removeEventListener("abort", onParentAbort); }

    if (signal?.aborted && !hb.lost) return this.cancelCurrent(claim, run, log);
    if (hb.lost || !store.getLease(claim.stageRun.stage_run_id) || store.getLease(claim.stageRun.stage_run_id)!.fencing_token !== claim.lease.fencing_token) {
      log.warn("lease lost during execution; result discarded");
      return "lost";
    }
    const verify = await this.d.verifier.verify({ request, result, workspaceDir }, claim.stageRun.required_checks);
    try {
      const out = await this.d.controller.commit({ stageRun: claim.stageRun, attempt: claim.attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir, executorVersion: executor.version, inputArtifactIds: inputArtifacts.map((a) => a.artifact_id), mimeTypes: this.mimeTypesFor(claim) });
      log.info("stage committed", { stage: out.stageState, run: out.runState, failure: out.failureKind ?? null, retry: out.retryScheduled });
      return "done";
    } catch (e) {
      if (isHarnessError(e, "FENCING_REJECTED")) { log.warn("commit rejected by fencing token", e.details); return "lost"; }
      throw e;
    }
  }

  private buildRequest(claim: ClaimResult, cfg: Record<string, unknown>, inputs: StageRequest["inputs"], workspaceDir: string): StageRequest {
    const run = this.d.store.getRun(claim.stageRun.run_id)!;
    const exec = claim.stageRun.executor;
    const stage_config = { ...claim.stageRun.stage_config, ...(exec.type === "script" ? { __script: exec.script } : exec.type === "agent" ? { __skill: exec.skill, __brief: exec.brief } : { __brief: exec.brief }) };
    return {
      schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id,
      project_id: run.project_id, portfolio_id: run.portfolio_id, stage_key: claim.stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot,
      inputs, workspace_uri: workspaceDir, stage_config, options: {}, source_items: [], resources: claim.stageRun.requires_resources,
      limits: { deadline_at: addSeconds(this.d.clock.now(), Number(cfg.default_deadline_seconds ?? this.d.harness.default_deadline_seconds)), max_cost_usd: Number(cfg.default_max_cost_usd ?? this.d.harness.default_max_cost_usd), max_attempts: claim.stageRun.retry.max_attempts },
      capabilities: this.d.capabilities, fencing_token: claim.lease.fencing_token,
    };
  }

  private mimeTypesFor(_claim: ClaimResult): Record<string, string> {
    return { script_text: "text/plain", review_notes: "text/plain", final_text: "text/plain" };
  }

  private cancelCurrent(claim: ClaimResult, run: Run, log: HarnessLogger): "done" | "lost" {
    const { store } = this.d;
    try {
      store.transaction(() => {
        store.assertFencing(claim.stageRun.stage_run_id, claim.lease.fencing_token); // another worker may own the stage by now
        const ev = eventFor(run, claim.stageRun, claim.attempt, "attempt.cancelled", "warn", { owner: this.d.owner });
        store.transition("attempt", claim.attempt.attempt_id, "RUNNING", "CANCELLED", ev);
        if (store.getStageRun(claim.stageRun.stage_run_id)!.state === "CANCEL_REQUESTED") {
          store.transition("stage_run", claim.stageRun.stage_run_id, "CANCEL_REQUESTED", "CANCELLED", { ...ev, event_type: "stage.cancelled" });
          store.releaseLease(claim.stageRun.stage_run_id, claim.lease.fencing_token);
          this.d.planner.advance(run.run_id);
          return;
        }
        store.transition("stage_run", claim.stageRun.stage_run_id, "RUNNING", "READY", { ...ev, event_type: "stage.requeued_after_cancel" });
        const s = store.getStageRun(claim.stageRun.stage_run_id)!;
        store.updateStageRun({ ...s, ready_at: this.d.clock.now(), not_before: this.d.clock.now() });
        store.releaseLease(claim.stageRun.stage_run_id, claim.lease.fencing_token);
      });
      return "done";
    } catch (e) {
      if (isHarnessError(e, "FENCING_REJECTED")) { log.warn("cancel rejected by fencing token; the stage belongs to another worker", e.details); return "lost"; }
      throw e;
    }
  }
}
