import type { ContentItem, ExecutorRef, HarnessConfig, ProductionProfile, Run, StageDefinition, StateStore } from "@harness/contracts";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";

/**
 * Common dependencies for starting a planned run against an already-created `ContentItem`: resolve/create its
 * variant, plan the run against a workflow, enqueue it, and record one event carrying the new run's id. Shared
 * by `autoAccept` (studio autopilot), `planRequestsRun` and `autoPick` (channel learning loop) so the
 * variant/plan/enqueue/event sequence -- and its exact field shape -- lives in one place instead of three.
 */
export interface StartRunDeps {
  store: StateStore; catalog: SourceCatalog; planner: Planner; harness: HarnessConfig; projectId: string; portfolioId: string;
  profile: ProductionProfile; workflows: (ref: string) => LoadedWorkflow; executorVersionFor: (ref: ExecutorRef) => string;
  requiresResourcesOverride?: (s: StageDefinition) => string[] | undefined;
}

export interface StartRunEvent {
  event_type: string;
  channel_id: string | null;
  /** Built from the freshly-minted run id: every caller embeds `run_id` inside its own payload shape too (in
   * addition to the event's own `run_id` column), which is only known once `planner.plan` has run. */
  payload: (runId: string) => Record<string, unknown>;
}

export function startPlannedRun(d: StartRunDeps, content: ContentItem, event: StartRunEvent, options: Record<string, unknown> = {}): Run {
  const { variant } = d.catalog.getOrCreateVariant({ content_id: content.content_id, profile: d.profile, options });
  const run = d.planner.plan({
    workflow: d.workflows(d.profile.workflow_release), profile: d.profile, harness: d.harness, projectId: d.projectId,
    portfolioId: d.portfolioId, runOverrides: {}, executorVersionFor: d.executorVersionFor, content, variant,
    ...(d.requiresResourcesOverride ? { requiresResourcesOverride: d.requiresResourcesOverride } : {}),
  });
  d.planner.enqueue(run.run_id);
  d.store.appendEvent({
    run_id: run.run_id, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: d.portfolioId,
    channel_id: event.channel_id, content_id: content.content_id, variant_id: variant.variant_id, workflow_release: d.profile.workflow_release,
    severity: "info", event_type: event.event_type, payload: event.payload(run.run_id),
  });
  return run;
}
