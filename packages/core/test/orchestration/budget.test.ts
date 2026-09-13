import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, ProductionProfileSchema, type ContentItem, type ContentVariant, type Run, type StageRequest, type StageResult } from "@harness/contracts";
import {
  ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, NullMediaProber, Planner, SourceCatalog, Verifier,
  budgetBlocks, createWorkspace, loadHarnessConfig, loadWorkflow, raiseBudget, sha256String, variantSpent,
} from "../../src/index.js";
import { beginAttempt, openTempStore } from "../helpers.js";

const profile = ProductionProfileSchema.parse({
  schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "sample-three-stage@1.0.0",
  options_schema: {}, options_defaults: {}, verification: { required_checks: ["schema-valid"] },
  limits: { max_cost_usd_per_variant: 0.03 },
});

async function setupVariant() {
  const t = openTempStore();
  const raw = mkdtempSync(join(tmpdir(), "raw-"));
  const file = join(raw, "clip.txt");
  writeFileSync(file, "raw bytes");
  const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
  const { source } = await catalog.ingest({ path: file });
  const content = catalog.createContent({ source_ids: [source.source_id], title: "Ep 1" });
  const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
  const planner = new Planner(t.store);
  const wf = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
  return { ...t, planner, wf, content, variant };
}

function planRun(t: Awaited<ReturnType<typeof setupVariant>>, content: ContentItem, variant: ContentVariant): Run {
  return t.planner.plan({ workflow: t.wf, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content, variant });
}

/** Commits the "produce" stage (the only root of sample-three-stage) with the given cost, through the real Controller. */
async function commitProduce(t: Awaited<ReturnType<typeof setupVariant>>, run: Run, costUsd: number) {
  const claim = t.store.claim({ owner: "w1", capabilities: ["write_workspace"], now: t.clock.now(), leaseSeconds: 90 })!;
  const { stageRun, attempt } = beginAttempt(t.store, claim);
  const ws = await createWorkspace(t.dir, run.run_id, stageRun.stage_key, attempt.attempt_id);
  const registry = new ArtifactRegistry(t.store, t.dir);
  const controller = new Controller({ store: t.store, registry, planner: t.planner, clock: t.clock });
  const content = "produce output";
  writeFileSync(join(ws, "output", "result.txt"), content);
  const checksum = sha256String(content);
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded",
    outputs: [{ path: "output/result.txt", type: "script_text", checksum, size_bytes: content.length }],
    checks: [], usage: { wall_seconds: 1, cost_usd: costUsd }, external_operations: [], errors: [],
  };
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: stageRun.stage_run_id, attempt_id: attempt.attempt_id, project_id: "project-main", portfolio_id: "portfolio-main",
    stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot, inputs: [], workspace_uri: ws, stage_config: {},
    limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: ["write_workspace"], fencing_token: claim.lease.fencing_token,
  };
  const verifier = new Verifier(BUILTIN_CHECKERS);
  const verify = await verifier.verify({ request, result, workspaceDir: ws }, stageRun.required_checks);
  return controller.commit({ stageRun: t.store.getStageRun(stageRun.stage_run_id)!, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" }, stageDefinitionDigest: "sha256:" + "0".repeat(64) });
}

describe("variantSpent / budgetBlocks", () => {
  it("sums total_cost_usd across every run of the variant, including the run itself", async () => {
    const t = await setupVariant();
    const run1 = planRun(t, t.content, t.variant);
    t.planner.enqueue(run1.run_id);
    await commitProduce(t, run1, 0.02);
    const run2 = t.planner.plan({ workflow: t.wf, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content: t.content, variant: t.variant });
    expect(variantSpent(t.store, t.store.getRun(run2.run_id)!)).toBeCloseTo(0.02, 10);
    expect(variantSpent(t.store, t.store.getRun(run1.run_id)!)).toBeCloseTo(0.02, 10);
  });
  it("reports budget: null and blocked: false when the run has no budget_usd", () => {
    const t2 = openTempStore();
    const now = t2.clock.now();
    const run: Run = {
      schema_version: "harness.run/v1", run_id: "run_01J00000000000000000000000", project_id: "p", portfolio_id: "pf",
      workflow_release: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "prof", revision: 1 },
      options: {}, state: "DRAFT", effective_config_snapshot: {}, effective_config_digest: "sha256:" + "a".repeat(64), total_cost_usd: 0.5, created_at: now, updated_at: now,
    };
    t2.store.insertRun(run);
    expect(budgetBlocks(t2.store, t2.store.getRun(run.run_id)!)).toEqual({ blocked: false, spent: 0.5, budget: null });
  });
});

describe("Planner budget gate", () => {
  it("commit over budget parks the run WAITING with run.budget_exceeded; raiseBudget reopens it", async () => {
    const t = await setupVariant();
    const run = planRun(t, t.content, t.variant);
    t.planner.enqueue(run.run_id);
    const out = await commitProduce(t, run, 0.05);
    expect(out.runState).toBe("WAITING");
    expect(t.store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")?.state).toBe("PENDING");
    const exceeded = t.store.listEvents({ run_id: run.run_id }).find((e) => e.event_type === "run.budget_exceeded");
    expect(exceeded).toBeTruthy();
    expect(exceeded?.payload).toMatchObject({ spent: 0.05, budget: 0.03 });

    const raised = raiseBudget(t.store, t.planner, run.run_id, 1);
    expect(raised.budget_usd).toBe(1);
    expect(t.store.getRun(run.run_id)?.state).toBe("RUNNING");
    expect(t.store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")?.state).toBe("READY");
    const raisedEvent = t.store.listEvents({ run_id: run.run_id }).find((e) => e.event_type === "run.budget_raised");
    expect(raisedEvent?.payload).toEqual({ from: 0.03, to: 1, spent: 0.05 });

    try { raiseBudget(t.store, t.planner, run.run_id, 0.04); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
  });

  it("raiseBudget rejects a missing run and a terminal run", async () => {
    const t = await setupVariant();
    try { raiseBudget(t.store, t.planner, "run_01J00000000000000000000000", 1); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "NOT_FOUND")).toBe(true); }
    const run = planRun(t, t.content, t.variant);
    t.planner.enqueue(run.run_id);
    t.planner.cancel(run.run_id);
    expect(t.store.getRun(run.run_id)?.state).toBe("CANCELLED");
    try { raiseBudget(t.store, t.planner, run.run_id, 1); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true); }
  });

  it("a second run of a variant that already exhausted its budget goes READY -> RUNNING -> WAITING at enqueue, no stage READY", async () => {
    const t = await setupVariant();
    const run1 = planRun(t, t.content, t.variant);
    t.planner.enqueue(run1.run_id);
    await commitProduce(t, run1, 0.05);

    const run2 = t.planner.plan({ workflow: t.wf, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content: t.content, variant: t.variant });
    t.planner.enqueue(run2.run_id);
    expect(t.store.getRun(run2.run_id)?.state).toBe("WAITING");
    expect(t.store.listStageRuns(run2.run_id).every((s) => s.state === "PENDING")).toBe(true);
    const events = t.store.listEvents({ run_id: run2.run_id }).map((e) => e.event_type);
    expect(events).toContain("run.started");
    expect(events).toContain("run.budget_exceeded");
  });
});
