import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { autoAcceptPatterns, newId, type EditStyle } from "@harness/contracts";
import {
  autoAccept, claimRequest, createRequest, fulfillRequest, HARNESS_ROOT, LibraryFs, loadHarnessConfig, loadProfile, loadWorkflow, matchCollection,
  NullMediaProber, pickSources, Planner, reopenRequest, SourceCatalog, type AutoAcceptConfig, type AutoAcceptDeps, type AutoAcceptLogger,
} from "../../src/index.js";
import { openTempStore } from "../helpers.js";

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
  const root = mkdtempSync(join(tmpdir(), "library-auto-accept-collections-"));
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

/** Every test in this file exercises collection mode explicitly (the mode a project opts into by setting
 * `source_collections` -- see `commands/worker.ts`'s `autoAcceptSourcesFor`); legacy mode's own byte-identical
 * behaviour is covered by `auto-accept.test.ts`. */
function depsFor(w: ReturnType<typeof world>, config: AutoAcceptConfig): AutoAcceptDeps {
  return {
    store: w.store, fs: w.studio, catalog: w.catalog, planner: w.planner, clock: w.clock, harness: w.harness,
    projectId: "project-studio", portfolioId: "portfolio-studio", profile: w.profile,
    workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref), executorVersionFor: () => "v1",
    config, sources: { mode: "collections", patterns: autoAcceptPatterns(config), maxSources: config.max_sources }, logger: silentLogger,
  };
}

/** Ingests a file under a controlled basename (unlike the random-ULID names used elsewhere) so filename-order
 * assertions are deterministic. Callers within one test must pass distinct `filename`s -- `w.dir` is a fresh
 * temp directory per `world()`, so there is no cross-test collision risk. */
async function ingestNamed(
  w: ReturnType<typeof world>, filename: string, content: string, collection = "main",
  rights_status: "unknown" | "cleared" | "restricted" = "cleared",
) {
  const path = join(w.dir, filename);
  writeFileSync(path, content);
  const { source } = await w.catalog.ingest({ path, collection, rights_status });
  return source;
}

function createOpenRequest(w: ReturnType<typeof world>, p: { style_id?: string; source_hint?: { source_ids?: string[]; collection?: string } } = {}) {
  return createRequest({ store: w.store, fs: w.channel, clock: w.clock }, {
    requested_by: { portfolio_id: "portfolio-channel" }, topic: "A whole shoot",
    ...(p.style_id ? { style_id: p.style_id } : {}),
    ...(p.source_hint ? { source_hint: p.source_hint } : {}),
  });
}

/** Walks a freshly-planned run (READY, as `autoAccept` leaves it) to SUCCEEDED through the real `transition()`
 * state machine (READY -> RUNNING -> SUCCEEDED) -- test-only shortcut for "the studio's pipeline finished
 * every stage", standing in for what a real worker sweep would do. */
function settleRun(w: ReturnType<typeof world>, runId: string): void {
  const ev = {
    run_id: runId, stage_run_id: null, attempt_id: null, project_id: "project-studio", portfolio_id: "portfolio-studio",
    channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "run.test_settled", payload: {},
  };
  w.store.transition("run", runId, "READY", "RUNNING", ev);
  w.store.transition("run", runId, "RUNNING", "SUCCEEDED", ev);
}

/** Claims `request` the way `intake` would once its run starts, using the studio's own fs handle -- studio may
 * overwrite an *existing* `requests/<id>.json` (`LibraryFs.assertWritable`), which is what `claimRequest`/
 * `reopenRequest`/`fulfillRequest` all do here, mirroring how `library-apply-review`'s stage (itself running as
 * part of the studio's pipeline) reaches these same functions in production. */
function claim(w: ReturnType<typeof world>, requestId: string, runId: string) {
  return claimRequest({ store: w.store, fs: w.studio, clock: w.clock }, { request_id: requestId, run: { project_id: "project-studio", run_id: runId } });
}

describe("matchCollection", () => {
  it("shoot-* matches shoot-2026-09-21 but not main", () => {
    expect(matchCollection("shoot-2026-09-21", "shoot-*")).toBe(true);
    expect(matchCollection("main", "shoot-*")).toBe(false);
  });

  it("a plain pattern with no * matches only the exact name", () => {
    expect(matchCollection("main", "main")).toBe(true);
    expect(matchCollection("mainx", "main")).toBe(false);
    expect(matchCollection("xmain", "main")).toBe(false);
  });
});

