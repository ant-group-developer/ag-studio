/**
 * Agent turns take a `claude` slot in the harness `lease` table, so one cap covers every worker process. A turn that
 * finds the cap full leaves a "waiting" row that also counts: the next slot freed goes to the turn that waited.
 */
import { afterEach, describe, expect, it } from "vitest";
import { acquireClaudeSlot, claudeUsage, heartbeatClaudeSlot, idsHoldingSlots, releaseClaudeSlot, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-06T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

let open: StudioDb | null = null;
afterEach(async () => { await open?.close(); open = null; });
const fresh = async () => (open = (await world()).db);

describe("agent slots on the lease table", () => {
  it("a turn holding a slot keeps it when it asks again, and gives it back", async () => {
    const db = await fresh();
    expect(await acquireClaudeSlot(db, "agent", "turn-1", 1, T0)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "turn-1", 1, T0)).toBe(true);
    expect(await claudeUsage(db)).toEqual({ running: 1, waiting: 0 });
    expect(await idsHoldingSlots(db, "agent")).toEqual(["turn-1"]);
    await releaseClaudeSlot(db, "agent", "turn-1");
    expect(await claudeUsage(db)).toEqual({ running: 0, waiting: 0 });
  });

  it("two waiting turns do not block each other once slots free up", async () => {
    const db = await fresh();
    expect(await acquireClaudeSlot(db, "agent", "turn-1", 2, T0)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "turn-2", 2, T0)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "turn-3", 2, T0)).toBe(false);
    expect(await acquireClaudeSlot(db, "agent", "turn-4", 2, T0)).toBe(false);
    await releaseClaudeSlot(db, "agent", "turn-1");
    expect(await acquireClaudeSlot(db, "agent", "turn-3", 2, T0)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "turn-4", 2, T0)).toBe(false);
    expect(await claudeUsage(db)).toEqual({ running: 2, waiting: 1 });
  });

  it("turns asking at the same moment never take more slots than the cap", async () => {
    const db = await fresh();
    const got = await Promise.all(Array.from({ length: 6 }, (_, i) => acquireClaudeSlot(db, "agent", `turn-${i}`, 2, T0)));
    expect(got.filter(Boolean)).toHaveLength(2);
    expect(await claudeUsage(db)).toEqual({ running: 2, waiting: 4 });
  });

  it("a slot from a process that died runs out and is cleared on the next acquire", async () => {
    const db = await fresh();
    expect(await acquireClaudeSlot(db, "agent", "turn-1", 2, T0, 60)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "turn-2", 1, T0, 60)).toBe(false);
    await heartbeatClaudeSlot(db, "agent", "turn-1", later(50), 60);
    expect(await acquireClaudeSlot(db, "agent", "turn-x", 9, later(90), 60)).toBe(true);
    expect(await claudeUsage(db, later(90))).toEqual({ running: 2, waiting: 0 }); // the wait expired, the heartbeated slot did not
  });
});
