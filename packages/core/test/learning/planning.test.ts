import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type ContentRequest, type Demand, type PublicationJob, type Run } from "@harness/contracts";
import {
  channelDemand, HARNESS_ROOT, LibraryFs, loadHarnessConfig, loadWorkflow, NullMediaProber, planningNeeded, planRequestsRun,
  Planner, SourceCatalog, type PlanRequestsDeps,
} from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, makeChannel, makeChannelPlanningProfile, makeChannelPlanningWorkflow, makeLibraryItem, noopLogger } from "./fixtures.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "learning-planning-"));
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, dir, clock } = openTempStore(T0);
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "copy" });
  const planner = new Planner(store);
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const planningProfile = makeChannelPlanningProfile();
  const planningWorkflow = makeChannelPlanningWorkflow();
  const workflows = (ref: string) => (ref === "channel-planning@1.0.0" ? planningWorkflow : loadWorkflow(HARNESS_ROOT, ref));
  return { root, fs, store, dir, clock, catalog, planner, harness, planningProfile, workflows };
}

function depsFor(w: ReturnType<typeof world>, channel: ReturnType<typeof makeChannel>): PlanRequestsDeps {
  return {
    store: w.store, clock: w.clock, channel, catalog: w.catalog, planner: w.planner, harness: w.harness,
    projectId: "project-a", portfolioId: "portfolio-main", profile: w.planningProfile, workflows: w.workflows,
    executorVersionFor: () => "v1", libraryItems: [], libraryClaimsOf: () => [], logger: noopLogger,
  };
}

function insertJob(store: ReturnType<typeof openTempStore>["store"], o: Partial<PublicationJob> & { state: PublicationJob["state"] }): PublicationJob {
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: newId("channel_package"),
    idempotency_key: "sha256:" + Math.random().toString(16).slice(2).padStart(64, "0"), youtube_video_id: null, receipt: null,
    created_at: T0, updated_at: T0, channel_id: "channel-a", library_item_id: newId("library_item"), run_id: newId("run"),
    operation_id: null, scheduled_at: null, published_at: null, last_verified_at: null, note: null,
    ...o,
  };
  store.insertPublicationJob(job);
  return job;
}

function makeOpenRequest(store: ReturnType<typeof openTempStore>["store"], o: { channel_id?: string; status?: ContentRequest["status"] } = {}): ContentRequest {
  const request: ContentRequest = {
    schema_version: "harness.content-request/v1", request_id: newId("content_request"),
    requested_by: { portfolio_id: "portfolio-main", channel_id: o.channel_id ?? "channel-a" }, topic: "A topic", voice: "none",
    language: "vi", count: 1, status: o.status ?? "open", item_ids: [], notes: "", created_at: T0, updated_at: T0,
  };
  store.upsertContentRequest(request);
  return request;
}

