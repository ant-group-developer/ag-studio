import { isHarnessError, newId, type Artifact, type Attempt, type Clock, type FailureKind, type StageResult, type StageRun, type StateStore } from "@harness/contracts";
import { ArtifactRegistry, type ArtifactContext } from "../artifacts/registry.js";
import { addSeconds } from "../state/clock.js";
import type { VerifyOutcome } from "../verification/verifier.js";
import { invalidateDownstream } from "./invalidation.js";
import { eventFor, Planner } from "./planner.js";

export interface CommitParams {
  stageRun: StageRun; attempt: Attempt; fencingToken: number; result: StageResult; verify: VerifyOutcome;
  workspaceDir: string; executorVersion: string; inputArtifactIds: string[]; mimeTypes: Record<string, string>;
}
export interface CommitOutcome { stageState: string; runState: string; attemptState: string; artifacts: Artifact[]; failureKind?: FailureKind; retryScheduled: boolean }

export function classifyFailure(result: StageResult, verify: VerifyOutcome): FailureKind | null {
  if (result.outcome === "succeeded" && verify.allRequiredPassed) return null;
  if (verify.missing.length > 0) return "contract";
  if (verify.results.some((r) => r.check_id === "schema-valid" && r.verdict === "fail")) return "contract";
  if (result.errors.some((e) => e.kind === "contract")) return "contract";
  if (result.outcome === "deferred") return "deferred";
  if (result.outcome === "unknown") return "unknown";
  if (result.outcome === "failed" && result.errors[0]?.kind === "transient") return "transient";
  return "result";
}

export class Controller {
  constructor(private readonly deps: { store: StateStore; registry: ArtifactRegistry; planner: Planner; clock: Clock }) {}

