import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHarnessError, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, Controller, Planner, HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, sha256String, createWorkspace, Verifier, BUILTIN_CHECKERS } from "../../src/index.js";
import { beginAttempt, openTempStore, seedStage } from "../helpers.js";

async function setup(retry: { backoff_seconds?: number[]; max_attempts?: number } = {}) {
  const t = openTempStore();
  const planner = new Planner(t.store);
  const wf = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
  const run = planner.plan({ workflow: wf, profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
  planner.enqueue(run.run_id);
  for (const s of t.store.listStageRuns(run.run_id)) t.store.updateStageRun({ ...s, retry: { ...s.retry, ...retry, retry_on: ["transient", "abandoned", "result"] } });
  const claim = t.store.claim({ owner: "w1", capabilities: ["write_workspace"], now: t.clock.now(), leaseSeconds: 90 })!;
  const { stageRun, attempt } = beginAttempt(t.store, claim);
  const ws = await createWorkspace(t.dir, run.run_id, stageRun.stage_key, attempt.attempt_id);
  const registry = new ArtifactRegistry(t.store, t.dir);
  const controller = new Controller({ store: t.store, registry, planner, clock: t.clock });
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: stageRun.stage_run_id, attempt_id: attempt.attempt_id, project_id: "project-main", portfolio_id: "portfolio-main",
    stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot, inputs: [], workspace_uri: ws, stage_config: {},
    limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: ["write_workspace"], fencing_token: claim.lease.fencing_token,
  };
  const write = (content: string, checksum = sha256String(content)): StageResult => {
    writeFileSync(join(ws, "output", "result.txt"), content);
    return { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum, size_bytes: content.length }], checks: [], usage: { wall_seconds: 1, cost_usd: 0.5 }, external_operations: [], errors: [] };
  };
  const verifier = new Verifier(BUILTIN_CHECKERS);
  const commit = async (result: StageResult, token = claim.lease.fencing_token) =>
    controller.commit({ stageRun: t.store.getStageRun(stageRun.stage_run_id)!, attempt, fencingToken: token, result, verify: await verifier.verify({ request, result, workspaceDir: ws }, stageRun.required_checks), workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" } });
  return { ...t, planner, run, stageRun, attempt, claim, ws, write, commit };
}

describe("Controller.commit", () => {
  it("success: ACCEPTED artifact, stage/attempt SUCCEEDED, lease released, cost added, dependants released", async () => {
    const { store, run, stageRun, attempt, write, commit } = await setup();
    const out = await commit(write("hello"));
    expect(out).toMatchObject({ stageState: "SUCCEEDED", attemptState: "SUCCEEDED", runState: "RUNNING", retryScheduled: false });
    expect(out.artifacts[0]?.status).toBe("ACCEPTED");
    expect(store.getLease(stageRun.stage_run_id)).toBeUndefined();
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(0.5);
    expect(store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")?.state).toBe("READY");
    expect(store.listCheckResults(attempt.attempt_id).map((c) => c.verdict)).toEqual(["pass", "pass", "pass"]);
  });
  it("result failure: checksum mismatch rejects the artifact and schedules a retry with backoff", async () => {
    const { store, stageRun, clock, write, commit } = await setup({ backoff_seconds: [30] });
    const out = await commit(write("hello", sha256String("wrong")));
    expect(out).toMatchObject({ failureKind: "result", attemptState: "FAILED", stageState: "READY", retryScheduled: true });
    expect(out.artifacts[0]?.status).toBe("REJECTED");
    const s = store.getStageRun(stageRun.stage_run_id)!;
    expect(s.result_failures).toBe(1);
    expect(Date.parse(s.not_before!) - Date.parse(clock.now())).toBe(30_000);
    expect(store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" })).toHaveLength(0);
  });
  it("transient failure with retries exhausted fails the stage and the run", async () => {
    const { store, run, attempt, commit } = await setup({ max_attempts: 1 });
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: "boom", details: {} }] };
    const out = await commit(result);
    expect(out).toMatchObject({ failureKind: "transient", stageState: "FAILED", runState: "FAILED", retryScheduled: false });
    expect(store.getRun(run.run_id)?.state).toBe("FAILED");
  });
  it("contract failure (attempt_id mismatch) parks the stage for a human and the run WAITING", async () => {
    const { store, run, write, commit } = await setup();
    const out = await commit({ ...write("hello"), attempt_id: "attempt_01J00000000000000000000000" });
    expect(out).toMatchObject({ failureKind: "contract", stageState: "WAITING_HUMAN", runState: "WAITING", retryScheduled: false });
    expect(store.listEvents({ run_id: run.run_id }).some((e) => e.event_type === "stage.waiting_human")).toBe(true);
  });
  it("unknown outcome moves the stage to NEEDS_RECONCILIATION without retry", async () => {
    const { attempt, commit } = await setup();
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "unknown", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "unknown", message: "lost", details: {} }] };
    expect(await commit(result)).toMatchObject({ failureKind: "unknown", stageState: "NEEDS_RECONCILIATION", runState: "WAITING", retryScheduled: false });
  });
  it("commits a cancel-requested stage as CANCELLED, keeps its outputs in the workspace and settles the run", async () => {
    const { store, planner, run, stageRun, attempt, ws, write, commit } = await setup();
    const result = write("hello");
    planner.cancel(run.run_id);
    expect(store.getStageRun(stageRun.stage_run_id)?.state).toBe("CANCEL_REQUESTED");
    expect(store.getRun(run.run_id)?.state).toBe("CANCEL_REQUESTED");
    const out = await commit(result);
    expect(out).toMatchObject({ stageState: "CANCELLED", attemptState: "CANCELLED", runState: "CANCELLED", retryScheduled: false });
    expect(out.failureKind).toBeUndefined();
    expect(out.artifacts).toEqual([]);
    expect(store.listArtifacts({ stage_run_id: stageRun.stage_run_id })).toHaveLength(0);
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(true); // nothing moved into the artifact store
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(0);
    expect(store.getLease(stageRun.stage_run_id)).toBeUndefined();
    expect(store.listCheckResults(attempt.attempt_id).length).toBeGreaterThan(0);
  });
  it("deferred outcome parks the stage for a human without counting a result failure", async () => {
    const { store, stageRun, attempt, commit } = await setup();
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "deferred", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] };
    const out = await commit(result);
    expect(out).toMatchObject({ failureKind: "deferred", stageState: "WAITING_HUMAN", runState: "WAITING", retryScheduled: false });
    expect(out.artifacts).toEqual([]);
    const s = store.getStageRun(stageRun.stage_run_id)!;
    expect(s.result_failures).toBe(0);
    expect(store.getAttempt(attempt.attempt_id)?.failure_kind).toBe("deferred");
    expect(store.listEvents({ run_id: s.run_id }).some((e) => e.event_type === "stage.deferred")).toBe(true);
  });
  it("rejects a stale fencing token and writes nothing", async () => {
    const { store, stageRun, clock, write, commit } = await setup();
    clock.advance(91);
    store.reapExpiredLeases(clock.now());
    await commit(write("hello")).then(() => { throw new Error("no throw"); }, (e) => expect(isHarnessError(e, "FENCING_REJECTED")).toBe(true));
    expect(store.listArtifacts({ stage_run_id: stageRun.stage_run_id })).toHaveLength(0);
    expect(store.getStageRun(stageRun.stage_run_id)?.state).toBe("READY");
  });
});

