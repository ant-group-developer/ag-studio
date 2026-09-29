import { describe, expect, it, vi } from "vitest";
import { Autosaver, type SaveResult } from "./autosave";
import { sampleTimeline } from "./fixtures";

function setup(results: SaveResult[]) {
  const calls: { base: number; text: string }[] = [];
  const events: string[] = [];
  const saver = new Autosaver({
    delayMs: 1000,
    save: async (base, t) => {
      calls.push({ base, text: t.narration[0]!.text });
      return results.shift() ?? { ok: true, revision: base + 1 };
    },
    onSaved: (rev) => events.push(`saved:${rev}`),
    onConflict: (cur) => events.push(`conflict:${cur}`),
    onError: (m) => events.push(`error:${m}`),
  });
  return { saver, calls, events };
}

const withText = (text: string) => {
  const t = sampleTimeline();
  return { ...t, narration: [{ ...t.narration[0]!, text }, ...t.narration.slice(1)] };
};

describe("Autosaver", () => {
  it("debounces: only the last edit of a burst is saved, on top of the held revision", async () => {
    vi.useFakeTimers();
    const { saver, calls, events } = setup([]);
    saver.schedule(3, withText("a"));
    saver.schedule(3, withText("ab"));
    saver.schedule(3, withText("abc"));
    expect(saver.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([{ base: 3, text: "abc" }]);
    expect(events).toEqual(["saved:4"]);
    expect(saver.status).toBe("idle");
    vi.useRealTimers();
  });

  it("409: stops saving, reports the current revision, and ignores edits until resolved", async () => {
    const { saver, calls, events } = setup([{ ok: false, conflict: true, currentRevision: 9 }]);
    saver.schedule(3, withText("mine"));
    await saver.flush();
    expect(events).toEqual(["conflict:9"]);
    expect(saver.status).toBe("conflict");
    saver.schedule(3, withText("more"));
    await saver.flush();
    expect(calls).toHaveLength(1); // nothing sent while in conflict
    saver.resolveConflict();
    saver.schedule(9, withText("rebased"));
    await saver.flush();
    expect(calls.at(-1)).toEqual({ base: 9, text: "rebased" });
    expect(events.at(-1)).toBe("saved:10");
  });

  it("an edit made while a save is in flight is saved next, based on the new revision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: number[] = [];
    const saver = new Autosaver({
      save: async (base) => { calls.push(base); if (calls.length === 1) await gate; return { ok: true, revision: base + 1 }; },
      onSaved: () => {}, onConflict: () => {}, onError: () => {},
    });
    saver.schedule(1, withText("first"));
    const first = saver.flush();
    saver.schedule(1, withText("second")); // the page still believes revision 1
    release();
    await first;
    await saver.flush();
    expect(calls).toEqual([1, 2]);
  });

  it("reports every status change, and is already idle when onSaved runs", async () => {
    const statuses: string[] = [];
    let statusSeenBySaved = "";
    const saver: Autosaver = new Autosaver({
      save: async (base) => ({ ok: true, revision: base + 1 }),
      onSaved: () => { statusSeenBySaved = saver.status; },
      onConflict: () => {}, onError: () => {},
      onStatus: (s) => statuses.push(s),
    });
    saver.schedule(1, withText("x"));
    await saver.flush();
    expect(statuses).toEqual(["pending", "saving", "idle"]);
    expect(statusSeenBySaved).toBe("idle");
  });

  it("a network error keeps the edit and retries it on the next flush", async () => {
    const { saver, calls, events } = setup([{ ok: false, conflict: false, error: "offline" }]);
    saver.schedule(2, withText("x"));
    await saver.flush();
    expect(saver.status).toBe("error");
    await saver.flush();
    expect(calls.map((c) => c.text)).toEqual(["x", "x"]);
    expect(events).toEqual(["error:offline", "saved:3"]);
  });
});
