import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock, ContentRequest, ExecutorRef, HarnessConfig, LibraryBrief, ProductionProfile, SourceItem, StageDefinition, StateStore } from "@harness/contracts";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import { isTerminal } from "../state/transitions.js";
import type { LibraryFs } from "./files.js";
import { startPlannedRun } from "./start-run.js";

/** `project.yaml`'s `library.auto_accept` (spec: sub-project 4, extended sub-project 5A with `source_collections`
 * and `max_sources` -- see `autoAcceptSchema`/`autoAcceptPatterns` in `@harness/contracts`). */
export interface AutoAcceptConfig {
  enabled: boolean;
  source_collection: string;
  // `| undefined` alongside the `?` matches zod's own `.optional()` output type (exactOptionalPropertyTypes):
  // `project.library.auto_accept` (the actual runtime value this field is filled from) is typed that way.
  source_collections?: string[] | undefined;
  max_replans: number;
  max_concurrent_runs: number;
  max_sources: number;
  /** Pins the autopilot to a specific workflow release instead of `profile.workflow_release` (spec: task 8
   * rollback knob). `| undefined` alongside the `?` matches zod's own `.optional()` output type
   * (exactOptionalPropertyTypes), same as `source_collections` above. */
  workflow_release?: string | undefined;
}

/** Minimal logger shape `autoAccept` needs -- `HarnessLogger` satisfies it structurally. */
export interface AutoAcceptLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Which sources an accepted request may draw from, and how busy/used tracking works: two distinct modes, not
 * one unified algorithm (controller ruling, task-7 fix round).
 *  - `"legacy"`: byte-identical to sub-project 4 -- one source per request (`pickSource` below), busy tracked
 *    per source (`busySourceIdsByRequest`). Every project that has not set `source_collections` runs this way,
 *    including every SP1-3B fixture/test, which must see no behavioural difference at all.
 *  - `"collections"`: sub-project 5A's whole-shoot-collection flow -- every usable source of a matched
 *    collection (`pickSources` below), busy/used tracked per collection with an own-request exemption so a
 *    replan re-picks the same shoot instead of being permanently locked out of it.
 * Resolved once by the caller (composition root / `commands/worker.ts`) from `config`, not re-derived inside
 * `autoAccept()`.
 */
export type AutoAcceptSources = { mode: "legacy"; collection: string } | { mode: "collections"; patterns: string[]; maxSources: number };

export interface AutoAcceptDeps {
  store: StateStore;
  fs: LibraryFs;
  catalog: SourceCatalog;
  planner: Planner;
  clock: Clock;
  harness: HarnessConfig;
  projectId: string;
  /** Fallback portfolio for anything not tied to one request (and for `portfolioFor` to fall back on). */
  portfolioId: string;
  /** Portfolio a given request's run and events belong to. Without it every auto-accepted run was stamped
   * with the project's first portfolio, losing the requesting portfolio on multi-portfolio studios; the CLI
   * passes the request's own `requested_by.portfolio_id` when the project declares it. */
  portfolioFor?: (request: ContentRequest) => string;
  profile: ProductionProfile;
  workflows: (ref: string) => LoadedWorkflow;
  executorVersionFor: (ref: ExecutorRef) => string;
  requiresResourcesOverride?: (s: StageDefinition) => string[] | undefined;
  config: AutoAcceptConfig;
  sources: AutoAcceptSources;
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
 * myself" per request without re-scanning `listContentItems()` for every request in the loop. Legacy mode
 * only (restored verbatim from before sub-project 5A, see the controller ruling in the task-7 fix round: a
 * legacy project must see no behavioural difference at all). */
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

/** Picks the ONE source a legacy-mode auto-accepted request should run against (spec §5, sub-project 4,
 * restored verbatim -- sub-project 5A's whole-collection picking is `pickSources` below, a different mode
 * entirely). An explicit `source_hint.source_ids` wins outright -- the first one that still exists and is not
 * rights-restricted, `busySourceIds` does not apply because the request named it directly. Otherwise the
 * request's `source_hint.collection` (or `defaultCollection`) is searched for the most recently ingested item
 * that is not rights-restricted and not already busy. */
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

/** request_ids that already have at least one ContentItem carrying their `library_brief.request_id` -- the
 * window between a ContentItem being created (by `harness library accept` or a prior `autoAccept` pass) and a
 * run actually being enqueued for it. Shared by both modes for the "run-active" check below (only membership
 * is needed there, not which sources/collections). */
function requestsWithContent(store: StateStore): Set<string> {
  const s = new Set<string>();
  for (const item of store.listContentItems()) {
    const requestId = item.library_brief?.request_id;
    if (requestId) s.add(requestId);
  }
  return s;
}

/** Glob match for a kho collection name against one of `library.auto_accept.source_collections` (spec: sub-project
 * 5A, `*` is the only wildcard). Every other regex metacharacter in `pattern` is escaped; `name` and `pattern`
 * are compared as whole strings (anchored both ends). */
export function matchCollection(name: string, pattern: string): boolean {
  const body = pattern.split("*").map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]*");
  return new RegExp(`^${body}$`).test(name);
}

