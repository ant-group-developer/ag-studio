import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isHarnessError, WorkflowDefinitionSchema, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, Planner, Verifier, createWorkspace, gateOverdue, loadHarnessConfig, loadProfile, mimeTypesFor, sha256String, stageDefinitionDigest, submitGate, type GateDeps } from "../../src/index.js";
import { beginAttempt, openTempStore } from "../helpers.js";

const DRAFT = { key: "draft", executor: { type: "script" as const, script: "fake-stage" }, required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "script_text", mime_type: "text/plain" }], config: { content: "draft script" } };
const PICK = { key: "pick", executor: { type: "gate" as const }, depends_on: ["draft"], gate_deadline_seconds: 60, required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "topic", mime_type: "text/markdown", name: "topic.md" }] };
const wf = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "pick-topic", version: "1.0.0", defaults: {}, stages: [DRAFT, PICK] }), digest: "sha256:" + "c".repeat(64) };

/** Plans+enqueues the two-stage workflow, drives `draft` to SUCCEEDED via `Controller.commit` (as in controller.test.ts),
 * then simulates the worker's gate dispatch: claim `pick`, create its workspace, and commit a `deferred` result — the
 * same shape `Controller.commit` sees from a real `GateExecutor` run, without core importing the executors package. */
async function setup() {
  const { store, dir, clock } = openTempStore();
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dir);
  const controller = new Controller({ store, registry, planner, clock });
  const verifier = new Verifier(BUILTIN_CHECKERS);
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const profile = loadProfile(HARNESS_ROOT, "cartoon");

  const run = planner.plan({ workflow: wf, profile, harness, projectId: "project-main", portfolioId: "portfolio-main" });
  planner.enqueue(run.run_id);

  const claimDraft = store.claim({ owner: "w1", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
  const { stageRun: draftStage, attempt: draftAttempt } = beginAttempt(store, claimDraft);
  const wsDraft = await createWorkspace(dir, run.run_id, "draft", draftAttempt.attempt_id);
  writeFileSync(join(wsDraft, "output", "script.txt"), "hello");
  const draftRequest: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: draftStage.stage_run_id, attempt_id: draftAttempt.attempt_id,
    project_id: "project-main", portfolio_id: "portfolio-main", stage_key: "draft", workflow: run.workflow_release, profile_snapshot: run.profile_snapshot,
    inputs: [], workspace_uri: wsDraft, stage_config: {}, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [], fencing_token: claimDraft.lease.fencing_token,
  };
  const draftResult: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: draftAttempt.attempt_id, outcome: "succeeded",
    outputs: [{ path: "output/script.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }],
    checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  const draftVerify = await verifier.verify({ request: draftRequest, result: draftResult, workspaceDir: wsDraft }, draftStage.required_checks);
  await controller.commit({ stageRun: draftStage, attempt: draftAttempt, fencingToken: claimDraft.lease.fencing_token, result: draftResult, verify: draftVerify, workspaceDir: wsDraft, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" }, stageDefinitionDigest: stageDefinitionDigest(wf.definition.stages[0]!) });
  const [artDraft] = store.listArtifacts({ stage_run_id: draftStage.stage_run_id, status: "ACCEPTED" });

  const claimPick = store.claim({ owner: "gate-worker", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
  const { stageRun: pickStage, attempt: pickAttempt } = beginAttempt(store, claimPick);
  const ws = await createWorkspace(dir, run.run_id, "pick", pickAttempt.attempt_id);
  store.updateAttempt({ ...store.getAttempt(pickAttempt.attempt_id)!, workspace_uri: pathToFileURL(ws).href });
  const deferredResult: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: pickAttempt.attempt_id, outcome: "deferred", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] };
  const pickDef = wf.definition.stages.find((s) => s.key === "pick")!;
  await controller.commit({ stageRun: pickStage, attempt: pickAttempt, fencingToken: claimPick.lease.fencing_token, result: deferredResult, verify: { results: [], allRequiredPassed: false, missing: [] }, workspaceDir: ws, executorVersion: "gate-executor@0.1.0", inputArtifactIds: [artDraft!.artifact_id], mimeTypes: mimeTypesFor(pickDef), stageDefinitionDigest: stageDefinitionDigest(pickDef) });

  const pick = store.getStageRun(pickStage.stage_run_id)!;
  const deps: GateDeps = { store, planner, controller, verifier, clock, harness, profiles: () => profile, workflows: () => wf };
  clock.advance(1); // events appended from here compare newest by occurred_at, not by same-millisecond ULID tie-break
  return { store, dir, clock, planner, controller, run, pick, ws, deps };
}

describe("submitGate", () => {
  it("rejects a submit with missing outputs without touching state, then commits when the file is there", async () => {
    const { store, run, pick, ws, deps } = await setup();
    const rejected = await submitGate(deps, { stageRunId: pick.stage_run_id });
    expect(rejected.missing).toEqual(["output/topic.md"]);
    expect(store.getStageRun(pick.stage_run_id)?.state).toBe("WAITING_HUMAN");
    expect(store.listAttempts(pick.stage_run_id)).toHaveLength(1);
    // listEvents({ newest: true }) returns the N most recent rows in chronological order (see sqlite-store.test.ts),
    // so the newest event is the last element, not the first.
    expect(store.listEvents({ run_id: run.run_id, limit: 5, newest: true }).at(-1)?.event_type).toBe("stage.submit_rejected");
    writeFileSync(join(ws, "output", "topic.md"), "# Topic\n");
    const ok = await submitGate(deps, { stageRunId: pick.stage_run_id });
    expect(ok).toMatchObject({ stageState: "SUCCEEDED", runState: "SUCCEEDED", missing: [], failed: [] });
    const attempts = store.listAttempts(pick.stage_run_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ lease_owner: "cli-submit", state: "SUCCEEDED", fencing_token: 2 });
    const [art] = store.listArtifacts({ stage_run_id: pick.stage_run_id, status: "ACCEPTED" });
    expect(art).toMatchObject({ type: "topic", mime_type: "text/markdown" });
    expect(art?.lineage.input_artifacts).toHaveLength(1);
    expect(store.getLease(pick.stage_run_id)).toBeUndefined();
  });

  it("copies --from into output/ and refuses a non-gate or non-waiting stage", async () => {
    const { store, run, pick, deps } = await setup();
    const fromDir = mkdtempSync(join(tmpdir(), "gate-from-"));
    writeFileSync(join(fromDir, "topic.md"), "# From dir\n");
    const ok = await submitGate(deps, { stageRunId: pick.stage_run_id, fromDir });
    expect(ok).toMatchObject({ stageState: "SUCCEEDED", runState: "SUCCEEDED", missing: [], failed: [] });

    await submitGate(deps, { stageRunId: pick.stage_run_id }).then(
      () => { throw new Error("expected submitGate to reject a stage that is no longer WAITING_HUMAN"); },
      (e) => expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true),
    );

    const draft = store.listStageRuns(run.run_id).find((s) => s.stage_key === "draft")!;
    await submitGate(deps, { stageRunId: draft.stage_run_id }).then(
      () => { throw new Error("expected submitGate to reject a non-gate stage"); },
      (e) => expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true),
    );
  });

  it("commits a synthetic failure and releases the lease when the post-claim path throws (e.g. a swept input artifact)", async () => {
    const { store, run, pick, ws, deps } = await setup();
    writeFileSync(join(ws, "output", "topic.md"), "# Topic\n");

    // Simulate an accepted input artifact going STALE between the pre-verify pass (rule 5) and the
    // post-claim materialize (rule 6): point the upstream `draft` stage at a `reused_artifact_ids` entry
    // for its own artifact, then make the *second* read of that artifact (the post-claim `acceptedInputsFor`
    // call) report it STALE while the first (pre-verify) read still sees it ACCEPTED — exactly the race the
    // review flagged, without needing real concurrency.
    const draft = store.listStageRuns(run.run_id).find((s) => s.stage_key === "draft")!;
    const [artDraft] = store.listArtifacts({ stage_run_id: draft.stage_run_id, status: "ACCEPTED" });
    store.updateStageRun({ ...draft, reused_artifact_ids: [artDraft!.artifact_id] });
    const realGetArtifact = store.getArtifact.bind(store);
    let reads = 0;
    store.getArtifact = (id: string) => {
      if (id !== artDraft!.artifact_id) return realGetArtifact(id);
      reads++;
      const a = realGetArtifact(id);
      return reads > 1 && a ? { ...a, status: "STALE" as const } : a;
    };

    const report = await submitGate(deps, { stageRunId: pick.stage_run_id });

    expect(report.failed.length).toBeGreaterThan(0);
    expect(report.missing).toEqual([]);
    expect(report.artifacts).toEqual([]);
    expect(store.getLease(pick.stage_run_id)).toBeUndefined();
    const attempts = store.listAttempts(pick.stage_run_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ lease_owner: "cli-submit", state: "FAILED", failure_kind: "contract" });
    expect(store.getStageRun(pick.stage_run_id)?.state).toBe("WAITING_HUMAN");
    expect(report.stageState).toBe("WAITING_HUMAN");
  });

  it("gateOverdue emits stage.gate_overdue once per window after gate_deadline_seconds", async () => {
    const { store, clock, run, pick } = await setup();
    expect(gateOverdue(store, clock.now(), 600)).toEqual([]);
    clock.advance(29); // 30s elapsed since pick parked WAITING_HUMAN (setup() already advances the clock 1s)
    expect(gateOverdue(store, clock.now(), 600)).toEqual([]);
    clock.advance(31); // 61s elapsed, past the 60s gate_deadline_seconds
    const first = gateOverdue(store, clock.now(), 600);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ overdue_seconds: 1 });
    expect(first[0]!.stage.stage_run_id).toBe(pick.stage_run_id);
    expect(store.listEvents({ run_id: run.run_id }).filter((e) => e.event_type === "stage.gate_overdue")).toHaveLength(1);
    expect(gateOverdue(store, clock.now(), 600)).toEqual([]); // same window: deduped
    clock.advance(600);
    expect(gateOverdue(store, clock.now(), 600)).toHaveLength(1);
    expect(store.listEvents({ run_id: run.run_id }).filter((e) => e.event_type === "stage.gate_overdue")).toHaveLength(2);
  });
});
