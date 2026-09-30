import { describe, expect, it, vi } from "vitest";
import { Autosaver, type SaveResult } from "./autosave";
import { sampleTimeline } from "./fixtures";

function setup(results: SaveResult[]) {
  const calls: { base: number; clips: number }[] = [];
  const events: string[] = [];
  const saver = new Autosaver({
    delayMs: 1000,
    save: async (base, t) => {
      calls.push({ base, clips: t.clips.length });
      return results.shift() ?? { ok: true, revision: base + 1 };
    },
    onSaved: (rev) => events.push(`saved:${rev}`),
    onConflict: (cur) => events.push(`conflict:${cur}`),
    onError: (m) => events.push(`error:${m}`),
  });
  return { saver, calls, events };
}

const withClips = (n: number) => {
  const t = sampleTimeline();
  return { ...t, clips: t.clips.slice(0, n) };
};

describe("Autosaver", () => {
  it("debounces: only the last edit of a burst is saved, on top of the held revision", async () => {
    vi.useFakeTimers();
    const { saver, calls, events } = setup([]);
    saver.schedule(3, withClips(3));
    saver.schedule(3, withClips(2));
    saver.schedule(3, withClips(1));
    expect(saver.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([{ base: 3, clips: 1 }]);
    expect(events).toEqual(["saved:4"]);
    expect(saver.status).toBe("idle");
    vi.useRealTimers();
  });

  it("409: stops saving, reports the current revision, and ignores edits until resolved", async () => {
    const { saver, calls, events } = setup([{ ok: false, conflict: true, currentRevision: 9 }]);
    saver.schedule(3, withClips(3));
    await saver.flush();
    expect(events).toEqual(["conflict:9"]);
    expect(saver.status).toBe("conflict");
    saver.schedule(3, withClips(2));
    await saver.flush();
    expect(calls).toHaveLength(1); // nothing sent while in conflict
    saver.resolveConflict();
    saver.schedule(9, withClips(2));
    await saver.flush();
    expect(calls.at(-1)).toEqual({ base: 9, clips: 2 });
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
    saver.schedule(1, withClips(3));
    const first = saver.flush();
    saver.schedule(1, withClips(2)); // the page still believes revision 1
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
    saver.schedule(1, withClips(3));
    await saver.flush();
    expect(statuses).toEqual(["pending", "saving", "idle"]);
    expect(statusSeenBySaved).toBe("idle");
  });

  it("a network error keeps the edit and retries it on the next flush", async () => {
    const { saver, calls, events } = setup([{ ok: false, conflict: false, error: "offline" }]);
    saver.schedule(2, withClips(3));
    await saver.flush();
    expect(saver.status).toBe("error");
    await saver.flush();
    expect(calls.map((c) => c.clips)).toEqual([3, 3]);
    expect(events).toEqual(["error:offline", "saved:3"]);
  });
});