describe("channelDemand", () => {
  it("needed equals slots.length when nothing at all is covered", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const demand = channelDemand({ store, clock, channel, libraryItems: [], libraryClaimsOf: () => [] });
    expect(demand.slots).toHaveLength(3);
    expect(demand.covered).toEqual({ jobs: 0, runs: 0, items: 0, requests: 0 });
    expect(demand.needed).toBe(3);
  });

  it("echoes channel.config.planning.topics_per_run", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3, topics_per_run: 7 } });
    const demand = channelDemand({ store, clock, channel, libraryItems: [], libraryClaimsOf: () => [] });
    expect(demand.topics_per_run).toBe(7);
  });

  it("one SCHEDULED job + one shared approved item + one open request cover all 3 slots", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    insertJob(store, { state: "SCHEDULED", scheduled_at: "2026-09-12T13:00:00.000Z" });
    makeOpenRequest(store);
    const item = makeLibraryItem({ status: "approved" }); // no request_id -> counts as covering demand

    const demand = channelDemand({ store, clock, channel, libraryItems: [item], libraryClaimsOf: () => [] });
    expect(demand.covered).toEqual({ jobs: 1, runs: 0, items: 1, requests: 1 });
    expect(demand.needed).toBe(0);
    expect(demand.open_requests).toBe(1);
  });

  it("an approved item carrying this channel's own request_id counts as covered even after the request is fulfilled", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    // realistic case: by the time an item is `approved`, its originating request has almost always already
    // moved to `fulfilled` (applyReview -> fulfillRequest) -- coverage must key off the owning channel, not
    // the request's current status.
    const ownRequest = makeOpenRequest(store, { status: "fulfilled" });
    const item = makeLibraryItem({ status: "approved", request_id: ownRequest.request_id });

    const demand = channelDemand({ store, clock, channel, libraryItems: [item], libraryClaimsOf: () => [] });
    expect(demand.covered.items).toBe(1);
    expect(demand.needed).toBe(2);
  });

  it("an approved item carrying another channel's request_id does not count as covered", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const otherChannelRequest = makeOpenRequest(store, { channel_id: "channel-b", status: "fulfilled" });
    const item = makeLibraryItem({ status: "approved", request_id: otherChannelRequest.request_id });

    const demand = channelDemand({ store, clock, channel, libraryItems: [item], libraryClaimsOf: () => [] });
    expect(demand.covered.items).toBe(0);
    expect(demand.needed).toBe(3);
  });

  it("channelDemand returns fewer slots instead of throwing when nextSlot cannot find one within its own search window", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({
      planning: { lookahead_slots: 5 },
      publication: { max_daily_uploads: 1, min_gap_hours: 100_000 }, // no second slot exists within 60 days
    });

    let demand: Demand | undefined;
    expect(() => { demand = channelDemand({ store, clock, channel, libraryItems: [], libraryClaimsOf: () => [] }); }).not.toThrow();
    expect(demand!.slots.length).toBeGreaterThan(0);
    expect(demand!.slots.length).toBeLessThan(5);
  });

  it("an approved item already claimed by this channel does not count as covered", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel({ planning: { lookahead_slots: 3 } });
    const item = makeLibraryItem({ status: "approved" });

    const demand = channelDemand({
      store, clock, channel, libraryItems: [item],
      libraryClaimsOf: (id) => (id === item.item_id ? [{ schema_version: "harness.library-claim/v1", item_id: id, channel_id: "channel-a", portfolio_id: "portfolio-main", claimed_at: T0, note: "" }] : []),
    });
    expect(demand.covered.items).toBe(0);
    expect(demand.needed).toBe(3);
  });
});

describe("planningNeeded", () => {
  const base: Demand = {
    schema_version: "harness.demand/v1", channel_id: "channel-a", needed: 0, slots: [],
    covered: { jobs: 0, runs: 0, items: 0, requests: 0 }, open_requests: 0, max_open_requests: 3, topics_per_run: 3,
  };
  it("true only when needed>0 and open_requests<max_open_requests", () => {
    expect(planningNeeded({ ...base, needed: 1 })).toBe(true);
    expect(planningNeeded({ ...base, needed: 0 })).toBe(false);
    expect(planningNeeded({ ...base, needed: 1, open_requests: 3 })).toBe(false);
  });
});

