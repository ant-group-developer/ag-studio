import type { Clock, ContentRequest, ExecutorRef, HarnessConfig, LibraryBrief, ProductionProfile, SourceItem, StageDefinition, StateStore } from "@harness/contracts";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import type { LibraryFs } from "./files.js";

/** `project.yaml`'s `library.auto_accept` (spec: sub-project 4). */
export interface AutoAcceptConfig { enabled: boolean; source_collection: string; max_replans: number; max_concurrent_runs: number }

/** Minimal logger shape `autoAccept` needs -- `HarnessLogger` satisfies it structurally. */
export interface AutoAcceptLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface AutoAcceptDeps {
  store: StateStore;
  fs: LibraryFs;
  catalog: SourceCatalog;
  planner: Planner;
  clock: Clock;
  harness: HarnessConfig;
  projectId: string;
  portfolioId: string;
  profile: ProductionProfile;
  workflows: (ref: string) => LoadedWorkflow;
  executorVersionFor: (ref: ExecutorRef) => string;
  requiresResourcesOverride?: (s: StageDefinition) => string[] | undefined;
  config: AutoAcceptConfig;
  logger: AutoAcceptLogger;
}

export type AutoAcceptSkipReason = "no-style" | "style-inactive" | "run-active" | "exhausted" | "no-source" | "concurrency" | "plan-failed";

export interface AutoAcceptReport {
  accepted: { request_id: string; run_id: string; replan_no: number; source_id: string }[];
  skipped: { request_id: string; reason: AutoAcceptSkipReason }[];
}

const ACTIVE_RUN_STATES = ["RUNNING", "READY", "WAITING"] as const;
const FINISHED_RUN_STATES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
/** Event reasons that get the once-per-request dedup treatment (see `skipOnce` below): the two conditions
 * that would otherwise fire on every single auto-accept poll for as long as they hold (an empty source
 * collection, a request that burned through its replan budget), unlike "run-active"/"concurrency"/the
 * style checks which are ordinary steady-state conditions that clear on their own. */
const DEDUPED_SKIP_REASONS = new Set<AutoAcceptSkipReason>(["no-source", "exhausted"]);

function requestIdForRun(store: StateStore, run: { content_id?: string | undefined }): string | undefined {
  if (!run.content_id) return undefined;
  return store.getContentItem(run.content_id)?.library_brief?.request_id;
}

/** request_id -> count of finished (SUCCEEDED|FAILED|CANCELLED) runs whose content carries that request_id
 * in its `library_brief` -- the replan count both `autoAccept`'s own "exhausted" gate and the dashboard's
 * `request_stuck` alert (`../dashboard/snapshot.ts`) key off of. */
