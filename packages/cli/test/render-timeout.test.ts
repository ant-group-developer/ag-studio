import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { MEDIA_RENDER_TIMEOUT_SECONDS, renderTimeoutSeconds } from "../src/commands/media.js";

// Task-8 fix round 1, m1: the `media render` wall-clock budget --
// `min(max(1200, total*3 + 300), secondsUntil(deadline_at) - 30)`.
const NOW = Date.parse("2026-09-23T00:00:00.000Z");
const inSeconds = (s: number): string => new Date(NOW + s * 1000).toISOString();

describe("renderTimeoutSeconds", () => {
  it("floors at 20 minutes for a short programme", () => {
    // 60s x 3 + 300 = 480, under the 1200 floor; the deadline is far away and does not bind.
    expect(renderTimeoutSeconds(60, inSeconds(10_000), NOW)).toBe(1200);
    expect(renderTimeoutSeconds(0, inSeconds(10_000), NOW)).toBe(1200);
  });

  it("scales as total x 3 + 300 once that beats the floor", () => {
    // 600s x 3 + 300 = 2100
    expect(renderTimeoutSeconds(600, inSeconds(10_000), NOW)).toBe(2100);
    // 1800s x 3 + 300 = 5700
    expect(renderTimeoutSeconds(1800, inSeconds(20_000), NOW)).toBe(5700);
  });

  it("clamps to the stage deadline minus a 30 s margin, so ffmpeg is killed by us and not by the lease", () => {
    // 900s of deadline left -> 870 available, well under the 1200 floor the programme would otherwise get.
    expect(renderTimeoutSeconds(60, inSeconds(900), NOW)).toBe(870);
    // Exactly at the boundary: 1230s left -> 1200, the floor and the clamp agree.
    expect(renderTimeoutSeconds(60, inSeconds(1230), NOW)).toBe(1200);
  });

  it("refuses outright when the deadline is already inside the 30 s margin (IO_ERROR -> transient)", () => {
    for (const left of [30, 10, 0, -100]) {
      let thrown: unknown;
      try { renderTimeoutSeconds(60, inSeconds(left), NOW); } catch (e) { thrown = e; }
      expect(isHarnessError(thrown, "IO_ERROR"), `left=${left}: ${String(thrown)}`).toBe(true);
      expect((thrown as Error).message).toContain("no time left");
    }
  });

  it("the outer ScriptCommand cap is the 2 hours spec §6.1 asks for", () => {
    expect(MEDIA_RENDER_TIMEOUT_SECONDS).toBe(7200);
  });
});