describe("Controller.commit cost accounting", () => {
  it("accumulates cost from two overlapping commits on sibling stages", async () => {
    const { store, dir, clock } = openTempStore();
    const a = seedStage(store, { key: "a" });
    const b = seedStage(store, { key: "b", runId: a.runId });
    const planner = new Planner(store);
    const registry = new ArtifactRegistry(store, dir);
    const controller = new Controller({ store, registry, planner, clock });
    const verifier = new Verifier(BUILTIN_CHECKERS);
    const prepare = async (stageKey: string) => {
      const claim = store.claim({ owner: `w-${stageKey}`, capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
      const { stageRun, attempt } = beginAttempt(store, claim);
      const ws = await createWorkspace(dir, a.runId, stageRun.stage_key, attempt.attempt_id);
      const content = `out-${stageKey}`;
      writeFileSync(join(ws, "output", "result.txt"), content);
      const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String(content), size_bytes: content.length }], checks: [], usage: { wall_seconds: 1, cost_usd: 0.25 }, external_operations: [], errors: [] };
      const run = store.getRun(a.runId)!;
      const request: StageRequest = { schema_version: "harness.stage-request/v1", run_id: a.runId, stage_run_id: stageRun.stage_run_id, attempt_id: attempt.attempt_id, project_id: "project-main", portfolio_id: "portfolio-main", stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot, inputs: [], workspace_uri: ws, stage_config: {}, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: claim.lease.fencing_token };
      const verify = await verifier.verify({ request, result, workspaceDir: ws }, stageRun.required_checks);
      return () => controller.commit({ stageRun, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" } });
    };
    const [commitA, commitB] = [await prepare("a"), await prepare("b")];
    await Promise.all([commitA(), commitB()]);
    expect(store.getRun(a.runId)?.total_cost_usd).toBeCloseTo(0.5, 10);
    expect(store.listStageRuns(a.runId).map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });
});
