import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type ContentRequest, type Run } from "@harness/contracts";
import {
  autoPick, HARNESS_ROOT, LibraryFs, loadHarnessConfig, loadProfile, loadWorkflow, NullMediaProber, Planner, SourceCatalog,
  type AutoPickDeps,
} from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, makeChannel, makeLibraryItem, noopLogger } from "./fixtures.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "learning-auto-pick-"));
  const studio = new LibraryFs({ root, role: "studio" });
  const channelFs = new LibraryFs({ root, role: "channel" });
  const { store, dir, clock } = openTempStore(T0);
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "copy" });
  const planner = new Planner(store);
  const profile = loadProfile(HARNESS_ROOT, "channel"); // workflow_release channel-publish@1.0.0
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const workflows = (ref: string) => loadWorkflow(HARNESS_ROOT, ref);
  return { root, studio, channelFs, store, dir, clock, catalog, planner, profile, harness, workflows };
}

/** Seeds a library item's manifest on disk (studio-owned path) so `claimItem` can read it. */
function seedItem(w: ReturnType<typeof world>, o: Parameters<typeof makeLibraryItem>[0] = {}) {
  const item = makeLibraryItem(o);
  w.studio.writeJsonAtomic(w.studio.paths.manifest(item.item_id), item);
  return item;
}

function depsFor(w: ReturnType<typeof world>, channel: ReturnType<typeof makeChannel>, items: ReturnType<typeof makeLibraryItem>[]): AutoPickDeps {
  return {
    store: w.store, fs: w.channelFs, clock: w.clock, channel, catalog: w.catalog, planner: w.planner, harness: w.harness,
    projectId: "project-a", portfolioId: "portfolio-main", profile: w.profile, workflows: w.workflows,
    executorVersionFor: () => "v1", libraryItems: items, logger: noopLogger,
  };
}

function makeRequest(store: ReturnType<typeof openTempStore>["store"], o: { channel_id?: string; created_at?: string; status?: ContentRequest["status"] } = {}): ContentRequest {
  const request: ContentRequest = {
    schema_version: "harness.content-request/v1", request_id: newId("content_request"),
    requested_by: { portfolio_id: "portfolio-main", channel_id: o.channel_id ?? "channel-a" }, topic: "A topic", voice: "none",
    language: "vi", count: 1, status: o.status ?? "open", item_ids: [], notes: "", created_at: o.created_at ?? T0, updated_at: T0,
  };
  store.upsertContentRequest(request);
  return request;
}