function collectionsOfContent(store: StateStore, contentId: string | undefined): string[] {
  if (!contentId) return [];
  const content = store.getContentItem(contentId);
  if (!content) return [];
  const collections: string[] = [];
  for (const id of content.source_ids) {
    const source = store.getSourceItem(id);
    if (source) collections.push(source.collection);
  }
  return collections;
}

/**
 * Collection-mode busy/used tracking (spec: sub-project 5A §5, corrected by the controller ruling in the
 * task-7 fix round): for every kho collection, which request_ids are "responsible" for it being busy or used,
 * so a request re-picking a collection it is itself already responsible for (a replan) can be told apart from
 * one genuinely claimed by someone else --
 *  - `busy`: a collection referenced by a ContentItem with a still-non-terminal `library-production` run
 *    (any version), attributed to that run's request; OR (CRITICAL/IMPORTANT-3 fix) a ContentItem of an
 *    open/claimed request that has NO run at all yet -- the manual-accept window between `harness library
 *    accept`/a prior sweep's create and an actual `plan`, which otherwise reserves nothing and lets a second
 *    request grab the same shoot out from under it.
 *  - `used`: a collection referenced by a ContentItem with a `SUCCEEDED` `library-production` run, attributed
 *    to that run's request.
 * Computed once per `autoAccept` sweep; `collectionsExcluding` below narrows it per request without
 * re-scanning the store.
 */
function computeCollectionAttribution(store: StateStore): { busy: Map<string, Set<string>>; used: Map<string, Set<string>> } {
  const busy = new Map<string, Set<string>>();
  const used = new Map<string, Set<string>>();
  const attribute = (map: Map<string, Set<string>>, collection: string, requestId: string): void => {
    let ids = map.get(collection);
    if (!ids) { ids = new Set(); map.set(collection, ids); }
    ids.add(requestId);
  };

  const contentIdsWithRun = new Set<string>();
  for (const run of store.listRuns({})) {
    if (run.content_id) contentIdsWithRun.add(run.content_id);
    if (run.workflow_release.id !== "library-production") continue;
    const requestId = requestIdForRun(store, run);
    if (!requestId) continue;
    if (run.state === "SUCCEEDED") { for (const c of collectionsOfContent(store, run.content_id)) attribute(used, c, requestId); }
    else if (!isTerminal("run", run.state)) { for (const c of collectionsOfContent(store, run.content_id)) attribute(busy, c, requestId); }
  }

  const openOrClaimed = new Set(
    [...store.listContentRequests({ status: "open" }), ...store.listContentRequests({ status: "claimed" })].map((r) => r.request_id),
  );
  for (const item of store.listContentItems()) {
    if (contentIdsWithRun.has(item.content_id)) continue; // already attributed above via its own run
    const requestId = item.library_brief?.request_id;
    if (!requestId || !openOrClaimed.has(requestId)) continue;
    for (const id of item.source_ids) {
      const source = store.getSourceItem(id);
      if (source) attribute(busy, source.collection, requestId);
    }
  }

  return { busy, used };
}

/** Collections `map` marks busy/used *for someone other than* `requestId` -- the own-request exemption: a
 * collection attributed only to `requestId` itself (a replan re-picking its own prior shoot) is not excluded. */