describe("pickSources", () => {
  it("hint.source_ids: drops restricted sources and keeps hint order (not filename/ingestion order)", async () => {
    const w = world();
    const a = await ingestNamed(w, "b-clip.mp4", "content a");
    const restricted = await ingestNamed(w, "a-clip.mp4", "content restricted", "main", "restricted");
    const b = await ingestNamed(w, "c-clip.mp4", "content b");
    const request = createOpenRequest(w, { source_hint: { source_ids: [b.source_id, restricted.source_id, a.source_id] } });
    const picked = pickSources(w.store, { request, patterns: ["main"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set() });
    expect(picked.map((s) => s.source_id)).toEqual([b.source_id, a.source_id]);
  });

  it("hint.collection: returns every non-restricted source of that collection, sorted by filename, ignoring busy/used/patterns", async () => {
    const w = world();
    await ingestNamed(w, "z.mp4", "c1", "shoot-a");
    await ingestNamed(w, "a.mp4", "c2", "shoot-a");
    await ingestNamed(w, "m.mp4", "c3", "shoot-a", "restricted");
    await ingestNamed(w, "b.mp4", "c4", "other-collection");
    const request = createOpenRequest(w, { source_hint: { collection: "shoot-a" } });
    const picked = pickSources(w.store, { request, patterns: ["nope-*"], maxSources: 40, busyCollections: new Set(["shoot-a"]), usedCollections: new Set() });
    expect(picked.map((s) => basename(s.original_uri))).toEqual(["a.mp4", "z.mp4"]);
  });

  it("no hint: picks the pattern-matching collection with the newest ingested_at, sorted by filename", async () => {
    const w = world();
    await ingestNamed(w, "old1.mp4", "c1", "shoot-old");
    w.clock.advance(10);
    await ingestNamed(w, "b.mp4", "c2", "shoot-new");
    await ingestNamed(w, "a.mp4", "c3", "shoot-new");
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set() });
    expect(picked.map((s) => s.collection)).toEqual(["shoot-new", "shoot-new"]);
    expect(picked.map((s) => basename(s.original_uri))).toEqual(["a.mp4", "b.mp4"]);
  });

  it("no hint: skips a busy collection even though it is the newest", async () => {
    const w = world();
    const old = await ingestNamed(w, "old.mp4", "old content", "shoot-a");
    w.clock.advance(10);
    await ingestNamed(w, "new.mp4", "new content", "shoot-b");
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(["shoot-b"]), usedCollections: new Set() });
    expect(picked.map((s) => s.source_id)).toEqual([old.source_id]);
  });

  it("no hint: skips a collection that already has a SUCCEEDED run", async () => {
    const w = world();
    const old = await ingestNamed(w, "old.mp4", "old content", "shoot-a");
    w.clock.advance(10);
    await ingestNamed(w, "new.mp4", "new content", "shoot-b");
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set(["shoot-b"]) });
    expect(picked.map((s) => s.source_id)).toEqual([old.source_id]);
  });

  it("caps the picked sources at maxSources", async () => {
    const w = world();
    await ingestNamed(w, "a.mp4", "1", "shoot-a");
    await ingestNamed(w, "b.mp4", "2", "shoot-a");
    await ingestNamed(w, "c.mp4", "3", "shoot-a");
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 2, busyCollections: new Set(), usedCollections: new Set() });
    expect(picked).toHaveLength(2);
  });

  it("breaks a tie in newest ingested_at by collection name ascending", async () => {
    const w = world();
    await ingestNamed(w, "b.mp4", "1", "shoot-b");
    await ingestNamed(w, "a.mp4", "2", "shoot-a"); // same clock tick: no advance() between the two ingests
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set() });
    expect(picked[0]!.collection).toBe("shoot-a");
  });

  it("returns [] when nothing matches the patterns", async () => {
    const w = world();
    await ingestNamed(w, "a.mp4", "1", "main");
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set() });
    expect(picked).toEqual([]);
  });

  // Controller ruling, task-7 fix round (adjacent finding): sort by the DECODED file name, not the raw
  // percent-escaped `original_uri` string -- a `file:` URL escapes non-ASCII bytes, which can reorder names
  // relative to how they actually read (and relative to how `SourceCatalog.ingestDirectory`'s `listVideoFiles`
  // itself ordered them on disk).
  it("sorts by the decoded basename of a file: URL, not its percent-escaped form", async () => {
    const w = world();
    const cafe = await ingestNamed(w, "café.mp4", "1", "shoot-a"); // é = U+00E9 (233): decoded, sorts AFTER 'z'
    const cafz = await ingestNamed(w, "cafz.mp4", "2", "shoot-a"); // 'z' = U+007A (122)
    const request = createOpenRequest(w);
    const picked = pickSources(w.store, { request, patterns: ["shoot-*"], maxSources: 40, busyCollections: new Set(), usedCollections: new Set() });
    // percent-encoded ("caf%C3%A9.mp4" vs "cafz.mp4") would sort café FIRST ('%' < 'z') -- the wrong order.
    expect(picked.map((s) => s.source_id)).toEqual([cafz.source_id, cafe.source_id]);
  });
});

