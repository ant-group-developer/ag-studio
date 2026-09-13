import { describe, expect, it } from "vitest";
import { HarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, Planner } from "../../src/index.js";
import { buildStageRequest, mimeTypesFor, stageDefinitionFor } from "../../src/orchestration/request.js";
import { beginAttempt, openTempStore } from "../helpers.js";

function planClaimAndBegin() {
  const { store, clock } = openTempStore();
  const planner = new Planner(store);
  const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
  planner.enqueue(run.run_id);
  const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: clock.now(), leaseSeconds: 90 })!;
  const { stageRun, attempt } = beginAttempt(store, claim);
  return { store, clock, run, stageRun, attempt, claim };
}

describe("buildStageRequest", () => {
  it("carries expected outputs, mime map, options, policy and lease resources", () => {
    const { store, clock } = openTempStore();
    const planner = new Planner(store);
    const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
    planner.enqueue(run.run_id);
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: clock.now(), leaseSeconds: 90 })!;
    const { stageRun, attempt } = beginAttempt(store, claim);
    const deps = { store, clock, harness: loadHarnessConfig(HARNESS_ROOT), profiles: (id: string) => loadProfile(HARNESS_ROOT, id), workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };
    const req = buildStageRequest(deps, { run, stageRun, attempt, lease: claim.lease, inputs: [], workspaceDir: "/ws", capabilities: ["write_workspace"] });
    expect(req.expected_outputs).toEqual([{ type: "script_text", mime_type: "text/plain", kind: "file" }]);
    expect(req.stage_config.__script).toBe("fake-stage");
    expect(req.policy).toEqual({});
    expect(req.resources).toEqual([]);
    expect(mimeTypesFor(stageDefinitionFor(deps.workflows, run, "produce"))).toEqual({ script_text: "text/plain" });
  });

  it("tolerates a missing profile file (NOT_FOUND) and builds the request with policy: {}", () => {
    const { store, clock, run, stageRun, attempt, claim } = planClaimAndBegin();
    const deps = { store, clock, harness: loadHarnessConfig(HARNESS_ROOT), profiles: (_id: string) => { throw new HarnessError("NOT_FOUND", "profile file gone"); }, workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };
    const req = buildStageRequest(deps, { run, stageRun, attempt, lease: claim.lease, inputs: [], workspaceDir: "/ws", capabilities: ["write_workspace"] });
    expect(req.policy).toEqual({});
  });

  it("does not swallow an unrelated error from profiles", () => {
    const { store, clock, run, stageRun, attempt, claim } = planClaimAndBegin();
    const deps = { store, clock, harness: loadHarnessConfig(HARNESS_ROOT), profiles: (_id: string) => { throw new Error("boom"); }, workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };
    expect(() => buildStageRequest(deps, { run, stageRun, attempt, lease: claim.lease, inputs: [], workspaceDir: "/ws", capabilities: ["write_workspace"] })).toThrow("boom");
  });
});
