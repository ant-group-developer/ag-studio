/**
 * Agent turns take a `claude` slot in the harness `lease` table, so one cap covers every worker process. A turn that
 * finds the cap full leaves a "waiting" row that also counts: the next slot freed goes to the turn that waited.
 */
import { describe, expect, it } from "vitest";
import { acquireClaudeSlot, claudeUsage, heartbeatClaudeSlot, idsHoldingSlots, releaseClaudeSlot } from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-06T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

describe("agent slots on the lease table", () => {
  it("a turn holding a slot keeps it when it asks again, and gives it back", () => {
    const { db } = world();
    expect(acquireClaudeSlot(db, "agent", "turn-1", 1, T0)).toBe(true);
    expect(acquireClaudeSlot(db, "agent", "turn-1", 1, T0)).toBe(true);
    expect(claudeUsage(db)).toEqual({ running: 1, waiting: 0 });
    expect(idsHoldingSlots(db, "agent")).toEqual(["turn-1"]);
    releaseClaudeSlot(db, "agent", "turn-1");
    expect(claudeUsage(db)).toEqual({ running: 0, waiting: 0 });
  });

  it("two waiting turns do not block each other once slots free up", () => {
    const { db } = world();
    expect(acquireClaudeSlot(db, "agent", "turn-1", 2, T0)).toBe(true);
    expect(acquireClaudeSlot(db, "agent", "turn-2", 2, T0)).toBe(true);
    expect(acquireClaudeSlot(db, "agent", "turn-3", 2, T0)).toBe(false);
    expect(acquireClaudeSlot(db, "agent", "turn-4", 2, T0)).toBe(false);
    releaseClaudeSlot(db, "agent", "turn-1");
    expect(acquireClaudeSlot(db, "agent", "turn-3", 2, T0)).toBe(true);
    expect(acquireClaudeSlot(db, "agent", "turn-4", 2, T0)).toBe(false);
    expect(claudeUsage(db)).toEqual({ running: 2, waiting: 1 });
  });

  it("a slot from a process that died runs out and is cleared on the next acquire", () => {
    const { db } = world();
    expect(acquireClaudeSlot(db, "agent", "turn-1", 2, T0, 60)).toBe(true);
    expect(acquireClaudeSlot(db, "agent", "turn-2", 1, T0, 60)).toBe(false);
    heartbeatClaudeSlot(db, "agent", "turn-1", later(50), 60);
    expect(acquireClaudeSlot(db, "agent", "turn-x", 9, later(90), 60)).toBe(true);
    expect(claudeUsage(db, later(90))).toEqual({ running: 2, waiting: 0 }); // the wait expired, the heartbeated slot did not
  });
});