function collectionsExcluding(map: Map<string, Set<string>>, requestId: string): Set<string> {
  const result = new Set<string>();
  for (const [collection, requestIds] of map) {
    for (const id of requestIds) {
      if (id !== requestId) { result.add(collection); break; }
    }
  }
  return result;
}

/** `basename`, decoded first when `uri` is a `file:` URL (so `%20`/percent-escaped Unicode in the URL does not
 * sort differently from how `SourceCatalog.ingestDirectory`'s `listVideoFiles` itself ordered the same file on
 * disk); falls back to a plain `basename` of the raw string for anything else (a `reference`-mode URI need not
 * be a `file:` URL at all). */
function decodedBasename(uri: string): string {
  if (uri.startsWith("file:")) {
    try { return basename(fileURLToPath(uri)); } catch { /* fall through to the raw string below */ }
  }
  return basename(uri);
}

function sortByFilenameThenIngested(items: SourceItem[]): SourceItem[] {
  return items.slice().sort((a, b) => {
    const an = decodedBasename(a.original_uri);
    const bn = decodedBasename(b.original_uri);
    if (an !== bn) return an < bn ? -1 : 1;
    return a.ingested_at < b.ingested_at ? -1 : a.ingested_at > b.ingested_at ? 1 : 0;
  });
}

/**
 * Picks the sources a collection-mode auto-accepted request should run against (spec §5, sub-project 5A: pick
 * a whole shoot collection instead of one clip):
 *  1. `source_hint.source_ids` -- every one that still exists and is not rights-restricted, in hint order;
 *     busy/used never applies (the request named these directly).
 *  2. else `source_hint.collection` -- every non-restricted source of that collection, regardless of busy/used.
 *  3. else the collections matching `patterns` that are not in `busyCollections`/`usedCollections` and have at
 *     least one non-restricted source; the one with the greatest max(ingested_at) wins (ties broken by
 *     collection name ascending).
 * Cases 2/3 are sorted by the decoded `basename(original_uri)` then `ingested_at` and capped at `maxSources`;
 * an empty result means the caller should skip the request as `"no-source"`.
 */
export function pickSources(store: StateStore, p: { request: ContentRequest; patterns: string[]; maxSources: number; busyCollections: Set<string>; usedCollections: Set<string> }): SourceItem[] {
  const hint = p.request.source_hint;

  if (hint?.source_ids?.length) {
    const picked: SourceItem[] = [];
    for (const id of hint.source_ids) {
      const source = store.getSourceItem(id);
      if (source && source.rights_status !== "restricted") picked.push(source);
    }
    return picked.slice(0, p.maxSources);
  }

  if (hint?.collection) {
    const candidates = store.listSourceItems({ collection: hint.collection }).filter((s) => s.rights_status !== "restricted");
    return sortByFilenameThenIngested(candidates).slice(0, p.maxSources);
  }

  const byCollection = new Map<string, SourceItem[]>();
  for (const source of store.listSourceItems()) {
    if (source.rights_status === "restricted") continue;
    if (p.busyCollections.has(source.collection) || p.usedCollections.has(source.collection)) continue;
    if (!p.patterns.some((pattern) => matchCollection(source.collection, pattern))) continue;
    let list = byCollection.get(source.collection);
    if (!list) { list = []; byCollection.set(source.collection, list); }
    list.push(source);
  }
  let chosen: string | undefined;
  let chosenNewest = "";
  for (const [collection, items] of byCollection) {
    const newest = items.reduce((max, s) => (s.ingested_at > max ? s.ingested_at : max), "");
    if (chosen === undefined || newest > chosenNewest || (newest === chosenNewest && collection < chosen)) {
      chosen = collection;
      chosenNewest = newest;
    }
  }
  if (chosen === undefined) return [];
  return sortByFilenameThenIngested(byCollection.get(chosen)!).slice(0, p.maxSources);
}

/** `listEvents({ event_type, newest: true })` scans only rows matching that column (a real indexed-free but
 * dedicated `event` table column, not a `json_extract` scan of every event ever recorded) ordered newest
 * first, so this dedup check stays cheap and correct regardless of how many *other* events the project has
 * accumulated -- unlike an unfiltered `listEvents({})`, which silently stops seeing old rows past its
 * `limit` once a project passes that many total events. */
