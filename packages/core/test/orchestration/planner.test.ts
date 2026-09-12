import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow } from "../../src/orchestration/registry.js";
import { Planner } from "../../src/orchestration/planner.js";
import { openTempStore } from "../helpers.js";

function planSample(overrides: Record<string, unknown> = {}) {
  const t = openTempStore();
  const planner = new Planner(t.store);
  const run = planner.plan({
    workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"),
    harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", runOverrides: overrides,
  });
  return { ...t, planner, run };
}

describe("Planner", () => {
  it("creates a DRAFT run with one PENDING stage per workflow stage and a pinned snapshot", () => {
    const { store, run } = planSample();
    expect(run.state).toBe("DRAFT");
    expect(run.effective_config_snapshot.lease_seconds).toBe(120);
    expect(run.workflow_release.digest).toMatch(/^sha256:/);
    const stages = store.listStageRuns(run.run_id);
    expect(stages.map((s) => [s.stage_key, s.state])).toEqual([["produce", "PENDING"], ["review", "PENDING"], ["finalize", "PENDING"]]);
    expect(stages[0]?.stage_config).toEqual({ content: "draft script" });
    expect(store.listEvents({ run_id: run.run_id }).map((e) => e.event_type)).toEqual(["run.created"]);
  });
  it("fails before creating anything when a run override key is unknown", () => {
    try { planSample({ leese_seconds: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "UNKNOWN_CONFIG_KEY")).toBe(true); }
  });
  it("enqueue readies the run and the root stages only", () => {
    const { store, planner, run } = planSample();
    planner.enqueue(run.run_id);
    expect(store.getRun(run.run_id)?.state).toBe("READY");
    expect(store.listStageRuns(run.run_id).map((s) => s.state)).toEqual(["READY", "PENDING", "PENDING"]);
  });
  it("advance releases dependants when all dependencies succeeded and finishes the run", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const finish = (key: string) => {
      const c = store.claim({ owner: "w", capabilities: ["write_workspace", "read_source"], now: clock.now(), leaseSeconds: 90 })!;
      expect(c.stageRun.stage_key).toBe(key);
      const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
      store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "VERIFYING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "VERIFYING", "SUCCEEDED", ev);
      store.releaseLease(c.stageRun.stage_run_id, c.lease.fencing_token);
      return planner.advance(run.run_id);
    };
    expect(finish("produce")).toEqual({ released: ["review"], runState: "RUNNING" });
    expect(finish("review")).toEqual({ released: ["finalize"], runState: "RUNNING" });
    expect(finish("finalize")).toEqual({ released: [], runState: "SUCCEEDED" });
  });
  it("advance marks the run FAILED when a stage is terminally FAILED and WAITING when a stage needs a human", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const c = store.claim({ owner: "w", capabilities: ["write_workspace"], now: clock.now(), leaseSeconds: 90 })!;
    const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "WAITING_HUMAN", ev);
    expect(planner.advance(run.run_id).runState).toBe("WAITING");
    store.transition("stage_run", c.stageRun.stage_run_id, "WAITING_HUMAN", "READY", ev);
    expect(planner.advance(run.run_id).runState).toBe("RUNNING");
    const s = store.getStageRun(c.stageRun.stage_run_id)!;
    store.updateStageRun({ ...s, attempt_count: 3 });
    store.transition("stage_run", s.stage_run_id, "READY", "CLAIMED", ev);
    store.transition("stage_run", s.stage_run_id, "CLAIMED", "FAILED", ev);
    expect(planner.advance(run.run_id).runState).toBe("FAILED");
  });
  it("cancel moves READY/PENDING stages to CANCELLED and the run to CANCELLED", () => {
    const { store, planner, run } = planSample();
    planner.enqueue(run.run_id);
    planner.cancel(run.run_id);
    expect(store.getRun(run.run_id)?.state).toBe("CANCELLED");
    expect(new Set(store.listStageRuns(run.run_id).map((s) => s.state))).toEqual(new Set(["CANCELLED"]));
  });
});
