import { HarnessError, newId, type Attempt, type EventInput, type HarnessConfig, type ProductionProfile, type Run, type StageRun, type StateStore } from "@harness/contracts";
import { resolveEffectiveConfig } from "../config/resolve.js";
import { isTerminal } from "../state/transitions.js";
import type { LoadedWorkflow } from "./registry.js";

export interface PlanInput {
  workflow: LoadedWorkflow; profile: ProductionProfile; harness: HarnessConfig;
  projectId: string; portfolioId: string; runOverrides?: Record<string, unknown>; channelOverrides?: Record<string, unknown>; sourceId?: string;
}

export function eventFor(run: Run, stage: StageRun | null, attempt: Attempt | null, event_type: string, severity: EventInput["severity"] = "info", payload: Record<string, unknown> = {}): EventInput {
  return {
    run_id: run.run_id, stage_run_id: stage?.stage_run_id ?? null, attempt_id: attempt?.attempt_id ?? null, project_id: run.project_id, portfolio_id: run.portfolio_id,
    channel_id: null, content_id: run.content_id ?? null, variant_id: run.variant_id ?? null,
    workflow_release: `${run.workflow_release.id}@${run.workflow_release.version}`, severity, event_type, payload,
  };
}

export class Planner {
  constructor(private readonly store: StateStore) {}

  plan(input: PlanInput): Run {
    const { snapshot, digest } = resolveEffectiveConfig({
      harness: input.harness, workflowDefaults: input.workflow.definition.defaults, profileOverrides: input.profile.overrides,
      channelOverrides: input.channelOverrides ?? {}, runOverrides: input.runOverrides ?? {}, profileMaxCostUsd: input.profile.limits.max_cost_usd_per_variant,
    });
    return this.store.transaction(() => {
      const now = (this.store as { clock?: { now(): string } }).clock?.now() ?? new Date().toISOString();
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: input.projectId, portfolio_id: input.portfolioId,
        workflow_release: { id: input.workflow.definition.id, version: input.workflow.definition.version, digest: input.workflow.digest },
        profile_snapshot: { id: input.profile.profile_id, revision: input.profile.revision },
        ...(input.sourceId ? { source_id: input.sourceId } : {}),
        state: "DRAFT", effective_config_snapshot: snapshot, effective_config_digest: digest, total_cost_usd: 0, created_at: now, updated_at: now,
      };
      this.store.insertRun(run);
      for (const s of input.workflow.definition.stages) {
        const stage: StageRun = {
          schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: s.key, executor: s.executor,
          depends_on: s.depends_on, required_capabilities: s.required_capabilities,
          required_checks: [...new Set([...s.required_checks, ...input.profile.verification.required_checks])],
          retry: s.retry, stage_config: s.config, state: "PENDING", attempt_count: 0, result_failures: 0, created_at: now, updated_at: now,
        };
        this.store.insertStageRun(stage);
      }
      this.store.appendEvent(eventFor(run, null, null, "run.created", "info", { stages: input.workflow.definition.stages.length }));
      return run;
    });
  }

  enqueue(runId: string): void {
    this.store.transaction(() => {
      const run = this.mustRun(runId);
      this.store.transition("run", runId, "DRAFT", "READY", eventFor(run, null, null, "run.enqueued"));
      for (const s of this.store.listStageRuns(runId)) if (s.depends_on.length === 0) this.ready(run, s);
    });
  }

  /** Release dependants whose dependencies all SUCCEEDED; settle the run state. Idempotent. */
  advance(runId: string): { released: string[]; runState: string } {
    return this.store.transaction(() => {
      const run = this.mustRun(runId);
      const stages = this.store.listStageRuns(runId);
      const byKey = new Map(stages.map((s) => [s.stage_key, s]));
      const released: string[] = [];
      for (const s of stages) {
        if (s.state !== "PENDING") continue;
        if (s.depends_on.every((d) => byKey.get(d)?.state === "SUCCEEDED")) { this.ready(run, s); released.push(s.stage_key); }
      }
      const fresh = this.store.listStageRuns(runId);
      const allDone = fresh.every((s) => s.state === "SUCCEEDED");
      const anyFailed = fresh.some((s) => s.state === "FAILED" || s.state === "CANCELLED");
      const anyWaiting = fresh.some((s) => s.state === "WAITING_HUMAN" || s.state === "NEEDS_RECONCILIATION");
      const anyActive = fresh.some((s) => ["READY", "CLAIMED", "RUNNING", "VERIFYING", "WAITING_EXTERNAL"].includes(s.state));
      const current = this.mustRun(runId);
      if (current.state === "RUNNING" && allDone) this.store.transition("run", runId, "RUNNING", "SUCCEEDED", eventFor(run, null, null, "run.succeeded"));
      else if (current.state === "RUNNING" && anyFailed && !anyActive) this.store.transition("run", runId, "RUNNING", "FAILED", eventFor(run, null, null, "run.failed", "error"));
      else if (current.state === "RUNNING" && anyWaiting && !anyActive) this.store.transition("run", runId, "RUNNING", "WAITING", eventFor(run, null, null, "run.waiting", "warn"));
      else if (current.state === "WAITING" && anyActive) this.store.transition("run", runId, "WAITING", "RUNNING", eventFor(run, null, null, "run.resumed"));
      return { released, runState: this.mustRun(runId).state };
    });
  }

  cancel(runId: string): void {
    this.store.transaction(() => {
      const run = this.mustRun(runId);
      for (const s of this.store.listStageRuns(runId)) {
        if (s.state === "PENDING" || s.state === "READY") this.store.transition("stage_run", s.stage_run_id, s.state, "CANCELLED", eventFor(run, s, null, "stage.cancelled", "warn"));
        else if (!isTerminal("stage_run", s.state) && s.state !== "CANCEL_REQUESTED") this.store.transition("stage_run", s.stage_run_id, s.state, "CANCEL_REQUESTED", eventFor(run, s, null, "stage.cancel_requested", "warn"));
      }
      const remaining = this.store.listStageRuns(runId).some((s) => s.state === "CANCEL_REQUESTED");
      if (run.state === "DRAFT") this.store.transition("run", runId, "DRAFT", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
      else if (!isTerminal("run", run.state)) {
        if (run.state !== "CANCEL_REQUESTED") this.store.transition("run", runId, run.state, "CANCEL_REQUESTED", eventFor(run, null, null, "run.cancel_requested", "warn"));
        if (!remaining) this.store.transition("run", runId, "CANCEL_REQUESTED", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
      }
    });
  }

  private ready(run: Run, s: StageRun): void {
    this.store.transition("stage_run", s.stage_run_id, "PENDING", "READY", eventFor(run, s, null, "stage.ready"));
    const fresh = this.store.getStageRun(s.stage_run_id)!;
    this.store.updateStageRun({ ...fresh, ready_at: fresh.updated_at });
  }
  private mustRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
    return run;
  }
}
