import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoAcceptPatterns, newId, type EditStyle, type Run } from "@harness/contracts";
import { autoAccept, createRequest, HARNESS_ROOT, LibraryFs, loadHarnessConfig, loadProfile, loadWorkflow, NullMediaProber, Planner, SourceCatalog, type AutoAcceptConfig, type AutoAcceptDeps, type AutoAcceptLogger } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const SHA = "sha256:" + "a".repeat(64);

function makeStyle(id: string, status: EditStyle["status"] = "active"): EditStyle {
  return {
    schema_version: "harness.edit-style/v1", style_id: id, revision: 1, name: "Test style", status,
    learned_from: [],
    params: {
      cut_rhythm: "medium", shot_seconds: [2, 5], transitions: [], text_overlay: { style: "bold", density: "low" },
      subtitles: "burn-in", music: { mood: "upbeat", ducking: true }, opening: { seconds: 3, structure: "hook" }, aspect_ratio: "16:9", pace_notes: "",
    },
    evidence: [], created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
}

const silentLogger: AutoAcceptLogger = { info: () => {}, warn: () => {}, error: () => {} };

function world() {
  const root = mkdtempSync(join(tmpdir(), "library-auto-accept-"));
  const studio = new LibraryFs({ root, role: "studio" });
  const channel = new LibraryFs({ root, role: "channel" });
  const { store, dir, clock } = openTempStore();
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "copy" });
  const planner = new Planner(store);
  const profile = loadProfile(HARNESS_ROOT, "studio");
  const harness = loadHarnessConfig(HARNESS_ROOT);
  return { root, studio, channel, store, dir, clock, catalog, planner, profile, harness };
}

function baseConfig(overrides: Partial<AutoAcceptConfig> = {}): AutoAcceptConfig {
  return { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 5, max_sources: 40, ...overrides };
}

function depsFor(w: ReturnType<typeof world>, config: AutoAcceptConfig): AutoAcceptDeps {
  return {
    store: w.store, fs: w.studio, catalog: w.catalog, planner: w.planner, clock: w.clock, harness: w.harness,
    projectId: "project-studio", portfolioId: "portfolio-studio", profile: w.profile,
    workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref), executorVersionFor: () => "v1",
    config, patterns: autoAcceptPatterns(config), maxSources: config.max_sources, logger: silentLogger,
  };
}

/** A distinct-content temp file, ingested into `collection` and returned as a `SourceItem`. */
async function ingest(w: ReturnType<typeof world>, content: string, collection = "main", rights_status: "unknown" | "cleared" | "restricted" = "cleared") {
  const path = join(w.dir, `${newId("source_item")}.mp4`);
  writeFileSync(path, content);
  const { source } = await w.catalog.ingest({ path, collection, rights_status });
  return source;
}

/** Content + variant + a request_id-carrying library_brief, for tests that need a real ContentItem to hang a
 * seeded Run off of (the "exhausted"/"run-active" DRAFT scenarios) without going through a full autoAccept(). */
function seedContent(w: ReturnType<typeof world>, p: { requestId: string; styleId: string; sourceId: string }) {
  return w.catalog.createContent({
    source_ids: [p.sourceId], title: "x",
    library_brief: { topic: "x", style_id: p.styleId, style_revision: 1, voice: "none", language: "vi", request_id: p.requestId },
  });
}

function createOpenRequest(w: ReturnType<typeof world>, p: { style_id?: string; source_hint?: { source_ids?: string[]; collection?: string } } = {}) {
  return createRequest({ store: w.store, fs: w.channel, clock: w.clock }, {
    requested_by: { portfolio_id: "portfolio-channel" }, topic: "Ancient ruins",
    ...(p.style_id ? { style_id: p.style_id } : {}),
    ...(p.source_hint ? { source_hint: p.source_hint } : {}),
  });
}

