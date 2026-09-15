import type { Clock, ContentRequest, ExecutorRef, HarnessConfig, LibraryBrief, ProductionProfile, SourceItem, StageDefinition, StateStore } from "@harness/contracts";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import { isTerminal } from "../state/transitions.js";
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

/** Event reasons that get the once-per-request dedup treatment (see `skipOnce` below): the two conditions
 * that would otherwise fire on every single auto-accept poll for as long as they hold (an empty source
 * collection, a request that burned through its replan budget), unlike "run-active"/"concurrency"/the
 * style checks which are ordinary steady-state conditions that clear on their own. */
const DEDUPED_SKIP_REASONS = new Set<AutoAcceptSkipReason>(["no-source", "exhausted"]);

function requestIdForRun(store: StateStore, run: { content_id?: string | undefined }): string | undefined {
  if (!run.content_id) return undefined;
  return store.getContentItem(run.content_id)?.library_brief?.request_id;
}

/**
 * Partitions every run into "active" (request_id -> still has a non-terminal run) and "finished" (request_id
 * -> count of terminal runs), using `isTerminal("run", state)` (`../state/transitions.ts`) rather than two
 * hand-maintained state allowlists -- a `DRAFT` run (planned by hand via `harness plan`, not yet enqueued) or
 * one sitting in `CANCEL_REQUESTED` is non-terminal and must count as active, or the loop would plan a
 * duplicate run for the same open request. `finishedRunCounts` is also reused by the dashboard's
 * `request_stuck` alert (`../dashboard/snapshot.ts`).
 */
function partitionRunsByRequest(store: StateStore): { active: Set<string>; activeCount: number; finished: Map<string, number> } {
  const active = new Set<string>();
  const finished = new Map<string, number>();
  let activeCount = 0;
  for (const run of store.listRuns({})) {
    const requestId = requestIdForRun(store, run);
    if (!requestId) continue;
    if (isTerminal("run", run.state)) finished.set(requestId, (finished.get(requestId) ?? 0) + 1);
    else { active.add(requestId); activeCount++; }
  }
  return { active, activeCount, finished };
}

/** request_id -> count of finished (terminal) runs whose content carries that request_id in its
 * `library_brief` -- the replan count both `autoAccept`'s own "exhausted" gate and the dashboard's
 * `request_stuck` alert (`../dashboard/snapshot.ts`) key off of. */
export function finishedRunCounts(store: StateStore): Map<string, number> {
  return partitionRunsByRequest(store).finished;
}

/** Source ids already earmarked (via a `ContentItem.library_brief.request_id`) by an open or claimed
 * request, grouped by owning request so a caller can subtract "my own sources don't count as busy against
 * myself" per request without re-scanning `listContentItems()` for every request in the loop. */
function busySourceIdsByRequest(store: StateStore): { global: Set<string>; own: Map<string, Set<string>> } {
  const openOrClaimed = new Set(
    [...store.listContentRequests({ status: "open" }), ...store.listContentRequests({ status: "claimed" })].map((r) => r.request_id),
  );
  const global = new Set<string>();
  const own = new Map<string, Set<string>>();
  for (const item of store.listContentItems()) {
    const requestId = item.library_brief?.request_id;
    if (!requestId) continue;
    let mine = own.get(requestId);
    if (!mine) { mine = new Set(); own.set(requestId, mine); }
    for (const id of item.source_ids) mine.add(id);
    if (openOrClaimed.has(requestId)) for (const id of item.source_ids) global.add(id);
  }
  return { global, own };
}

/** Picks the source an auto-accepted request should run against (spec §5). An explicit `source_hint.source_ids`
 * wins outright -- the first one that still exists and is not rights-restricted, `busySourceIds` does not apply
 * because the request named it directly. Otherwise the request's `source_hint.collection` (or
 * `defaultCollection`) is searched for the most recently ingested item that is not rights-restricted and not
 * already busy. */
export function pickSource(store: StateStore, p: { request: ContentRequest; defaultCollection: string; busySourceIds: Set<string> }): SourceItem | undefined {
  const hint = p.request.source_hint;
  if (hint?.source_ids?.length) {
    for (const id of hint.source_ids) {
      const source = store.getSourceItem(id);
      if (source && source.rights_status !== "restricted") return source;
    }
    return undefined;
  }
  const collection = hint?.collection ?? p.defaultCollection;
  const candidates = store.listSourceItems({ collection }).filter((s) => s.rights_status !== "restricted" && !p.busySourceIds.has(s.source_id));
  return candidates.sort((a, b) => (a.ingested_at < b.ingested_at ? 1 : a.ingested_at > b.ingested_at ? -1 : 0))[0];
}

/** `listEvents({ event_type, newest: true })` scans only rows matching that column (a real indexed-free but
 * dedicated `event` table column, not a `json_extract` scan of every event ever recorded) ordered newest
 * first, so this dedup check stays cheap and correct regardless of how many *other* events the project has
 * accumulated -- unlike an unfiltered `listEvents({})`, which silently stops seeing old rows past its
 * `limit` once a project passes that many total events. */
function skipOnce(d: AutoAcceptDeps, requestId: string, reason: AutoAcceptSkipReason): void {
  if (!DEDUPED_SKIP_REASONS.has(reason)) return;
  const already = d.store.listEvents({ event_type: "request.auto_accept_skipped", newest: true }).some((e) => e.payload.request_id === requestId && e.payload.reason === reason);
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

  const { active: activeRequestIds, finished, activeCount: initialActiveCount } = partitionRunsByRequest(store);
  let activeCount = initialActiveCount;
  // Hoisted once (not re-scanned per request, per fix-round-1 finding #4): `global` is mutated in place as
  // requests are accepted below, so a source picked for one request is immediately busy for the next.
  const { global: busy, own: ownSources } = busySourceIdsByRequest(store);

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

    // this request's own sources (if any, e.g. from a prior reopen) never count as busy against itself
    const busyForThisRequest = new Set(busy);
    for (const id of ownSources.get(request.request_id) ?? []) busyForThisRequest.delete(id);
    const source = pickSource(store, { request, defaultCollection: d.config.source_collection, busySourceIds: busyForThisRequest });
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
      // Atomic: a `planner.plan` throw (e.g. a bad `workflows(ref)` lookup) must leave no trace -- an orphan
      // ContentItem/ContentVariant would otherwise poison `busy` for every other request in this and later
      // polls, and this same request would be retried (and fail) every poll from then on (fix-round-1 #3).
      store.transaction(() => {
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
        busy.add(source.source_id);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      d.logger.error("auto-accept: plan failed", { request_id: request.request_id, error: message });
      // Appended *outside* the rolled-back transaction above: the failure record must survive even though
      // everything else that attempt did was undone.
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
