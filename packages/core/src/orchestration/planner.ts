import { HarnessError, newId, type Artifact, type Attempt, type Checksum, type ContentItem, type ContentVariant, type EventInput, type ExecutorRef, type HarnessConfig, type ProductionProfile, type Run, type StageDefinition, type StageRun, type StateStore } from "@harness/contracts";
import { resolveEffectiveConfig } from "../config/resolve.js";
import { isTerminal } from "../state/transitions.js";
import { evaluateWhen, parseWhen } from "../source-catalog/when.js";
import { budgetBlocks } from "./budget.js";
import { computeCacheKey, findReusableArtifacts, stageDefinitionDigest, tryLateReuse } from "./cache.js";
import type { LoadedWorkflow } from "./registry.js";

export interface PlanInput {
  workflow: LoadedWorkflow; profile: ProductionProfile; harness: HarnessConfig;
  projectId: string; portfolioId: string; runOverrides?: Record<string, unknown>; channelOverrides?: Record<string, unknown>;
  sourceId?: string; content?: ContentItem; variant?: ContentVariant; reuse?: boolean;
  /** Overrides a stage's `requires_resources` from the workflow definition; `undefined` keeps the workflow's own value. */
  requiresResourcesOverride?: (stage: StageDefinition) => string[] | undefined;
  /**
   * Resolves the executor version a stage would run at, so `plan()` can compute the same cache key the
   * controller will write at commit (spec §3.3 folds `executor_version` into the key). Without it the
   * planner cannot know that version, so reuse is skipped entirely rather than computing a key that
   * could never match — callers that want reuse must supply it.
   */
  executorVersionFor?: (ref: ExecutorRef) => string;
}

export function eventFor(run: Run, stage: StageRun | null, attempt: Attempt | null, event_type: string, severity: EventInput["severity"] = "info", payload: Record<string, unknown> = {}): EventInput {
  return {
    run_id: run.run_id, stage_run_id: stage?.stage_run_id ?? null, attempt_id: attempt?.attempt_id ?? null, project_id: run.project_id, portfolio_id: run.portfolio_id,
    channel_id: null, content_id: run.content_id ?? null, variant_id: run.variant_id ?? null,
    workflow_release: `${run.workflow_release.id}@${run.workflow_release.version}`, severity, event_type, payload,
  };
}

/** No worker holds these, so cancel takes them straight to CANCELLED. */
const CANCELLABLE_NOW = ["PENDING", "READY", "WAITING_HUMAN", "WAITING_EXTERNAL", "NEEDS_RECONCILIATION"];
/** A worker holds the lease: it must acknowledge the cancel (or its lease must expire) before the stage is CANCELLED. */
const HELD_BY_WORKER = ["CLAIMED", "RUNNING", "VERIFYING"];

/** Stages whose `when` is false are dropped; dependants inherit the dropped stage's own dependencies (transitively). */
export function resolveStageGraph(stages: StageDefinition[], options: Record<string, unknown>): { kept: { def: StageDefinition; depends_on: string[]; depends_on_optional: string[] }[]; skipped: string[] } {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const skipped = new Set(stages.filter((s) => s.when && !evaluateWhen(s.when, options)).map((s) => s.key));
  const expand = (deps: string[], seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const d of deps) {
      if (!skipped.has(d)) { if (!out.includes(d)) out.push(d); continue; }
      if (seen.has(d)) continue;
      seen.add(d);
      for (const x of expand(byKey.get(d)!.depends_on, seen)) if (!out.includes(x)) out.push(x);
    }
    return out;
  };
  const kept = stages.filter((s) => !skipped.has(s.key)).map((def) => ({
    def,
    depends_on: expand(def.depends_on),
    depends_on_optional: def.depends_on_optional.filter((d) => !skipped.has(d)),
  }));
  // a required dependency must not also be listed as optional after rewiring
  for (const k of kept) k.depends_on_optional = k.depends_on_optional.filter((d) => !k.depends_on.includes(d));
  return { kept, skipped: [...skipped] };
}

export class Planner {
  constructor(private readonly store: StateStore) {}

