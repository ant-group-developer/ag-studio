import { describe, expect, it } from "vitest";
import { episodeStatusOf } from "../src/run-control.js";

const st = (...states: string[]) => states.map((state) => ({ state, gate: false }));

describe("episodeStatusOf", () => {
  it("follows the run when it is finished", () => {
    expect(episodeStatusOf("SUCCEEDED", st("SUCCEEDED"))).toBe("ready");
    expect(episodeStatusOf("FAILED", st("SUCCEEDED", "FAILED"))).toBe("failed");
    expect(episodeStatusOf("CANCELLED", st("SUCCEEDED", "CANCELLED"))).toBe("cancelled");
  });

  it("is producing while stages run or wait their turn", () => {
    expect(episodeStatusOf("RUNNING", st("SUCCEEDED", "RUNNING", "PENDING"))).toBe("producing");
  });

  it("is failed when a stage that is not a gate waits for a person: someone must retry it", () => {
    expect(episodeStatusOf("WAITING", st("SUCCEEDED", "WAITING_HUMAN", "PENDING"))).toBe("failed");
  });

  it("waits for approval when a gate waits (episode 1.3.0)", () => {
    expect(episodeStatusOf("WAITING", [{ state: "SUCCEEDED", gate: false }, { state: "WAITING_HUMAN", gate: true }, { state: "PENDING", gate: false }]))
      .toBe("waiting_approval");
  });
});