function skipOnce(d: AutoAcceptDeps, portfolioId: string, requestId: string, reason: AutoAcceptSkipReason): void {
  if (!DEDUPED_SKIP_REASONS.has(reason)) return;
  const already = d.store.listEvents({ event_type: "request.auto_accept_skipped", newest: true }).some((e) => e.payload.request_id === requestId && e.payload.reason === reason);
  if (already) return;
  d.store.appendEvent({
    run_id: null, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: portfolioId, channel_id: null,
    content_id: null, variant_id: null, workflow_release: null, severity: "warn", event_type: "request.auto_accept_skipped",
    payload: { request_id: requestId, reason },
  });
}

/** The distinct event spec §5.4 names for "this request burned through its replan budget" -- the condition
 * the dashboard's `request_stuck` alert renders, and what an operator greps the event log for. Deduped per
 * request the same way `skipOnce` is (the skip event stays too: it is what the poll-level report keys off),
 * so a request that stays open forever produces exactly one of each. */
function exhaustedOnce(d: AutoAcceptDeps, portfolioId: string, requestId: string, finishedRuns: number): void {
  const already = d.store.listEvents({ event_type: "request.auto_accept_exhausted", newest: true }).some((e) => e.payload.request_id === requestId);
  if (already) return;
  d.store.appendEvent({
    run_id: null, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: portfolioId, channel_id: null,
    content_id: null, variant_id: null, workflow_release: null, severity: "warn", event_type: "request.auto_accept_exhausted",
    payload: { request_id: requestId, finished_runs: finishedRuns, max_replans: d.config.max_replans },
  });
}

/**
 * Studio autopilot loop (spec §5): claims no request itself (`intake` still does that later in the plan)
 * -- it only ever writes through `catalog.createContent`, `catalog.getOrCreateVariant`, `planner.plan`,
 * `planner.enqueue` and `store.appendEvent`. A single request's plan failure is caught, logged and reported
 * as `plan-failed`; it never aborts the rest of the loop.
 *
 * Two source-picking modes (`d.sources.mode`, see `AutoAcceptSources`) share every other step of the loop
 * (style checks, run-active, exhausted, concurrency, the accept transaction) -- only "which sources does this
 * request get" and "what do I mark busy once accepted" differ.
 */