  async commit(p: CommitParams): Promise<CommitOutcome> {
    const { store, registry, planner, clock } = this.deps;
    store.assertFencing(p.stageRun.stage_run_id, p.fencingToken);
    const run = store.getRun(p.stageRun.run_id)!;
    const ctx: ArtifactContext = { run, stageRun: p.stageRun, attempt: p.attempt, executorVersion: p.executorVersion, inputArtifactIds: p.inputArtifactIds, checkResultIds: [] };
    let kind = classifyFailure(p.result, p.verify);

    // A cancel that landed while the stage ran: nothing is staged, so no file leaves the workspace.
    const cancelRequested = () => store.getStageRun(p.stageRun.stage_run_id)?.state === "CANCEL_REQUESTED";

    // Async phase (no DB writes): move verified outputs into the artifact store.
    let staged: Awaited<ReturnType<ArtifactRegistry["stageOutputs"]>> = [];
    if (kind === null && !cancelRequested()) {
      try { staged = await registry.stageOutputs({ workspaceDir: p.workspaceDir, outputs: p.result.outputs, mimeTypes: p.mimeTypes, ctx }); }
      catch (e) { if (isHarnessError(e, "CHECKSUM_MISMATCH") || isHarnessError(e, "IO_ERROR")) kind = "result"; else throw e; }
    }

    return store.transaction(() => {
      store.assertFencing(p.stageRun.stage_run_id, p.fencingToken);
      const now = clock.now();
      const stage = store.getStageRun(p.stageRun.stage_run_id)!;
      const attempt = store.getAttempt(p.attempt.attempt_id)!;
      const ev = (type: string, severity: "info" | "warn" | "error" = "info", payload: Record<string, unknown> = {}) => eventFor(run, stage, attempt, type, severity, payload);

      // check results are always recorded
      for (const r of p.verify.results) {
        const id = newId("check_result");
        store.insertCheckResult({ schema_version: "harness.check-result/v1", check_result_id: id, check_id: r.check_id, checker_version: r.checker_version, attempt_id: attempt.attempt_id, artifact_id: null, verdict: r.verdict, evidence: r.evidence, created_at: now });
        ctx.checkResultIds.push(id);
      }
      if (stage.state === "CANCEL_REQUESTED") {
        // the run was cancelled while this attempt ran: acknowledge it, bank no cost, keep no artifact
        store.transition("attempt", attempt.attempt_id, "RUNNING", "CANCELLED", ev("attempt.cancelled", "warn"));
        store.updateAttempt({ ...store.getAttempt(attempt.attempt_id)!, finished_at: now });
        store.transition("stage_run", stage.stage_run_id, "CANCEL_REQUESTED", "CANCELLED", ev("stage.cancelled", "warn"));
        store.releaseLease(stage.stage_run_id, p.fencingToken);
        const { runState } = planner.advance(run.run_id);
        return { stageState: "CANCELLED", attemptState: "CANCELLED", runState, artifacts: [], retryScheduled: false };
      }

      const freshRun = store.getRun(run.run_id)!;
      store.updateRun({ ...freshRun, total_cost_usd: freshRun.total_cost_usd + p.result.usage.cost_usd }); // fresh read: cost captured before the await may be stale

      let artifacts: Artifact[] = [];
      let retryScheduled = false;

      if (kind === null) {
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
        artifacts = registry.commitAccepted(staged.map((s) => ({ ...s, artifact: { ...s.artifact, checks: ctx.checkResultIds } })), ctx);
        const { stale } = invalidateDownstream({ store, run, stageKey: stage.stage_key, now });
        if (stale.length) store.appendEvent(ev("stage.invalidated_downstream", "info", { stale }));
        store.transition("attempt", attempt.attempt_id, "RUNNING", "SUCCEEDED", ev("attempt.succeeded", "info", { cost_usd: p.result.usage.cost_usd }));
        store.updateAttempt({ ...store.getAttempt(attempt.attempt_id)!, finished_at: now });
        store.transition("stage_run", stage.stage_run_id, "VERIFYING", "SUCCEEDED", ev("stage.succeeded", "info", { artifacts: artifacts.map((a) => a.artifact_id) }));
      } else if (kind === "unknown") {
        this.failAttempt(attempt, kind, p.result, now);
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "WAITING_EXTERNAL", ev("stage.waiting_external", "warn"));
        store.transition("stage_run", stage.stage_run_id, "WAITING_EXTERNAL", "NEEDS_RECONCILIATION", ev("stage.needs_reconciliation", "warn", { external_operations: p.result.external_operations }));
      } else if (kind === "deferred") {
        // the executor handed the decision to a human: park the stage, no result failure, no retry
        this.failAttempt(attempt, kind, p.result, now);
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
        store.transition("stage_run", stage.stage_run_id, "VERIFYING", "WAITING_HUMAN", ev("stage.deferred", "info", { errors: p.result.errors }));
      } else if (kind === "contract") {
        this.failAttempt(attempt, kind, p.result, now);
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
        store.transition("stage_run", stage.stage_run_id, "VERIFYING", "WAITING_HUMAN", ev("stage.waiting_human", "error", { missing_checks: p.verify.missing, errors: p.result.errors }));
      } else {
        this.failAttempt(attempt, kind, p.result, now);
        if (kind === "result") {
          store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
          artifacts = registry.registerRejected({ workspaceDir: p.workspaceDir, outputs: p.result.outputs, ctx, reason: "verification failed" });
          store.transition("stage_run", stage.stage_run_id, "VERIFYING", "FAILED", ev("stage.failed", "error", { kind, checks: p.verify.results.filter((r) => r.verdict !== "pass") }));
          const s = store.getStageRun(stage.stage_run_id)!;
          store.updateStageRun({ ...s, result_failures: s.result_failures + 1 });
        } else {
          store.transition("stage_run", stage.stage_run_id, "RUNNING", "FAILED", ev("stage.failed", "error", { kind, errors: p.result.errors }));
        }
        retryScheduled = this.scheduleRetry(store.getStageRun(stage.stage_run_id)!, kind, now);
      }

      store.releaseLease(stage.stage_run_id, p.fencingToken);
      const { runState } = planner.advance(run.run_id);
      const outcome: CommitOutcome = { stageState: store.getStageRun(stage.stage_run_id)!.state, runState, attemptState: store.getAttempt(attempt.attempt_id)!.state, artifacts, retryScheduled };
      return kind ? { ...outcome, failureKind: kind } : outcome;
    });
  }

  private failAttempt(attempt: Attempt, kind: FailureKind, result: StageResult, now: string): void {
    const { store } = this.deps;
    const run = store.getRun(attempt.run_id)!;
    const stage = store.getStageRun(attempt.stage_run_id)!;
    store.transition("attempt", attempt.attempt_id, "RUNNING", "FAILED", eventFor(run, stage, attempt, "attempt.failed", "error", { kind, errors: result.errors }));
    store.updateAttempt({ ...store.getAttempt(attempt.attempt_id)!, finished_at: now, failure_kind: kind, error_summary: result.errors[0]?.message ?? `${kind} failure` });
  }

  private scheduleRetry(stage: StageRun, kind: FailureKind, now: string): boolean {
    const { store } = this.deps;
    if (!stage.retry.retry_on.includes(kind) || stage.attempt_count >= stage.retry.max_attempts) return false;
    const run = store.getRun(stage.run_id)!;
    const backoff = stage.retry.backoff_seconds[Math.min(stage.attempt_count - 1, stage.retry.backoff_seconds.length - 1)] ?? 0;
    store.transition("stage_run", stage.stage_run_id, "FAILED", "READY", eventFor(run, stage, null, "stage.retry_scheduled", "warn", { kind, backoff_seconds: backoff, attempt_count: stage.attempt_count }));
    const fresh = store.getStageRun(stage.stage_run_id)!;
    store.updateStageRun({ ...fresh, last_failure_kind: kind, ready_at: now, not_before: addSeconds(now, backoff) });
    return true;
  }
}
