import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type EditStyle, type Run } from "@harness/contracts";
import { autoAccept, createRequest, HARNESS_ROOT, LibraryFs, loadHarnessConfig, loadProfile, loadWorkflow, NullMediaProber, pickSource, Planner, SourceCatalog, type AutoAcceptConfig, type AutoAcceptDeps, type AutoAcceptLogger } from "../../src/index.js";
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
  return { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 5, ...overrides };
}

function depsFor(w: ReturnType<typeof world>, config: AutoAcceptConfig): AutoAcceptDeps {
  return {
    store: w.store, fs: w.studio, catalog: w.catalog, planner: w.planner, clock: w.clock, harness: w.harness,
    projectId: "project-studio", portfolioId: "portfolio-studio", profile: w.profile,
    workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref), executorVersionFor: () => "v1",
    config, logger: silentLogger,
  };
}

/** A distinct-content temp file, ingested into `collection` and returned as a `SourceItem`. */
async function ingest(w: ReturnType<typeof world>, content: string, collection = "main") {
  const path = join(w.dir, `${newId("source_item")}.mp4`);
  writeFileSync(path, content);
  const { source } = await w.catalog.ingest({ path, collection, rights_status: "cleared" });
  return source;
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
    expect(content?.source_ids).toEqual([accepted.source_id]);

    const events = w.store.listEvents({ run_id: accepted.run_id });
    const accepted_event = events.find((e) => e.event_type === "request.auto_accepted");
    expect(accepted_event?.payload).toMatchObject({ request_id: request.request_id, run_id: accepted.run_id, replan_no: 0, source_id: accepted.source_id });

    // calling again finds the request still open (auto-accept never claims it) but with an active run
    const second = await autoAccept(depsFor(w, baseConfig()));
    expect(second.accepted).toEqual([]);
    expect(second.skipped).toEqual([{ request_id: request.request_id, reason: "run-active" }]);
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

    // dedup: a second poll must not append a second `request.auto_accept_skipped` event
    await autoAccept(depsFor(w, baseConfig({ max_replans: 2 })));
    const skipEvents = w.store.listEvents({}).filter((e) => e.event_type === "request.auto_accept_skipped" && e.payload.request_id === request.request_id);
    expect(skipEvents).toHaveLength(1);
  });
});

describe("pickSource", () => {
  it("skips a source already busy with another open request", async () => {
    const w = world();
    const a = await ingest(w, "clip one");
    w.clock.advance(1);
    const b = await ingest(w, "clip two");
    const request = createOpenRequest(w, { style_id: newId("edit_style") });
    const picked = pickSource(w.store, { request, defaultCollection: "main", busySourceIds: new Set([b.source_id]) });
    // newest first: "clip two" (b) was ingested after "clip one" (a), so without the busy set it would win
    expect(picked?.source_id).toBe(a.source_id);
  });
});