describe("autoPick", () => {
  it("prefers a candidate targeted by this channel's own request over an untargeted one", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    // realistic case: by the time an item is `approved`, its originating request has already moved to
    // `fulfilled` (applyReview -> fulfillRequest) -- group (a) must still match it by owning channel, not
    // by request status.
    const request = makeRequest(w.store, { created_at: T0, status: "fulfilled" });
    const targeted = seedItem(w, { request_id: request.request_id, updated_at: "2026-09-11T05:00:00.000Z" });
    const untargeted = seedItem(w, { updated_at: "2026-09-11T06:00:00.000Z" }); // newer, but no request

    const result = await autoPick(depsFor(w, channel, [targeted, untargeted]));

    expect(result.picked).toBeDefined();
    expect(result.picked!.item_id).toBe(targeted.item_id);
  });

  it("picks an untargeted item when there is an unfilled slot not covered by jobs/runs/requests", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    // nothing at all covers the one lookahead slot except the untargeted item itself -- picking it is exactly
    // what should turn that "covered on paper" (demand.covered.items) into a real claim, not block it.
    const untargeted = seedItem(w);

    const result = await autoPick(depsFor(w, channel, [untargeted]));
    expect(result.picked).toBeDefined();
    expect(result.picked!.item_id).toBe(untargeted.item_id);
  });

  it("does not pick when there is no untargeted item to offer and jobs/runs/requests already cover all slots", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    // fully covered: a SCHEDULED job takes the one lookahead slot, and there is no untargeted item at all
    const job = {
      schema_version: "harness.publication-job/v1" as const, publication_job_id: newId("publication_job"), package_id: newId("channel_package"),
      idempotency_key: "sha256:" + "7".repeat(64), state: "SCHEDULED" as const, youtube_video_id: null, receipt: null,
      created_at: T0, updated_at: T0, channel_id: "channel-a", library_item_id: newId("library_item"), run_id: newId("run"),
      operation_id: null, scheduled_at: "2026-09-12T13:00:00.000Z", published_at: null, last_verified_at: null, note: null,
    };
    w.store.insertPublicationJob(job);

    const result = await autoPick(depsFor(w, channel, []));
    expect(result.skipped).toBe("no-candidate");
  });

  it("excludes an item whose newest run for this channel already FAILED", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const item = seedItem(w);
    // simulate a prior pick that ended in FAILED
    const content = w.catalog.createContent({ source_ids: [], title: item.title_hint, library_item_id: item.item_id, library_channel_id: "channel-a" });
    const failedRun: Run = {
      schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-a", portfolio_id: "portfolio-main",
      workflow_release: { id: "channel-publish", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "channel", revision: 1 },
      content_id: content.content_id, options: {}, state: "FAILED", effective_config_snapshot: {}, effective_config_digest: "sha256:" + "a".repeat(64),
      total_cost_usd: 0, created_at: T0, updated_at: T0,
    };
    w.store.insertRun(failedRun);

    const result = await autoPick(depsFor(w, channel, [item]));
    expect(result.skipped).toBe("no-candidate");
  });

  it("skips concurrency when the channel already has max_concurrent_runs channel-publish runs going", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 3 }, auto_pick: { max_concurrent_runs: 1 } });
    const busyItem = seedItem(w);
    const content = w.catalog.createContent({ source_ids: [], title: "busy", library_item_id: busyItem.item_id, library_channel_id: "channel-a" });
    const runningRun: Run = {
      schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-a", portfolio_id: "portfolio-main",
      workflow_release: { id: "channel-publish", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "channel", revision: 1 },
      content_id: content.content_id, options: {}, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: "sha256:" + "a".repeat(64),
      total_cost_usd: 0, created_at: T0, updated_at: T0,
    };
    w.store.insertRun(runningRun);
    const otherItem = seedItem(w);

    const result = await autoPick(depsFor(w, channel, [otherItem]));
    expect(result.skipped).toBe("concurrency");
  });

  it("writes the claim file and enqueues a READY run for the picked item", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const item = seedItem(w);

    const result = await autoPick(depsFor(w, channel, [item]));

    expect(result.picked).toEqual({ item_id: item.item_id, run_id: expect.any(String) });
    expect(w.channelFs.listClaims(item.item_id).map((c) => c.channel_id)).toEqual(["channel-a"]);
    const run = w.store.getRun(result.picked!.run_id);
    expect(run?.state).toBe("READY");
    const events = w.store.listEvents({ event_type: "channel.auto_picked" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ channel_id: "channel-a", item_id: item.item_id, run_id: result.picked!.run_id });
  });

  it("removes the claim file it wrote when planning fails after claimItem already committed it, so the item can be picked again", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const item = seedItem(w);
    const failingDeps = { ...depsFor(w, channel, [item]), workflows: () => { throw new Error("no such workflow"); } };

    const first = await autoPick(failingDeps);
    expect(first.skipped).toBe("pick-failed");
    expect(w.channelFs.listClaims(item.item_id)).toEqual([]);
    expect(w.store.listContentItems()).toEqual([]);
    const failedEvents = w.store.listEvents({ event_type: "channel.auto_pick_failed" });
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.payload).toMatchObject({ channel_id: "channel-a", item_id: item.item_id });

    // the item is not permanently hidden behind an orphaned claim file: a later call with working deps picks it
    const second = await autoPick(depsFor(w, channel, [item]));
    expect(second.picked).toBeDefined();
    expect(second.picked!.item_id).toBe(item.item_id);
    expect(w.channelFs.listClaims(item.item_id).map((c) => c.channel_id)).toEqual(["channel-a"]);
  });
});