describe("planRequestsRun", () => {
  it("starts a channel-planning run: content carries library_channel_id, run is READY, event recorded", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });

    const result = await planRequestsRun(depsFor(w, channel));

    expect(result.started).toBeDefined();
    expect(result.skipped).toBeUndefined();
    const run = w.store.getRun(result.started!.run_id);
    expect(run?.state).toBe("READY");
    const content = w.store.getContentItem(run!.content_id!);
    expect(content?.library_channel_id).toBe("channel-a");
    expect(content?.title).toMatch(/^planning channel-a /);
    const events = w.store.listEvents({ event_type: "channel.planning_started" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ channel_id: "channel-a", run_id: result.started!.run_id, needed: 1 });
  });

  it("skips run-active while a channel-planning run for this channel has not finished", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });

    const first = await planRequestsRun(depsFor(w, channel));
    expect(first.started).toBeDefined();

    const second = await planRequestsRun(depsFor(w, channel));
    expect(second.skipped).toBe("run-active");
  });

  it("does not treat a sibling channel whose id is a string-prefix of this one's as having an active run", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    const siblingId = "channel-a-shorts"; // "channel-a" is a string-prefix of this
    const content = w.catalog.createContent({ source_ids: [], title: `planning ${siblingId} 2026-09-11`, library_channel_id: siblingId });
    const siblingRun: Run = {
      schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-a", portfolio_id: "portfolio-main",
      workflow_release: { id: "channel-planning", version: "1.0.0", digest: "sha256:" + "b".repeat(64) }, profile_snapshot: { id: "channel-planning", revision: 1 },
      content_id: content.content_id, options: {}, state: "READY", effective_config_snapshot: {}, effective_config_digest: "sha256:" + "b".repeat(64),
      total_cost_usd: 0, created_at: T0, updated_at: T0,
    };
    w.store.insertRun(siblingRun);

    const result = await planRequestsRun(depsFor(w, channel));
    expect(result.started).toBeDefined();
  });

  it("skips run-active for the rest of the day after a channel-planning run for this channel finished, then starts the next day", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    const content = w.catalog.createContent({ source_ids: [], title: `planning channel-a ${T0.slice(0, 10)}`, library_channel_id: "channel-a" });
    const finishedRun: Run = {
      schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-a", portfolio_id: "portfolio-main",
      workflow_release: { id: "channel-planning", version: "1.0.0", digest: "sha256:" + "c".repeat(64) }, profile_snapshot: { id: "channel-planning", revision: 1 },
      content_id: content.content_id, options: {}, state: "SUCCEEDED", effective_config_snapshot: {}, effective_config_digest: "sha256:" + "c".repeat(64),
      total_cost_usd: 0, created_at: T0, updated_at: T0,
    };
    w.store.insertRun(finishedRun);

    const sameDay = await planRequestsRun(depsFor(w, channel));
    expect(sameDay.skipped).toBe("run-active");

    w.clock.advance(24 * 3600);
    const nextDay = await planRequestsRun(depsFor(w, channel));
    expect(nextDay.started).toBeDefined();
  });

  it("skips open-cap and dedups the channel.planning_skipped event within the same UTC day", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 2, max_open_requests: 1 } });
    makeOpenRequest(w.store); // covers one of the two slots but is already at the open-request cap

    const first = await planRequestsRun(depsFor(w, channel));
    expect(first.skipped).toBe("open-cap");
    const second = await planRequestsRun(depsFor(w, channel));
    expect(second.skipped).toBe("open-cap");

    const events = w.store.listEvents({ event_type: "channel.planning_skipped" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ channel_id: "channel-a", reason: "open-cap" });
  });

  // Regression: the dedup used to read the newest-1000 `channel.planning_skipped` events across EVERY
  // channel and filter in JS, so a busy sibling channel could push this channel's own marker out of the
  // window -- re-emitting one `channel.planning_skipped` per poll for the rest of the day.
  it("still dedups when a busy sibling channel floods the shared newest-events window", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 2, max_open_requests: 1 } });
    makeOpenRequest(w.store);

    const first = await planRequestsRun(depsFor(w, channel));
    expect(first.skipped).toBe("open-cap");

    // 1000 strictly newer sibling-channel events of the same type: exactly fills `listEvents({ newest:
    // true })`'s window, pushing this channel's own marker out of it (same UTC day throughout)
    w.clock.advance(60);
    for (let i = 0; i < 1000; i++) {
      w.store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "channel-busy",
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "channel.planning_skipped",
        payload: { channel_id: "channel-busy", reason: "open-cap" },
      });
    }
    expect(w.store.listEvents({ event_type: "channel.planning_skipped", newest: true }).every((e) => e.payload.channel_id === "channel-busy")).toBe(true);

    const second = await planRequestsRun(depsFor(w, channel));
    expect(second.skipped).toBe("open-cap");
    const mine = w.store.listEvents({ event_type: "channel.planning_skipped", channel_id: "channel-a" });
    expect(mine).toHaveLength(1);
  });

  it("skips covered without any run/event when demand is already met", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    insertJob(w.store, { state: "SCHEDULED", scheduled_at: "2026-09-12T13:00:00.000Z" });

    const result = await planRequestsRun(depsFor(w, channel));
    expect(result.skipped).toBe("covered");
    expect(w.store.listRuns({})).toEqual([]);
  });

  it("skips cooldown for 24h after a channel.planning_failed event for this channel", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    w.store.appendEvent({
      run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "channel-a",
      content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "channel.planning_failed",
      payload: { channel_id: "channel-a", reason: "boom" },
    });

    const result = await planRequestsRun(depsFor(w, channel));
    expect(result.skipped).toBe("cooldown");
  });

  it("reports plan-failed and records channel.planning_failed when planning throws, without leaving a run behind", async () => {
    const w = world();
    const channel = makeChannel({ planning: { lookahead_slots: 1 } });
    const deps = { ...depsFor(w, channel), workflows: () => { throw new Error("no such workflow"); } };

    const result = await planRequestsRun(deps);
    expect(result.skipped).toBe("plan-failed");
    expect(w.store.listRuns({})).toEqual([]);
    const events = w.store.listEvents({ event_type: "channel.planning_failed" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ channel_id: "channel-a" });
  });
});
