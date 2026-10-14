/**
 * The worker sends the usage outbox to ag-go (plan 2026-10-13 P4): due batches of 200, marked sent; a failure (ag-go
 * down, a key without `usage:write`) keeps them for later with a longer wait each time; an event ag-go could never take
 * is set aside. ag-go is a fake sink.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject, enqueueUsage, sendDueUsage, startUsageSender, studioLogger, USAGE_BATCH, usageBackoffMs, type UsageEvent, type UsageSink,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-13T08:00:00.000Z";
const T0 = new Date(NOW);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const p = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  const event = (n: number, over: Partial<UsageEvent> = {}): UsageEvent => ({
    eventKey: `job:j:${uuid(n)}`, kind: "final_render", occurredAt: NOW, assetId: uuid(n), agGoProjectId: null, studioProjectId: p.id,
    studioProjectName: "Du lịch chậm", studioVideoId: "v1", studioVideoTitle: "Tràng An", studioUserId: "auth0|u", ...over,
  });
  return { ...w, p, event };
}

/** ag-go: answers or throws `fail` (an `AgGoClientError`-like status) while it is set. */
function fakeSink() {
  const batches: UsageEvent[][] = [];
  const sink: UsageSink & { fail: number | null; refuse: Set<string> } = {
    fail: null,
    refuse: new Set(),
    send: async (events) => {
      batches.push(events);
      if (sink.fail) throw Object.assign(new Error(`ag-go-api error: HTTP ${sink.fail}`), { status: sink.fail });
      if (events.some((e) => sink.refuse.has(e.eventKey))) throw Object.assign(new Error("ag-go-api error: HTTP 400"), { status: 400 });
      return { accepted: events.length, duplicates: 0 };
    },
  };
  return { sink, batches };
}

const rows = (db: ReturnType<typeof world>["db"]) =>
  db.all<{ event_key: string; sent_at: string | null; attempts: number; next_at: string; last_error: string | null }>(
    "SELECT event_key, sent_at, attempts, next_at, last_error FROM ag_go_usage_outbox ORDER BY event_key",
  );

describe("sending the usage outbox", () => {
  it("sends due events in batches of 200 and marks them sent; nothing is sent twice", async () => {
    const s = setup();
    enqueueUsage(s.db, Array.from({ length: 205 }, (_, i) => s.event(i + 1)), NOW);
    enqueueUsage(s.db, [s.event(999)], "2026-10-13T09:00:00.000Z"); // not due yet
    const { sink, batches } = fakeSink();
    expect(await sendDueUsage(s.db, sink, { now: () => T0 })).toMatchObject({ sent: USAGE_BATCH, failed: 0, accepted: 200 });
    expect(await sendDueUsage(s.db, sink, { now: () => T0 })).toMatchObject({ sent: 5 });
    expect(await sendDueUsage(s.db, sink, { now: () => T0 })).toMatchObject({ sent: 0 });
    expect(batches.map((b) => b.length)).toEqual([200, 5]);
    expect(batches[0]![0]).toEqual(s.event(1));
    expect(rows(s.db).filter((r) => r.sent_at === null).map((r) => r.event_key)).toEqual([`job:j:${uuid(999)}`]);
  });

  it("keeps events ag-go did not take (down, 403 without usage:write) and waits longer each time, at most an hour", async () => {
    const s = setup();
    enqueueUsage(s.db, [s.event(1)], NOW);
    const { sink } = fakeSink();
    sink.fail = 403;
    const logged: string[] = [];
    const log = studioLogger({ test: "usage" });
    const spy = { ...log, warn: (msg: string, fields?: Record<string, unknown>) => { logged.push(`${msg} ${JSON.stringify(fields)}`); } } as typeof log;
    expect(await sendDueUsage(s.db, sink, { now: () => T0, log: spy })).toMatchObject({ sent: 0, failed: 1 });
    expect(rows(s.db)[0]).toMatchObject({ sent_at: null, attempts: 1, next_at: "2026-10-13T08:00:30.000Z", last_error: "ag-go-api error: HTTP 403" });
    expect(logged[0]).toContain("usage events not sent to ag-go");
    // not due again before then
    expect(await sendDueUsage(s.db, sink, { now: () => new Date("2026-10-13T08:00:10.000Z") })).toMatchObject({ sent: 0, failed: 0 });
    sink.fail = 503;
    await sendDueUsage(s.db, sink, { now: () => new Date("2026-10-13T08:00:30.000Z") });
    expect(rows(s.db)[0]).toMatchObject({ attempts: 2, next_at: "2026-10-13T08:01:30.000Z" });
    expect([1, 2, 3, 7, 8, 30].map(usageBackoffMs)).toEqual([30_000, 60_000, 120_000, 1_920_000, 3_600_000, 3_600_000]);
    sink.fail = null;
    expect(await sendDueUsage(s.db, sink, { now: () => new Date("2026-10-13T08:01:30.000Z") })).toMatchObject({ sent: 1 });
    expect(rows(s.db)[0]).toMatchObject({ sent_at: "2026-10-13T08:01:30.000Z", last_error: null });
  });

  it("sets aside what ag-go could never take, and sends the rest one by one when it refuses a batch", async () => {
    const s = setup();
    enqueueUsage(s.db, [
      s.event(1), s.event(2), s.event(3, { assetId: "asset-b" }), s.event(4, { assetId: null, agGoProjectId: "agp-1" }), s.event(5, { agGoProjectId: "not-a-uuid" }),
    ], NOW);
    const { sink, batches } = fakeSink();
    sink.refuse.add(`job:j:${uuid(2)}`);
    expect(await sendDueUsage(s.db, sink, { now: () => T0 })).toMatchObject({ sent: 2, setAside: 3, failed: 0 });
    expect(batches.map((b) => b.map((e) => e.eventKey))).toEqual([
      [`job:j:${uuid(1)}`, `job:j:${uuid(2)}`, `job:j:${uuid(5)}`], [`job:j:${uuid(1)}`], [`job:j:${uuid(2)}`], [`job:j:${uuid(5)}`],
    ]);
    expect(batches[3]![0]!.agGoProjectId).toBeNull(); // an ag-go project id that is no UUID is left out, the event goes
    const byKey = new Map(rows(s.db).map((r) => [r.event_key, r]));
    expect(byKey.get(`job:j:${uuid(2)}`)).toMatchObject({ sent_at: NOW, last_error: "set aside: ag-go-api error: HTTP 400" });
    expect(byKey.get(`job:j:${uuid(3)}`)).toMatchObject({ sent_at: NOW, last_error: "set aside: assetId asset-b is not a UUID" });
    expect(byKey.get(`job:j:${uuid(4)}`)!.last_error).toBe("set aside: neither assetId nor agGoProjectId");
  });
});

describe("the worker's usage sender", () => {
  let stop: (() => void) | null = null;
  afterEach(() => stop?.());

  it("sends on its timer until a batch is not full", async () => {
    const s = setup();
    enqueueUsage(s.db, Array.from({ length: 450 }, (_, i) => s.event(i + 1)), NOW);
    const { sink, batches } = fakeSink();
    const sender = startUsageSender({ db: s.db, sink, log: studioLogger({ test: "usage" }), everyMs: 60_000, firstMs: 60_000 });
    stop = sender.stop;
    await sender.tick();
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ag_go_usage_outbox WHERE sent_at IS NULL")!.n).toBe(0);
  });
});
