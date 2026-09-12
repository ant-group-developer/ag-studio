import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow } from "../../src/orchestration/registry.js";

describe("registry loaders", () => {
  it("loads the sample workflow with a stable digest", () => {
    const a = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const b = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    expect(a.definition.stages.map((s) => s.key)).toEqual(["produce", "review", "finalize"]);
    expect(a.digest).toBe(b.digest);
    expect(a.definition.stages[0]?.retry.max_attempts).toBe(3);
  });
  it("rejects a version that does not match the file", () => {
    expect(() => loadWorkflow(HARNESS_ROOT, "sample-three-stage@9.9.9")).toThrow(/version/);
  });
  it("loads profile and harness config", () => {
    expect(loadProfile(HARNESS_ROOT, "cartoon").overrides).toEqual({ lease_seconds: 120 });
    expect(loadHarnessConfig(HARNESS_ROOT).lease_seconds).toBe(90);
  });
});
