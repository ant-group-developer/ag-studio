import { describe, expect, it } from "vitest";
import { episodeStatusOf } from "../src/run-control.js";

describe("episodeStatusOf", () => {
  it("follows the run when it is finished", () => {
    expect(episodeStatusOf("SUCCEEDED", ["SUCCEEDED"])).toBe("ready");
    expect(episodeStatusOf("FAILED", ["SUCCEEDED", "FAILED"])).toBe("failed");
    expect(episodeStatusOf("CANCELLED", ["SUCCEEDED", "CANCELLED"])).toBe("cancelled");
  });

  it("is producing while stages run or wait their turn", () => {
    expect(episodeStatusOf("RUNNING", ["SUCCEEDED", "RUNNING", "PENDING"])).toBe("producing");
  });

  it("is failed when a stage waits for a person: an episode run has no gate, so someone must retry it", () => {
    expect(episodeStatusOf("WAITING", ["SUCCEEDED", "WAITING_HUMAN", "PENDING"])).toBe("failed");
  });
});
