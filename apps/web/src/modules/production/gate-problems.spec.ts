import { describe, expect, it } from "vitest";
import { gateProblems } from "./gate-problems";

describe("gateProblems", () => {
  it("returns empty array for non-error", () => {
    expect(gateProblems(null)).toEqual([]);
    expect(gateProblems(undefined)).toEqual([]);
    expect(gateProblems("string")).toEqual([]);
  });

  it("extracts messages from failed[].evidence.problems (object form)", () => {
    const err = {
      body: {
        code: "rejected",
        failed: [
          { check_id: "rnd-valid", evidence: { problems: [{ code: "missing_summary", message: "Summary is required" }] } },
        ],
      },
    };
    expect(gateProblems(err)).toEqual(["Summary is required"]);
  });

  it("extracts messages from failed[].evidence.problems (string form)", () => {
    const err = {
      body: {
        code: "rejected",
        failed: [
          { check_id: "rnd-valid", evidence: { problems: ["Direction must have at least 1 content pillar"] } },
        ],
      },
    };
    expect(gateProblems(err)).toEqual(["Direction must have at least 1 content pillar"]);
  });

  it("extracts reason from failed[].evidence.reason", () => {
    const err = {
      body: {
        code: "rejected",
        failed: [
          { check_id: "rnd-valid", evidence: { reason: "R&D summary is too short" } },
        ],
      },
    };
    expect(gateProblems(err)).toEqual(["R&D summary is too short"]);
  });

  it("extracts missing[] as 'thiếu ...' messages", () => {
    const err = {
      body: {
        code: "rejected",
        missing: ["direction.description", "direction.goal"],
      },
    };
    expect(gateProblems(err)).toEqual(["thiếu direction.description", "thiếu direction.goal"]);
  });

  it("extracts top-level problems[] (PUT /rnd 422 shape)", () => {
    const err = {
      body: {
        code: "rejected",
        problems: [
          { code: "too_short", message: "Summary must be at least 1 character" },
          { code: "missing_field", message: "direction.goal is required" },
        ],
      },
    };
    expect(gateProblems(err)).toEqual([
      "Summary must be at least 1 character",
      "direction.goal is required",
    ]);
  });

  it("falls back to body.message when no structured problems", () => {
    const err = { body: { code: "rejected", message: "Generic error from server" } };
    expect(gateProblems(err)).toEqual(["Generic error from server"]);
  });

  it("falls back to err.message when no body", () => {
    const err = new Error("Network error");
    expect(gateProblems(err)).toEqual(["Network error"]);
  });

  it("collects problems from multiple failed checks", () => {
    const err = {
      body: {
        code: "rejected",
        failed: [
          { check_id: "c1", evidence: { problems: [{ code: "e1", message: "Error 1" }] } },
          { check_id: "c2", evidence: { problems: ["Error 2"] } },
          { check_id: "c3", evidence: { reason: "Reason 3" } },
        ],
      },
    };
    expect(gateProblems(err)).toEqual(["Error 1", "Error 2", "Reason 3"]);
  });

  it("handles body directly on error object (no .body wrapper)", () => {
    const err = {
      code: "rejected",
      failed: [
        { check_id: "c1", evidence: { problems: [{ code: "e1", message: "Direct body error" }] } },
      ],
    };
    expect(gateProblems(err)).toEqual(["Direct body error"]);
  });
});