function seedFinishedRun(w: ReturnType<typeof world>, contentId: string, state: Run["state"]): void {
  const now = w.clock.now();
  const run: Run = {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-studio", portfolio_id: "portfolio-studio",
    workflow_release: { id: "library-production", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
    content_id: contentId, options: {}, state, effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0, created_at: now, updated_at: now,
  };
  w.store.insertRun(run);
}

describe("autoAccept", () => {
  it("accepts an open request against the most recent source, enqueues a READY run and records the event", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one");
    await ingest(w, "clip two");
    const request = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept(depsFor(w, baseConfig()));

    expect(report.accepted).toHaveLength(1);
    expect(report.skipped).toEqual([]);
    const accepted = report.accepted[0]!;
    expect(accepted.request_id).toBe(request.request_id);
    expect(accepted.replan_no).toBe(0);

    const run = w.store.getRun(accepted.run_id);
    expect(run?.state).toBe("READY");
    const content = w.store.getContentItem(run!.content_id!);
    expect(content?.library_brief?.request_id).toBe(request.request_id);
    // sub-project 5A: a request with no hint picks the *whole* matching collection, not one clip -- this
    // fixture ingests two sources into "main", so both end up on the content; `accepted.source_id` is just
    // the first of them (picked[0], report-level convenience field for events/logging).
    expect(content?.source_ids).toHaveLength(2);
    expect(content?.source_ids).toContain(accepted.source_id);

    const events = w.store.listEvents({ run_id: accepted.run_id });
    const accepted_event = events.find((e) => e.event_type === "request.auto_accepted");
    expect(accepted_event?.payload).toMatchObject({ request_id: request.request_id, run_id: accepted.run_id, replan_no: 0, source_id: accepted.source_id });

    // calling again finds the request still open (auto-accept never claims it) but with an active run
    const second = await autoAccept(depsFor(w, baseConfig()));
    expect(second.accepted).toEqual([]);
    expect(second.skipped).toEqual([{ request_id: request.request_id, reason: "run-active" }]);
  });

  // Final-review bundled minor (f): the run and its events belong to the portfolio that asked, not to
  // whatever portfolio the CLI happened to list first.
  it("stamps the run and the accepted event with portfolioFor(request) when given one", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one");
    const request = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept({ ...depsFor(w, baseConfig()), portfolioFor: () => "portfolio-requesting" });

    expect(report.accepted).toHaveLength(1);
    expect(w.store.getRun(report.accepted[0]!.run_id)?.portfolio_id).toBe("portfolio-requesting");
    const event = w.store.listEvents({ event_type: "request.auto_accepted" }).find((e) => e.payload.request_id === request.request_id);
    expect(event?.portfolio_id).toBe("portfolio-requesting");
  });

  // Final-review bundled minor (g): between `harness library accept` and the operator's `harness plan` there
  // is a ContentItem carrying the request and no run at all -- auto-accept used to plan a second run into
  // that window.
  it("skips run-active for a request that already has a ContentItem but no run yet", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const source = await ingest(w, "clip one");
    const request = createOpenRequest(w, { style_id: styleId });
    seedContent(w, { requestId: request.request_id, styleId, sourceId: source.source_id });

    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toEqual([{ request_id: request.request_id, reason: "run-active" }]);
  });

  it("skips a request with no style_id as no-style", async () => {
    const w = world();
    const request = createOpenRequest(w);
    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toEqual([{ request_id: request.request_id, reason: "no-style" }]);
  });

  it("skips a request whose style is not active as style-inactive", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId, "draft"));
    const request = createOpenRequest(w, { style_id: styleId });
    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.skipped).toEqual([{ request_id: request.request_id, reason: "style-inactive" }]);
  });

  it("skips as no-source when source_hint.collection names a collection with nothing in it", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one"); // in "main", not "other"
    const request = createOpenRequest(w, { style_id: styleId, source_hint: { collection: "other" } });
    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.skipped).toEqual([{ request_id: request.request_id, reason: "no-source" }]);
  });

  it("honours an explicit source_hint.source_ids over the default collection", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one");
    const named = await ingest(w, "clip two");
    const request = createOpenRequest(w, { style_id: styleId, source_hint: { source_ids: [named.source_id] } });
    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.source_id).toBe(named.source_id);
  });

  it("accepts up to max_concurrent_runs and marks the rest concurrency", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one");
    await ingest(w, "clip two");
    const first = createOpenRequest(w, { style_id: styleId });
    w.clock.advance(1);
    const second = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept(depsFor(w, baseConfig({ max_concurrent_runs: 1 })));
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.request_id).toBe(first.request_id);
    expect(report.skipped).toEqual([{ request_id: second.request_id, reason: "concurrency" }]);
  });

  it("marks a request exhausted once its finished runs exceed max_replans", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const request = createOpenRequest(w, { style_id: styleId });
    const source = await ingest(w, "clip one");
    const content = w.catalog.createContent({ source_ids: [source.source_id], title: "x", library_brief: { topic: "x", style_id: styleId, style_revision: 1, voice: "none", language: "vi", request_id: request.request_id } });
    seedFinishedRun(w, content.content_id, "SUCCEEDED");
    seedFinishedRun(w, content.content_id, "FAILED");
    seedFinishedRun(w, content.content_id, "CANCELLED");

    const report = await autoAccept(depsFor(w, baseConfig({ max_replans: 2 })));
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toEqual([{ request_id: request.request_id, reason: "exhausted" }]);

    // the distinct event spec §5.4 names, once, alongside the skip event (final-review finding I-4)
    const exhausted = w.store.listEvents({ event_type: "request.auto_accept_exhausted" }).filter((e) => e.payload.request_id === request.request_id);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.payload).toMatchObject({ request_id: request.request_id, finished_runs: 3, max_replans: 2 });

    // dedup: a second poll must not append a second `request.auto_accept_skipped`/`_exhausted` event
    await autoAccept(depsFor(w, baseConfig({ max_replans: 2 })));
    const skipEvents = w.store.listEvents({ event_type: "request.auto_accept_skipped" }).filter((e) => e.payload.request_id === request.request_id);
    expect(skipEvents).toHaveLength(1);
    expect(w.store.listEvents({ event_type: "request.auto_accept_exhausted" }).filter((e) => e.payload.request_id === request.request_id)).toHaveLength(1);
  });

  // fix-round-1 finding #1: DRAFT (planned by hand, never enqueued) and CANCEL_REQUESTED were in neither of
  // the old ACTIVE_RUN_STATES/FINISHED_RUN_STATES allowlists, so the loop would plan a duplicate run for a
  // request that already had one sitting in either state.
  it("skips run-active for a request with a non-terminal run not covered by the old state allowlists (DRAFT, CANCEL_REQUESTED)", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));

    const draftSource = await ingest(w, "clip draft");
    const draftRequest = createOpenRequest(w, { style_id: styleId });
    const draftContent = seedContent(w, { requestId: draftRequest.request_id, styleId, sourceId: draftSource.source_id });
    const { variant: draftVariant } = w.catalog.getOrCreateVariant({ content_id: draftContent.content_id, profile: w.profile, options: { voice: "none" } });
    const draftRun = w.planner.plan({
      workflow: loadWorkflow(HARNESS_ROOT, w.profile.workflow_release), profile: w.profile, harness: w.harness,
      projectId: "project-studio", portfolioId: "portfolio-studio", runOverrides: {}, content: draftContent, variant: draftVariant,
    });
    expect(w.store.getRun(draftRun.run_id)?.state).toBe("DRAFT"); // never enqueued

    w.clock.advance(1);
    const cancelSource = await ingest(w, "clip cancel-requested");
    const cancelRequest = createOpenRequest(w, { style_id: styleId });
    const cancelContent = seedContent(w, { requestId: cancelRequest.request_id, styleId, sourceId: cancelSource.source_id });
    const { variant: cancelVariant } = w.catalog.getOrCreateVariant({ content_id: cancelContent.content_id, profile: w.profile, options: { voice: "none" } });
    const cancelRun = w.planner.plan({
      workflow: loadWorkflow(HARNESS_ROOT, w.profile.workflow_release), profile: w.profile, harness: w.harness,
      projectId: "project-studio", portfolioId: "portfolio-studio", runOverrides: {}, content: cancelContent, variant: cancelVariant,
    });
    w.planner.enqueue(cancelRun.run_id);
    // a stage must be held by a worker (CLAIMED) or `cancel` settles the run straight to CANCELLED instead of
    // parking it at CANCEL_REQUESTED (nothing left to acknowledge) -- see Planner.settleCancel.
    w.store.claim({ owner: "test-worker", capabilities: [], now: w.clock.now(), leaseSeconds: 90 });
    w.planner.cancel(cancelRun.run_id);
    expect(w.store.getRun(cancelRun.run_id)?.state).toBe("CANCEL_REQUESTED");

    const report = await autoAccept(depsFor(w, baseConfig()));
    expect(report.accepted).toEqual([]);
    expect(report.skipped.sort((a, b) => a.request_id.localeCompare(b.request_id))).toEqual(
      [{ request_id: draftRequest.request_id, reason: "run-active" }, { request_id: cancelRequest.request_id, reason: "run-active" }]
        .sort((a, b) => a.request_id.localeCompare(b.request_id)),
    );
  });

  // fix-round-1 finding #2: the dedup check now filters by the `event_type` column in SQL instead of scanning
  // an unfiltered, 1000-row-limited listEvents({}) -- so it must still find its own skip event (and not
  // append a duplicate) no matter how many unrelated events came before it.
  it("dedups the exhausted skip event even after 1000+ unrelated events precede it", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const request = createOpenRequest(w, { style_id: styleId });
    const source = await ingest(w, "clip one");
    const content = seedContent(w, { requestId: request.request_id, styleId, sourceId: source.source_id });
    seedFinishedRun(w, content.content_id, "SUCCEEDED");
    seedFinishedRun(w, content.content_id, "FAILED");
    seedFinishedRun(w, content.content_id, "CANCELLED");

    for (let i = 0; i < 1200; i++) {
      w.store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: "project-studio", portfolio_id: "portfolio-studio",
        channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "noise.event", payload: {},
      });
    }

    const first = await autoAccept(depsFor(w, baseConfig({ max_replans: 2 })));
    expect(first.skipped).toEqual([{ request_id: request.request_id, reason: "exhausted" }]);
    const second = await autoAccept(depsFor(w, baseConfig({ max_replans: 2 })));
    expect(second.skipped).toEqual([{ request_id: request.request_id, reason: "exhausted" }]);

    const skipEvents = w.store.listEvents({ event_type: "request.auto_accept_skipped" }).filter((e) => e.payload.request_id === request.request_id);
    expect(skipEvents).toHaveLength(1);
  });

  // fix-round-1 finding #3: a plan() throw must roll back everything the failing attempt did (no orphan
  // ContentItem/ContentVariant) and must not stop the loop from accepting the next request.
  it("rolls back the whole accept when plan() throws, and still accepts the next request in the same call", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingest(w, "clip one");
    await ingest(w, "clip two");
    const first = createOpenRequest(w, { style_id: styleId });
    w.clock.advance(1);
    const second = createOpenRequest(w, { style_id: styleId });

    let calls = 0;
    const flakyWorkflows = (ref: string) => { calls++; if (calls === 1) throw new Error("workflow lookup failed"); return loadWorkflow(HARNESS_ROOT, ref); };
    const report = await autoAccept({ ...depsFor(w, baseConfig()), workflows: flakyWorkflows });

    expect(report.skipped).toEqual([{ request_id: first.request_id, reason: "plan-failed" }]);
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.request_id).toBe(second.request_id);

    const failedEvents = w.store.listEvents({ event_type: "request.auto_accept_failed" });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.payload).toMatchObject({ request_id: first.request_id });

    const contentItems = w.store.listContentItems();
    expect(contentItems.filter((c) => c.library_brief?.request_id === first.request_id)).toEqual([]);
    expect(contentItems.filter((c) => c.library_brief?.request_id === second.request_id)).toHaveLength(1);
  });
});