export async function autoAccept(d: AutoAcceptDeps): Promise<AutoAcceptReport> {
  const { store } = d;
  const report: AutoAcceptReport = { accepted: [], skipped: [] };

  const { active: activeRequestIds, finished, activeCount: initialActiveCount } = partitionRunsByRequest(store);
  let activeCount = initialActiveCount;
  const requestsWithOwnContent = requestsWithContent(store);

  // Mode-specific bookkeeping, hoisted once (not re-scanned per request): mutated in place as requests are
  // accepted below, so a source/collection picked for one request is immediately busy for the next in the
  // same sweep.
  const legacy = d.sources.mode === "legacy" ? busySourceIdsByRequest(store) : undefined;
  const collections = d.sources.mode === "collections" ? computeCollectionAttribution(store) : undefined;

  const openRequests = [...store.listContentRequests({ status: "open" })].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  for (const request of openRequests) {
    const portfolioId = d.portfolioFor?.(request) ?? d.portfolioId;
    if (!request.style_id) { report.skipped.push({ request_id: request.request_id, reason: "no-style" }); continue; }
    const style = store.getEditStyle(request.style_id);
    if (style?.status !== "active") { report.skipped.push({ request_id: request.request_id, reason: "style-inactive" }); continue; }

    const replanNo = finished.get(request.request_id) ?? 0;
    // `requestsWithOwnContent.has(...)` with no finished run yet: a ContentItem already carries this request
    // but no run exists for it -- the window between `harness library accept` and the operator's `harness
    // plan`. Planning a second run here would duplicate the work the human is about to enqueue, so treat it as
    // run-active.
    if (activeRequestIds.has(request.request_id) || (replanNo === 0 && requestsWithOwnContent.has(request.request_id))) {
      report.skipped.push({ request_id: request.request_id, reason: "run-active" });
      continue;
    }

    if (replanNo > d.config.max_replans) {
      report.skipped.push({ request_id: request.request_id, reason: "exhausted" });
      skipOnce(d, portfolioId, request.request_id, "exhausted");
      exhaustedOnce(d, portfolioId, request.request_id, replanNo);
      continue;
    }
    if (activeCount >= d.config.max_concurrent_runs) {
      report.skipped.push({ request_id: request.request_id, reason: "concurrency" });
      break; // no point checking the rest of the queue against a gate that will not move this poll
    }

    let picked: SourceItem[];
    if (d.sources.mode === "legacy") {
      // this request's own sources (if any, e.g. from a prior reopen) never count as busy against itself
      const busyForThisRequest = new Set(legacy!.global);
      for (const id of legacy!.own.get(request.request_id) ?? []) busyForThisRequest.delete(id);
      const source = pickSource(store, { request, defaultCollection: d.sources.collection, busySourceIds: busyForThisRequest });
      picked = source ? [source] : [];
    } else {
      const busyCollections = collectionsExcluding(collections!.busy, request.request_id);
      const usedCollections = collectionsExcluding(collections!.used, request.request_id);
      picked = pickSources(store, { request, patterns: d.sources.patterns, maxSources: d.sources.maxSources, busyCollections, usedCollections });
    }
    if (picked.length === 0) {
      report.skipped.push({ request_id: request.request_id, reason: "no-source" });
      skipOnce(d, portfolioId, request.request_id, "no-source");
      continue;
    }

    try {
      const libraryBrief: LibraryBrief = {
        topic: request.topic, style_id: style.style_id, style_revision: style.revision, voice: request.voice, language: request.language,
        ...(request.target_duration_seconds ? { target_duration_seconds: request.target_duration_seconds } : {}),
        request_id: request.request_id,
      };
      // Atomic: a `planner.plan` throw (e.g. a bad `workflows(ref)` lookup) must leave no trace -- an orphan
      // ContentItem/ContentVariant would otherwise poison the busy bookkeeping for every other request in this
      // and later polls, and this same request would be retried (and fail) every poll from then on
      // (fix-round-1 #3).
      store.transaction(() => {
        const content = d.catalog.createContent({ source_ids: picked.map((s) => s.source_id), title: request.topic, library_brief: libraryBrief });
        const run = startPlannedRun(
          {
            store, catalog: d.catalog, planner: d.planner, harness: d.harness, projectId: d.projectId, portfolioId, profile: d.profile,
            workflows: d.workflows, executorVersionFor: d.executorVersionFor,
            ...(d.requiresResourcesOverride ? { requiresResourcesOverride: d.requiresResourcesOverride } : {}),
            ...(d.config.workflow_release ? { workflowRelease: d.config.workflow_release } : {}),
          },
          content,
          {
            event_type: "request.auto_accepted", channel_id: null,
            payload: (runId) => ({ request_id: request.request_id, run_id: runId, replan_no: replanNo, source_id: picked[0]!.source_id }),
          },
          { voice: request.voice },
        );
        report.accepted.push({ request_id: request.request_id, run_id: run.run_id, replan_no: replanNo, source_id: picked[0]!.source_id });
        activeRequestIds.add(request.request_id);
        activeCount++;
        if (d.sources.mode === "legacy") {
          legacy!.global.add(picked[0]!.source_id);
        } else {
          for (const s of picked) {
            let ids = collections!.busy.get(s.collection);
            if (!ids) { ids = new Set(); collections!.busy.set(s.collection, ids); }
            ids.add(request.request_id);
          }
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      d.logger.error("auto-accept: plan failed", { request_id: request.request_id, error: message });
      // Appended *outside* the rolled-back transaction above: the failure record must survive even though
      // everything else that attempt did was undone.
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: portfolioId, channel_id: null,
        content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "request.auto_accept_failed",
        payload: { request_id: request.request_id, reason: message },
      });
      report.skipped.push({ request_id: request.request_id, reason: "plan-failed" });
    }
  }

  return report;
}
