import { describe, expect, it } from "vitest";
import { isHarnessError, ProductionProfileSchema, WorkflowDefinitionSchema } from "@harness/contracts";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow } from "../../src/orchestration/registry.js";
import { Planner } from "../../src/orchestration/planner.js";
import { canonicalDigest } from "../../src/artifacts/checksum.js";
import { NullMediaProber, SourceCatalog } from "../../src/index.js";
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
  it("cancel settles stages parked on a human or on reconciliation without throwing", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const c = store.claim({ owner: "w", capabilities: ["write_workspace", "read_source"], now: clock.now(), leaseSeconds: 90 })!;
    const ev = (stageRunId: string) => ({ run_id: run.run_id, stage_run_id: stageRunId, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} });
    const produce = c.stageRun.stage_run_id;
    store.transition("stage_run", produce, "CLAIMED", "RUNNING", ev(produce));
    store.transition("stage_run", produce, "RUNNING", "WAITING_EXTERNAL", ev(produce));
    store.transition("stage_run", produce, "WAITING_EXTERNAL", "NEEDS_RECONCILIATION", ev(produce));
    const review = store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")!.stage_run_id;
    for (const [from, to] of [["PENDING", "READY"], ["READY", "CLAIMED"], ["CLAIMED", "RUNNING"], ["RUNNING", "WAITING_HUMAN"]]) store.transition("stage_run", review, from!, to!, ev(review));
    expect(() => planner.cancel(run.run_id)).not.toThrow();
    expect(store.listStageRuns(run.run_id).map((s) => s.state)).toEqual(["CANCELLED", "CANCELLED", "CANCELLED"]);
    expect(store.getRun(run.run_id)?.state).toBe("CANCELLED");
  });
  it("cancel parks a stage a worker still holds and advance settles the run once it lets go", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const c = store.claim({ owner: "w", capabilities: ["write_workspace", "read_source"], now: clock.now(), leaseSeconds: 90 })!;
    const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    planner.cancel(run.run_id);
    expect(store.getStageRun(c.stageRun.stage_run_id)?.state).toBe("CANCEL_REQUESTED");
    expect(store.getRun(run.run_id)?.state).toBe("CANCEL_REQUESTED");
    expect(planner.advance(run.run_id).runState).toBe("CANCEL_REQUESTED"); // the worker still holds it
    store.transition("stage_run", c.stageRun.stage_run_id, "CANCEL_REQUESTED", "CANCELLED", ev);
    expect(planner.advance(run.run_id).runState).toBe("CANCELLED");
    expect(store.listEvents({ run_id: run.run_id }).some((e) => e.event_type === "run.cancelled")).toBe(true);
  });
  it("cancel moves READY/PENDING stages to CANCELLED and the run to CANCELLED", () => {
    const { store, planner, run } = planSample();
    planner.enqueue(run.run_id);
    planner.cancel(run.run_id);
    expect(store.getRun(run.run_id)?.state).toBe("CANCELLED");
    expect(new Set(store.listStageRuns(run.run_id).map((s) => s.state))).toEqual(new Set(["CANCELLED"]));
  });
});

const optWorkflow = { definition: WorkflowDefinitionSchema.parse({
  schema_version: "harness.workflow/v1", id: "opt", version: "1.0.0", defaults: {},
  stages: [
    { key: "script", executor: { type: "script", script: "fake-stage" } },
    { key: "tts", executor: { type: "script", script: "fake-stage" }, depends_on: ["script"], when: 'options.voice == "tts"', requires_resources: ["gpu"] },
    { key: "cut", executor: { type: "script", script: "fake-stage" }, depends_on: ["script"] },
    { key: "assemble", executor: { type: "script", script: "fake-stage" }, depends_on: ["cut"], depends_on_optional: ["tts"] },
    { key: "thumb", executor: { type: "script", script: "fake-stage" }, depends_on: ["tts"] },
  ],
}), digest: "sha256:" + "e".repeat(64) };
const optProfile = ProductionProfileSchema.parse({
  schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "opt@1.0.0",
  options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" }, verification: { required_checks_by_stage: { assemble: ["media-probe"] } },
});

describe("Planner with options", () => {
  function setup(options: Record<string, unknown>) {
    const t = openTempStore();
    const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
    const content = catalog.createContent({ source_ids: [], title: "c" });
    const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile: optProfile, options });
    const planner = new Planner(t.store);
    const run = planner.plan({ workflow: optWorkflow, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf", content, variant });
    return { ...t, planner, run, variant };
  }
  it("drops stages whose when is false and rewires dependants through them", () => {
    const { store, run } = setup({ voice: "none" });
    const stages = store.listStageRuns(run.run_id);
    expect(stages.map((s) => s.stage_key)).toEqual(["script", "cut", "assemble", "thumb"]);
    const byKey = Object.fromEntries(stages.map((s) => [s.stage_key, s]));
    expect(byKey.assemble!.depends_on).toEqual(["cut"]);
    expect(byKey.assemble!.depends_on_optional).toEqual([]);
    expect(byKey.thumb!.depends_on).toEqual(["script"]); // tts skipped -> inherits tts's dependencies
    expect(byKey.assemble!.required_checks).toContain("media-probe");
    expect(store.listEvents({ run_id: run.run_id })[0]?.payload.skipped_stages).toEqual(["tts"]);
  });
  it("keeps optional dependencies when the stage exists and gates release on them", () => {
    const { store, planner, run, clock, variant } = setup({ voice: "tts" });
    expect(run.variant_id).toBe(variant.variant_id);
    expect(run.content_id).toBe(variant.content_id);
    const byKey = Object.fromEntries(store.listStageRuns(run.run_id).map((s) => [s.stage_key, s]));
    expect(byKey.assemble!.depends_on_optional).toEqual(["tts"]);
    expect(byKey.tts!.requires_resources).toEqual(["gpu"]);
    planner.enqueue(run.run_id);
    const finish = (key: string, caps: string[] = []) => {
      const c = store.claim({ owner: "w", capabilities: caps, now: clock.now(), leaseSeconds: 90, resourceCapacity: { gpu: 1 } })!;
      expect(c.stageRun.stage_key).toBe(key);
      const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
      store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "VERIFYING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "VERIFYING", "SUCCEEDED", ev);
      store.releaseLease(c.stageRun.stage_run_id, c.lease.fencing_token);
      return planner.advance(run.run_id).released;
    };
    expect(finish("script").sort()).toEqual(["cut", "tts"]);
    expect(finish("tts")).toEqual(["thumb"]);           // assemble still waits for cut
    expect(finish("cut")).toEqual(["assemble"]);        // both cut and optional tts are done
  });
  it("rejects a when key that the profile does not declare", () => {
    const t = openTempStore();
    const badWf = { ...optWorkflow, definition: WorkflowDefinitionSchema.parse({ ...optWorkflow.definition, stages: [{ key: "a", executor: { type: "script", script: "x" }, when: 'options.colour == "red"' }] }) };
    try { new Planner(t.store).plan({ workflow: badWf, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    expect(t.store.listRuns()).toHaveLength(0);
  });
  it("still plans without content/variant (options default to the profile defaults)", () => {
    const t = openTempStore();
    const run = new Planner(t.store).plan({ workflow: optWorkflow, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" });
    expect(t.store.listStageRuns(run.run_id).map((s) => s.stage_key)).toEqual(["script", "cut", "assemble", "thumb"]);
    expect(run.variant_id).toBeUndefined();
  });
});