describe("autoAccept (collections, sub-project 5A)", () => {
  it("creates a content item carrying every usable source of the auto-picked shoot collection, in filename order", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const a = await ingestNamed(w, "a.mp4", "1", "shoot-2026-09-21");
    const b = await ingestNamed(w, "b.mp4", "2", "shoot-2026-09-21");
    await ingestNamed(w, "c.mp4", "3", "shoot-2026-09-21", "restricted"); // excluded: rights-restricted
    const request = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept(depsFor(w, baseConfig({ source_collections: ["shoot-*"] })));

    expect(report.accepted).toHaveLength(1);
    const run = w.store.getRun(report.accepted[0]!.run_id)!;
    const content = w.store.getContentItem(run.content_id!)!;
    expect(content.source_ids).toEqual([a.source_id, b.source_id]);
    expect(content.library_brief?.request_id).toBe(request.request_id);
  });

  it("within one sweep, a second request does not repick the collection just accepted for the first", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingestNamed(w, "a.mp4", "1", "shoot-2026-09-21");
    const first = createOpenRequest(w, { style_id: styleId });
    w.clock.advance(1);
    const second = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept(depsFor(w, baseConfig({ source_collections: ["shoot-*"], max_concurrent_runs: 5 })));

    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.request_id).toBe(first.request_id);
    expect(report.skipped).toEqual([{ request_id: second.request_id, reason: "no-source" }]);
  });

  it("across polls, a second request does not pick a collection while the first run on it is still active", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingestNamed(w, "a.mp4", "1", "shoot-2026-09-21");
    const first = createOpenRequest(w, { style_id: styleId });
    const cfg = baseConfig({ source_collections: ["shoot-*"], max_concurrent_runs: 5 });

    const firstReport = await autoAccept(depsFor(w, cfg));
    expect(firstReport.accepted).toHaveLength(1);
    expect(w.store.getRun(firstReport.accepted[0]!.run_id)?.state).toBe("READY"); // non-terminal: still busy

    w.clock.advance(1);
    const second = createOpenRequest(w, { style_id: styleId }); // the only matching collection is now busy
    const secondReport = await autoAccept(depsFor(w, cfg));
    expect(secondReport.accepted).toEqual([]);
    // `first` is also re-evaluated on this second poll (autoAccept never claims a request) and skips as
    // "run-active" again -- irrelevant noise for this test, which only cares about `second`.
    expect(secondReport.skipped).toContainEqual({ request_id: second.request_id, reason: "no-source" });
  });

  // Controller ruling, task-7 fix round, CRITICAL 1: a rejected review still ends the run SUCCEEDED and
  // reopens the request (acceptance 27) -- without the own-request exemption, the reopened request's own
  // collection would land in `usedCollections` and it could never replan.
  it("a rejected review's reopened request re-picks its own shoot on the next sweep (replan_no 1); a different request does not get it", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const a = await ingestNamed(w, "a.mp4", "1", "shoot-a");
    const b = await ingestNamed(w, "b.mp4", "2", "shoot-a");
    const cfg = baseConfig({ source_collections: ["shoot-*"], max_concurrent_runs: 5 });

    const request = createOpenRequest(w, { style_id: styleId });
    const firstReport = await autoAccept(depsFor(w, cfg));
    expect(firstReport.accepted).toHaveLength(1);
    const run1Id = firstReport.accepted[0]!.run_id;

    // library-apply-review, rejected path: the run ends SUCCEEDED, the request goes back to open (AGENTS.md:
    // "một run mà library-apply-review ghi rejected kết thúc SUCCEEDED"; acceptance 27 models the same thing).
    settleRun(w, run1Id);
    claim(w, request.request_id, run1Id);
    const reopened = reopenRequest({ store: w.store, fs: w.studio, clock: w.clock }, { request_id: request.request_id, note: "off brief" });
    expect(reopened.status).toBe("open");

    // a different open request also wants a shoot -- "shoot-a" is the only one that exists
    w.clock.advance(1);
    const other = createOpenRequest(w, { style_id: styleId });

    const secondReport = await autoAccept(depsFor(w, cfg));

    const ownAccept = secondReport.accepted.find((x) => x.request_id === request.request_id);
    expect(ownAccept, JSON.stringify(secondReport)).toBeDefined();
    expect(ownAccept!.replan_no).toBe(1);
    const content2 = w.store.getContentItem(w.store.getRun(ownAccept!.run_id)!.content_id!)!;
    expect(content2.source_ids).toEqual([a.source_id, b.source_id]);

    expect(secondReport.skipped).toContainEqual({ request_id: other.request_id, reason: "no-source" });
  });

  // Controller ruling, task-7 fix round, IMPORTANT 3: a ContentItem from `harness library accept` (or a prior
  // sweep) with no run yet must still reserve its collection, or a second request can grab the same shoot out
  // from under the human/pending plan.
  it("a ContentItem with no run yet reserves its collection for another open request too", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    await ingestNamed(w, "a.mp4", "1", "shoot-a");
    const cfg = baseConfig({ source_collections: ["shoot-*"] });

    const requestA = createOpenRequest(w, { style_id: styleId });
    const sourceA = w.store.listSourceItems({ collection: "shoot-a" })[0]!;
    w.catalog.createContent({
      source_ids: [sourceA.source_id], title: "x",
      library_brief: { topic: "x", style_id: styleId, style_revision: 1, voice: "none", language: "vi", request_id: requestA.request_id },
    });

    w.clock.advance(1);
    const requestB = createOpenRequest(w, { style_id: styleId });

    const report = await autoAccept(depsFor(w, cfg));
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toContainEqual({ request_id: requestA.request_id, reason: "run-active" });
    expect(report.skipped).toContainEqual({ request_id: requestB.request_id, reason: "no-source" });
  });

  // Controller ruling, task-7 fix round: `usedCollections` applies unconditionally in collection mode -- a
  // collection whose run SUCCEEDED for a different, already-settled (fulfilled, not reopened) request stays
  // excluded from a brand-new no-hint request, but an explicit `source_hint.collection` still gets it (case 2
  // ignores busy/used entirely).
  it("a used collection from a fulfilled request is excluded for a new no-hint request, but honoured via source_hint.collection", async () => {
    const w = world();
    const styleId = newId("edit_style");
    w.store.upsertEditStyle(makeStyle(styleId));
    const a = await ingestNamed(w, "a.mp4", "1", "shoot-a");
    const cfg = baseConfig({ source_collections: ["shoot-*"] });

    const settled = createOpenRequest(w, { style_id: styleId });
    const firstReport = await autoAccept(depsFor(w, cfg));
    expect(firstReport.accepted).toHaveLength(1);
    const runId = firstReport.accepted[0]!.run_id;
    settleRun(w, runId);
    claim(w, settled.request_id, runId);
    const fulfilled = fulfillRequest({ store: w.store, fs: w.studio, clock: w.clock }, { request_id: settled.request_id, item_id: newId("library_item") });
    expect(fulfilled.status).toBe("fulfilled"); // settled for good -- never reopened, never re-evaluated

    w.clock.advance(1);
    const noHint = createOpenRequest(w, { style_id: styleId });
    const secondReport = await autoAccept(depsFor(w, cfg));
    expect(secondReport.skipped).toContainEqual({ request_id: noHint.request_id, reason: "no-source" });

    const hinted = createOpenRequest(w, { style_id: styleId, source_hint: { collection: "shoot-a" } });
    const thirdReport = await autoAccept(depsFor(w, cfg));
    const hintedAccept = thirdReport.accepted.find((x) => x.request_id === hinted.request_id);
    expect(hintedAccept, JSON.stringify(thirdReport)).toBeDefined();
    expect(w.store.getContentItem(w.store.getRun(hintedAccept!.run_id)!.content_id!)?.source_ids).toEqual([a.source_id]);
  });

  // Final-review Important 2: the own-request exemption made the OLD shoot *available* to a replan but the
  // newest-first rule still won, so a replan with a newer unused shoot around jumped ship -- and the shoot it
  // abandoned stayed `used` by a request that had moved on, locking every other request out of it forever.
  // Which request got which shoot then came down to `created_at` order, which is not a decision anyone made.
  describe("a replan prefers the shoot it already worked on (Important 2)", () => {
    async function reopenedWorld(order: "replan-first" | "newcomer-first") {
      const w = world();
      const styleId = newId("edit_style");
      w.store.upsertEditStyle(makeStyle(styleId));
      // The newcomer is held out of the FIRST sweep by a draft style ("style-inactive"), so `order` controls
      // only its `created_at` relative to R's -- which is exactly what used to decide who got which shoot.
      const laterStyleId = newId("edit_style");
      w.store.upsertEditStyle(makeStyle(laterStyleId, "draft"));
      const a = await ingestNamed(w, "a.mp4", "1", "shoot-a");
      const cfg = baseConfig({ source_collections: ["shoot-*"], max_concurrent_runs: 5 });

      const mkReplanned = () => createOpenRequest(w, { style_id: styleId });
      const mkNewcomer = () => createOpenRequest(w, { style_id: laterStyleId });
      const [replanned, newcomer] = order === "newcomer-first"
        ? ((n) => { w.clock.advance(1); return [mkReplanned(), n] as const; })(mkNewcomer())
        : ((r) => { w.clock.advance(1); return [r, mkNewcomer()] as const; })(mkReplanned());

      // run 1 for R on shoot-a, rejected review -> run SUCCEEDED, request reopened
      const firstReport = await autoAccept(depsFor(w, cfg));
      const firstAccept = firstReport.accepted.find((x) => x.request_id === replanned.request_id);
      expect(firstAccept, JSON.stringify(firstReport)).toBeDefined();
      expect(w.store.getContentItem(w.store.getRun(firstAccept!.run_id)!.content_id!)?.source_ids).toEqual([a.source_id]);
      settleRun(w, firstAccept!.run_id);
      claim(w, replanned.request_id, firstAccept!.run_id);
      reopenRequest({ store: w.store, fs: w.studio, clock: w.clock }, { request_id: replanned.request_id, note: "off brief" });

      // a NEWER shoot arrives, unused by anyone, and the newcomer's style goes active
      w.clock.advance(10);
      const b = await ingestNamed(w, "b.mp4", "2", "shoot-b");
      w.store.upsertEditStyle(makeStyle(laterStyleId));
      return { w, cfg, replanned, newcomer, a, b, styleId };
    }

    for (const order of ["replan-first", "newcomer-first"] as const) {
      it(`gives the replan its own shoot-a and the other request shoot-b (${order})`, async () => {
        const { w, cfg, replanned, newcomer, a, b } = await reopenedWorld(order);

        const report = await autoAccept(depsFor(w, cfg));
        const sourcesOf = (requestId: string): string[] => {
          const accept = report.accepted.find((x) => x.request_id === requestId);
          expect(accept, `${requestId} was not accepted: ${JSON.stringify(report)}`).toBeDefined();
          return w.store.getContentItem(w.store.getRun(accept!.run_id)!.content_id!)!.source_ids;
        };
        expect(sourcesOf(replanned.request_id), "the replan abandoned its own shoot").toEqual([a.source_id]);
        expect(sourcesOf(newcomer.request_id)).toEqual([b.source_id]);

        // the report/event now say which collection and every source, not just `picked[0]`
        const replanAccept = report.accepted.find((x) => x.request_id === replanned.request_id)!;
        expect(replanAccept.collection).toBe("shoot-a");
        expect(replanAccept.source_ids).toEqual([a.source_id]);
        const event = w.store.listEvents({ event_type: "request.auto_accepted" }).find((e) => e.payload.run_id === replanAccept.run_id);
        expect(event?.payload).toMatchObject({ collection: "shoot-a", source_ids: [a.source_id], source_id: a.source_id });
      });
    }

    // The preference is a preference, not a lock: a shoot another request is actually working on stays off
    // limits, and the replan falls back to the ordinary newest-first rule.
    it("falls through to the newest-first rule when the replan's own shoot is busy for someone else", async () => {
      const { w, cfg, replanned, styleId, a, b } = await reopenedWorld("replan-first");
      // a third request is already holding shoot-a (a ContentItem with no run yet -- the `harness library
      // accept` window), which makes it busy for everyone else
      const hogger = createOpenRequest(w, { style_id: styleId, source_hint: { collection: "shoot-a" } });
      w.catalog.createContent({
        source_ids: [a.source_id], title: "held",
        library_brief: { topic: "held", style_id: styleId, style_revision: 1, voice: "none", language: "vi", request_id: hogger.request_id },
      });

      const report = await autoAccept(depsFor(w, cfg));
      const replanAccept = report.accepted.find((x) => x.request_id === replanned.request_id);
      expect(replanAccept, JSON.stringify(report)).toBeDefined();
      expect(w.store.getContentItem(w.store.getRun(replanAccept!.run_id)!.content_id!)?.source_ids).toEqual([b.source_id]);
    });
  });
});
