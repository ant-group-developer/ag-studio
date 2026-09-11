import { describe, expect, it } from "vitest";
import { HarnessError } from "../src/errors.js";

describe("HarnessError", () => {
  it("carries a closed error code and details", () => {
    const err = new HarnessError("INVALID_TRANSITION", "bad move", { from: "A", to: "B" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("INVALID_TRANSITION");
    expect(err.details).toEqual({ from: "A", to: "B" });
    expect(err.message).toBe("bad move");
  });
});