  plan(input: PlanInput): Run {
    const options = input.variant?.options ?? input.profile.options_defaults;
    for (const s of input.workflow.definition.stages) {
      if (!s.when) continue;
      const { key } = parseWhen(s.when);
      if (!(key in input.profile.options_schema)) throw new HarnessError("CONFIG_INVALID", `stage ${s.key}: when references option "${key}" not declared by profile ${input.profile.profile_id}`, { stage: s.key, key });
    }
    const { snapshot, digest } = resolveEffectiveConfig({
      harness: input.harness, workflowDefaults: input.workflow.definition.defaults, profileOverrides: input.profile.overrides,
      channelOverrides: input.channelOverrides ?? {}, runOverrides: input.runOverrides ?? {}, profileMaxCostUsd: input.profile.limits.max_cost_usd_per_variant,
    });
    const graph = resolveStageGraph(input.workflow.definition.stages, options);
    return this.store.transaction(() => {
      const now = (this.store as { clock?: { now(): string } }).clock?.now() ?? new Date().toISOString();
      const sourceId = input.sourceId ?? input.content?.source_ids[0];
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: input.projectId, portfolio_id: input.portfolioId,
        workflow_release: { id: input.workflow.definition.id, version: input.workflow.definition.version, digest: input.workflow.digest },
        profile_snapshot: { id: input.profile.profile_id, revision: input.profile.revision },
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(input.content ? { content_id: input.content.content_id } : {}),
        ...(input.variant ? { variant_id: input.variant.variant_id } : {}),
        options, state: "DRAFT", effective_config_snapshot: snapshot, effective_config_digest: digest, total_cost_usd: 0,
        budget_usd: input.profile.limits.max_cost_usd_per_variant, created_at: now, updated_at: now,
      };
      this.store.insertRun(run);
      const reuse = (input.reuse ?? input.profile.reuse === "allow") && !!input.executorVersionFor;
      const reusable = new Map<string, Artifact[]>();
      for (const { def: s, depends_on, depends_on_optional } of graph.kept) {
        let reused: Artifact[] | undefined;
        let stageCacheKey: Checksum | undefined;
        const reuseEligible = reuse && !!input.variant && s.executor.type !== "gate";
        const expectedExecutorVersion = input.executorVersionFor?.(s.executor);
        const defDigest = stageDefinitionDigest(s);
        if (reuseEligible && input.variant) {
          const deps = [...depends_on, ...depends_on_optional];
          if (deps.every((d) => reusable.has(d))) {
            const inputChecksums = deps.flatMap((d) => reusable.get(d)!.map((a) => a.checksum));
            const cacheKey = computeCacheKey({ stageDefinitionDigest: defDigest, inputChecksums, optionsDigest: input.variant.options_digest, effectiveConfigDigest: digest, executorVersion: expectedExecutorVersion! });
            const found = findReusableArtifacts(this.store, { variantId: input.variant.variant_id, stageKey: s.key, cacheKey, excludeRunId: run.run_id });
            if (found.length) { reused = found; reusable.set(s.key, found); stageCacheKey = cacheKey; }
          }
        }
        const stage: StageRun = {
          schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: s.key, executor: s.executor,
          depends_on, depends_on_optional, requires_resources: input.requiresResourcesOverride?.(s) ?? s.requires_resources, required_capabilities: s.required_capabilities,
          required_checks: [...new Set([...s.required_checks, ...input.profile.verification.required_checks, ...(input.profile.verification.required_checks_by_stage[s.key] ?? [])])],
          retry: s.retry, stage_config: s.config, state: reused ? "SUCCEEDED" : "PENDING", attempt_count: 0, result_failures: 0, created_at: now, updated_at: now,
          ...(s.gate_deadline_seconds ? { gate_deadline_seconds: s.gate_deadline_seconds } : {}),
          // what a later cache lookup at release needs, recorded now while the definition is in hand
          stage_definition_digest: defDigest, reuse_eligible: reuseEligible,
          ...(expectedExecutorVersion ? { expected_executor_version: expectedExecutorVersion } : {}),
          ...(reused ? { reused_artifact_ids: reused.map((a) => a.artifact_id), cache_key: stageCacheKey } : {}),
        };
        this.store.insertStageRun(stage);
        if (reused) this.store.appendEvent(eventFor(run, stage, null, "stage.reused", "info", { artifacts: reused.map((a) => a.artifact_id), cache_key: stageCacheKey }));
      }
      this.store.appendEvent(eventFor(run, null, null, "run.created", "info", { stages: graph.kept.length, skipped_stages: graph.skipped, options }));
      return run;
    });
  }

  enqueue(runId: string): void {
    this.store.transaction(() => {
      const run = this.mustRun(runId);
      this.store.transition("run", runId, "DRAFT", "READY", eventFor(run, null, null, "run.enqueued"));
      const gate = budgetBlocks(this.store, run);
      // release root stages, and any stage whose dependencies were already satisfied by reuse at plan time
      this.releaseReady(run, gate.blocked);
      const fresh = this.store.listStageRuns(runId);
      // every stage came from the cache: no worker will ever claim anything here, so settle the run now
      if (fresh.every((s) => s.state === "SUCCEEDED")) {
        this.store.transition("run", runId, "READY", "RUNNING", eventFor(run, null, null, "run.started", "info", { reason: "all_stages_reused" }));
        this.store.transition("run", runId, "RUNNING", "SUCCEEDED", eventFor(run, null, null, "run.succeeded"));
      } else if (gate.blocked && fresh.some((s) => s.state === "PENDING") && !fresh.some((s) => s.state === "READY")) {
        // the variant already spent its whole budget before this run existed: skip straight to WAITING
        this.store.transition("run", runId, "READY", "RUNNING", eventFor(run, null, null, "run.started", "info", { reason: "budget_check" }));
        this.store.transition("run", runId, "RUNNING", "WAITING", eventFor(run, null, null, "run.budget_exceeded", "warn", { spent: gate.spent, budget: gate.budget }));
      }
    });
  }

  /** Release dependants whose dependencies all SUCCEEDED; settle the run state. Idempotent. */
  advance(runId: string): { released: string[]; runState: string } {
    return this.store.transaction(() => {
      const run = this.mustRun(runId);
      if (run.state === "CANCEL_REQUESTED") return { released: [], runState: this.settleCancel(run) };
      const gate = budgetBlocks(this.store, run);
      const released = this.releaseReady(run, gate.blocked);
      const fresh = this.store.listStageRuns(runId);
      const allDone = fresh.every((s) => s.state === "SUCCEEDED");
      const anyFailed = fresh.some((s) => s.state === "FAILED" || s.state === "CANCELLED");
      const anyWaiting = fresh.some((s) => s.state === "WAITING_HUMAN" || s.state === "NEEDS_RECONCILIATION");
      const anyActive = fresh.some((s) => ["READY", "CLAIMED", "RUNNING", "VERIFYING", "WAITING_EXTERNAL"].includes(s.state));
      const anyPending = fresh.some((s) => s.state === "PENDING");
      const current = this.mustRun(runId);
      if (gate.blocked && current.state === "RUNNING" && !anyActive && anyPending) this.store.transition("run", runId, "RUNNING", "WAITING", eventFor(run, null, null, "run.budget_exceeded", "warn", { spent: gate.spent, budget: gate.budget }));
      else if (current.state === "RUNNING" && allDone) this.store.transition("run", runId, "RUNNING", "SUCCEEDED", eventFor(run, null, null, "run.succeeded"));
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
        if (CANCELLABLE_NOW.includes(s.state)) this.store.transition("stage_run", s.stage_run_id, s.state, "CANCELLED", eventFor(run, s, null, "stage.cancelled", "warn"));
        else if (HELD_BY_WORKER.includes(s.state)) this.store.transition("stage_run", s.stage_run_id, s.state, "CANCEL_REQUESTED", eventFor(run, s, null, "stage.cancel_requested", "warn"));
        // already CANCEL_REQUESTED or terminal: nothing to do
      }
      if (run.state === "DRAFT") this.store.transition("run", runId, "DRAFT", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
      else if (!isTerminal("run", run.state)) {
        if (run.state !== "CANCEL_REQUESTED") this.store.transition("run", runId, run.state, "CANCEL_REQUESTED", eventFor(run, null, null, "run.cancel_requested", "warn"));
        this.settleCancel(run); // nothing left to acknowledge -> straight to CANCELLED
      }
    });
  }

  /** A CANCEL_REQUESTED run becomes CANCELLED as soon as no stage is still held or still owes an acknowledgement. */
  private settleCancel(run: Run): string {
    const pending = this.store.listStageRuns(run.run_id).some((s) => ["CANCEL_REQUESTED", ...HELD_BY_WORKER, "WAITING_EXTERNAL"].includes(s.state));
    if (!pending) this.store.transition("run", run.run_id, "CANCEL_REQUESTED", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
    return this.mustRun(run.run_id).state;
  }

  /**
   * Every PENDING stage whose dependencies all SUCCEEDED either comes from the cache (settled SUCCEEDED
   * without ever being dispatched) or goes READY. Reusing a stage can satisfy its own dependants, so the
   * sweep repeats until nothing changes — a whole tail of the graph can settle in one call.
   * Returns the stage keys actually released to a worker.
   */
  private releaseReady(run: Run, budgetBlocked: boolean): string[] {
    const released: string[] = [];
    if (budgetBlocked) return released;
    for (;;) {
      const stages = this.store.listStageRuns(run.run_id);
      const byKey = new Map(stages.map((s) => [s.stage_key, s]));
      let reusedAny = false;
      for (const s of stages) {
        if (s.state !== "PENDING") continue;
        const deps = [...s.depends_on, ...s.depends_on_optional];
        if (!deps.every((d) => byKey.get(d)?.state === "SUCCEEDED")) continue;
        const hit = tryLateReuse(this.store, run, s);
        if (!hit) { this.ready(run, s); released.push(s.stage_key); continue; }
        const ids = hit.artifacts.map((a) => a.artifact_id);
        this.store.transition("stage_run", s.stage_run_id, "PENDING", "SUCCEEDED", eventFor(run, s, null, "stage.reused", "info", { artifacts: ids, cache_key: hit.cacheKey, at: "release" }));
        const fresh = this.store.getStageRun(s.stage_run_id)!;
        this.store.updateStageRun({ ...fresh, reused_artifact_ids: ids, cache_key: hit.cacheKey });
        reusedAny = true;
      }
      if (!reusedAny) return released;
    }
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