export function finishedRunCounts(store: StateStore): Map<string, number> {
  const counts = new Map<string, number>();
  for (const state of FINISHED_RUN_STATES) {
    for (const run of store.listRuns({ state })) {
      const requestId = requestIdForRun(store, run);
      if (!requestId) continue;
      counts.set(requestId, (counts.get(requestId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Source ids already earmarked (via a `ContentItem.library_brief.request_id`) by some *other* open or
 * claimed request -- a source picked for one request should not be handed to a different one in the same
 * pass, or to a later poll while the first request's run is still in flight. */
function busySourceIds(store: StateStore, excludeRequestId: string): Set<string> {
  const openOrClaimed = new Set(
    [...store.listContentRequests({ status: "open" }), ...store.listContentRequests({ status: "claimed" })].map((r) => r.request_id),
  );
  const busy = new Set<string>();
  for (const item of store.listContentItems()) {
    const requestId = item.library_brief?.request_id;
    if (!requestId || requestId === excludeRequestId || !openOrClaimed.has(requestId)) continue;
    for (const id of item.source_ids) busy.add(id);
  }
  return busy;
}

/** Picks the source an auto-accepted request should run against (spec §5). An explicit `source_hint.source_ids`
 * wins outright -- the first one that still exists, `busySourceIds` does not apply because the request named it
 * directly. Otherwise the request's `source_hint.collection` (or `defaultCollection`) is searched for the most
 * recently ingested item that is not rights-restricted and not already busy. */
export function pickSource(store: StateStore, p: { request: ContentRequest; defaultCollection: string; busySourceIds: Set<string> }): SourceItem | undefined {
  const hint = p.request.source_hint;
  if (hint?.source_ids?.length) {
    for (const id of hint.source_ids) {
      const source = store.getSourceItem(id);
      if (source) return source;
    }
    return undefined;
  }
  const collection = hint?.collection ?? p.defaultCollection;
  const candidates = store.listSourceItems({ collection }).filter((s) => s.rights_status !== "restricted" && !p.busySourceIds.has(s.source_id));
  return candidates.sort((a, b) => (a.ingested_at < b.ingested_at ? 1 : a.ingested_at > b.ingested_at ? -1 : 0))[0];
}

function skipOnce(d: AutoAcceptDeps, requestId: string, reason: AutoAcceptSkipReason): void {
  if (!DEDUPED_SKIP_REASONS.has(reason)) return;
  const already = d.store.listEvents({}).some((e) => e.event_type === "request.auto_accept_skipped" && e.payload.request_id === requestId && e.payload.reason === reason);
  if (already) return;
  d.store.appendEvent({
    run_id: null, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: d.portfolioId, channel_id: null,
    content_id: null, variant_id: null, workflow_release: null, severity: "warn", event_type: "request.auto_accept_skipped",
    payload: { request_id: requestId, reason },
  });
}

/**
 * Studio autopilot loop (spec §5): claims no request itself (`intake` still does that later in the plan)
 * -- it only ever writes through `catalog.createContent`, `catalog.getOrCreateVariant`, `planner.plan`,
 * `planner.enqueue` and `store.appendEvent`. A single request's plan failure is caught, logged and reported
 * as `plan-failed`; it never aborts the rest of the loop.
 */
export async function autoAccept(d: AutoAcceptDeps): Promise<AutoAcceptReport> {
  const { store } = d;
  const report: AutoAcceptReport = { accepted: [], skipped: [] };

  const activeRequestIds = new Set<string>();
  let activeCount = 0;
  for (const state of ACTIVE_RUN_STATES) {
    for (const run of store.listRuns({ state })) {
      const requestId = requestIdForRun(store, run);
      if (!requestId) continue;
      activeRequestIds.add(requestId);
      activeCount++;
    }
  }

  const finished = finishedRunCounts(store);
  const openRequests = [...store.listContentRequests({ status: "open" })].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  for (const request of openRequests) {
    if (!request.style_id) { report.skipped.push({ request_id: request.request_id, reason: "no-style" }); continue; }
    const style = store.getEditStyle(request.style_id);
    if (style?.status !== "active") { report.skipped.push({ request_id: request.request_id, reason: "style-inactive" }); continue; }
    if (activeRequestIds.has(request.request_id)) { report.skipped.push({ request_id: request.request_id, reason: "run-active" }); continue; }

    const replanNo = finished.get(request.request_id) ?? 0;
    if (replanNo > d.config.max_replans) {
      report.skipped.push({ request_id: request.request_id, reason: "exhausted" });
      skipOnce(d, request.request_id, "exhausted");
      continue;
    }
    if (activeCount >= d.config.max_concurrent_runs) {
      report.skipped.push({ request_id: request.request_id, reason: "concurrency" });
      break; // no point checking the rest of the queue against a gate that will not move this poll
    }

    const source = pickSource(store, { request, defaultCollection: d.config.source_collection, busySourceIds: busySourceIds(store, request.request_id) });
    if (!source) {
      report.skipped.push({ request_id: request.request_id, reason: "no-source" });
      skipOnce(d, request.request_id, "no-source");
      continue;
    }

    try {
      const libraryBrief: LibraryBrief = {
        topic: request.topic, style_id: style.style_id, style_revision: style.revision, voice: request.voice, language: request.language,
        ...(request.target_duration_seconds ? { target_duration_seconds: request.target_duration_seconds } : {}),
        request_id: request.request_id,
      };
      const content = d.catalog.createContent({ source_ids: [source.source_id], title: request.topic, library_brief: libraryBrief });
      const { variant } = d.catalog.getOrCreateVariant({ content_id: content.content_id, profile: d.profile, options: { voice: request.voice } });
      const run = d.planner.plan({
        workflow: d.workflows(d.profile.workflow_release), profile: d.profile, harness: d.harness, projectId: d.projectId, portfolioId: d.portfolioId,
        runOverrides: {}, executorVersionFor: d.executorVersionFor, content, variant,
        ...(d.requiresResourcesOverride ? { requiresResourcesOverride: d.requiresResourcesOverride } : {}),
      });
      d.planner.enqueue(run.run_id);
      store.appendEvent({
        run_id: run.run_id, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: d.portfolioId, channel_id: null,
        content_id: content.content_id, variant_id: variant.variant_id, workflow_release: d.profile.workflow_release,
        severity: "info", event_type: "request.auto_accepted",
        payload: { request_id: request.request_id, run_id: run.run_id, replan_no: replanNo, source_id: source.source_id },
      });
      report.accepted.push({ request_id: request.request_id, run_id: run.run_id, replan_no: replanNo, source_id: source.source_id });
      activeRequestIds.add(request.request_id);
      activeCount++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      d.logger.error("auto-accept: plan failed", { request_id: request.request_id, error: message });
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: d.portfolioId, channel_id: null,
        content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "request.auto_accept_failed",
        payload: { request_id: request.request_id, reason: message },
      });
      report.skipped.push({ request_id: request.request_id, reason: "plan-failed" });
    }
  }

  return report;
}
