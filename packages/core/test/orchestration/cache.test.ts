import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProductionProfileSchema, WorkflowDefinitionSchema, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, NullMediaProber, Planner, SourceCatalog, Verifier, computeCacheKey, createWorkspace, loadHarnessConfig, sha256String, stageDefinitionDigest } from "../../src/index.js";
import { acceptedInputsFor } from "../../src/artifacts/registry.js";
import { findReusableArtifacts } from "../../src/orchestration/cache.js";
import { beginAttempt, openTempStore } from "../helpers.js";

const wf = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "two", version: "1.0.0", defaults: {}, stages: [
  { key: "produce", executor: { type: "script", script: "fake-stage" }, required_checks: ["schema-valid"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
  { key: "finalize", executor: { type: "script", script: "fake-stage" }, depends_on: ["produce"], required_checks: ["schema-valid"] },
] }), digest: "sha256:" + "f".repeat(64) };
const profile = ProductionProfileSchema.parse({ schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "two@1.0.0", options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" } });
const wf1 = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "one", version: "1.0.0", defaults: {}, stages: [
  { key: "produce", executor: { type: "script", script: "fake-stage" }, required_checks: ["schema-valid"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
] }), digest: "sha256:" + "e".repeat(64) };
const EXECUTOR_VERSION = "fake@0.1.0";
const executorVersionFor = () => EXECUTOR_VERSION;

function world() {
  const t = openTempStore();
  const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
  const content = catalog.createContent({ source_ids: [], title: "c" });
  const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
  const planner = new Planner(t.store);
  const registry = new ArtifactRegistry(t.store, t.dir);
  const controller = new Controller({ store: t.store, registry, planner, clock: t.clock });
  return { ...t, catalog, content, variant, planner, controller, harness: loadHarnessConfig(HARNESS_ROOT) };
}

/** Claim whatever stage is READY, write one output file and commit it SUCCEEDED. */
async function driveOneStage(w: ReturnType<typeof world>, workflow: typeof wf, body: string) {
  const claim = w.store.claim({ owner: "w", capabilities: [], now: w.clock.now(), leaseSeconds: 90 })!;
  const { stageRun, attempt } = beginAttempt(w.store, claim);
  const ws = await createWorkspace(w.dir, stageRun.run_id, stageRun.stage_key, attempt.attempt_id);
  writeFileSync(join(ws, "output", "result.txt"), body);
  const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String(body), size_bytes: Buffer.byteLength(body), kind: "file" }], checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [] };
  const request = { attempt_id: attempt.attempt_id } as StageRequest;
  const verify = await new Verifier(BUILTIN_CHECKERS).verify({ request, result, workspaceDir: ws }, ["schema-valid"]);
  const def = workflow.definition.stages.find((s) => s.key === stageRun.stage_key)!;
  const out = await w.controller.commit({ stageRun, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws, executorVersion: EXECUTOR_VERSION, inputArtifactIds: acceptedInputsFor(w.store, stageRun).map((a) => a.artifact_id), mimeTypes: { script_text: "text/plain" }, stageDefinitionDigest: stageDefinitionDigest(def) });
  return { stageKey: stageRun.stage_key, out };
}

describe("cache", () => {
  it("cache key depends on definition, inputs, options, config and executor version", () => {
    const d = stageDefinitionDigest(wf.definition.stages[0]!);
    const base = { stageDefinitionDigest: d, inputChecksums: [] as string[], optionsDigest: "sha256:" + "1".repeat(64), effectiveConfigDigest: "sha256:" + "2".repeat(64), executorVersion: "fake@0.1.0" };
    const k1 = computeCacheKey(base);
    expect(k1).toMatch(/^sha256:/);
    expect(computeCacheKey({ ...base, inputChecksums: ["sha256:" + "9".repeat(64)] })).not.toBe(k1);
    expect(computeCacheKey({ ...base, executorVersion: "fake@0.2.0" })).not.toBe(k1);
    expect(stageDefinitionDigest({ ...wf.definition.stages[0]!, config: { x: 1 } })).not.toBe(d);
  });

  it("a re-run reuses accepted artifacts of the previous run, then stops at the first stage that cannot be reused", async () => {
    const t = openTempStore();
    const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
    const content = catalog.createContent({ source_ids: [], title: "c" });
    const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    const planner = new Planner(t.store);
    const registry = new ArtifactRegistry(t.store, t.dir);
    const controller = new Controller({ store: t.store, registry, planner, clock: t.clock });
    const harness = loadHarnessConfig(HARNESS_ROOT);
    const run1 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant, executorVersionFor });
    planner.enqueue(run1.run_id);
    // run produce for real
    const claim = t.store.claim({ owner: "w", capabilities: [], now: t.clock.now(), leaseSeconds: 90 })!;
    const { stageRun, attempt } = beginAttempt(t.store, claim);
    const ws = await createWorkspace(t.dir, run1.run_id, "produce", attempt.attempt_id);
    writeFileSync(join(ws, "output", "result.txt"), "hello");
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5, kind: "file" }], checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [] };
    const request = { attempt_id: attempt.attempt_id } as StageRequest;
    const verify = await new Verifier(BUILTIN_CHECKERS).verify({ request: { ...request, attempt_id: attempt.attempt_id }, result, workspaceDir: ws }, ["schema-valid"]);
    const out = await controller.commit({ stageRun, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" }, stageDefinitionDigest: stageDefinitionDigest(wf.definition.stages[0]!) });
    expect(out.stageState).toBe("SUCCEEDED");
    expect(t.store.getStageRun(stageRun.stage_run_id)?.cache_key).toMatch(/^sha256:/);

    // second run of the same variant: produce is reused, finalize is not (no accepted artifact for it yet)
    const run2 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant, executorVersionFor });
    const stages2 = t.store.listStageRuns(run2.run_id);
    expect(stages2.map((s) => [s.stage_key, s.state])).toEqual([["produce", "SUCCEEDED"], ["finalize", "PENDING"]]);
    expect(stages2[0]?.reused_artifact_ids).toEqual(out.artifacts.map((a) => a.artifact_id));
    expect(stages2[0]?.attempt_count).toBe(0);
    expect(t.store.listEvents({ run_id: run2.run_id }).some((e) => e.event_type === "stage.reused")).toBe(true);
    planner.enqueue(run2.run_id);
    expect(t.store.listStageRuns(run2.run_id).map((s) => s.state)).toEqual(["SUCCEEDED", "READY"]);
    expect(acceptedInputsFor(t.store, stages2[1]!).map((a) => a.artifact_id)).toEqual(out.artifacts.map((a) => a.artifact_id));

    // a different options digest never reuses
    const { variant: other } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "tts" } });
    const run3 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant: other, executorVersionFor });
    expect(t.store.listStageRuns(run3.run_id)[0]?.state).toBe("PENDING");
    // reuse: never
    const run4 = planner.plan({ workflow: wf, profile: { ...profile, reuse: "never" }, harness, projectId: "p", portfolioId: "pf", content, variant, executorVersionFor });
    expect(t.store.listStageRuns(run4.run_id)[0]?.state).toBe("PENDING");
    // a new executor version breaks the cache key: no reuse
    const run5 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant, executorVersionFor: () => "fake@0.2.0" });
    expect(t.store.listStageRuns(run5.run_id)[0]?.state).toBe("PENDING");
    // no executorVersionFor at all: reuse is skipped entirely
    const run6 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant });
    expect(t.store.listStageRuns(run6.run_id)[0]?.state).toBe("PENDING");
  });

  it("a chain of reusing runs keeps resolving to the artifacts of the run that produced them", async () => {
    const w = world();
    const plan = () => w.planner.plan({ workflow: wf, profile, harness: w.harness, projectId: "p", portfolioId: "pf", content: w.content, variant: w.variant, executorVersionFor });
    const run1 = plan();
    w.planner.enqueue(run1.run_id);
    const produced = await driveOneStage(w, wf, "hello");
    const finalized = await driveOneStage(w, wf, "final");
    expect([produced.stageKey, finalized.stageKey]).toEqual(["produce", "finalize"]);
    expect(w.store.getRun(run1.run_id)?.state).toBe("SUCCEEDED");
    const ids1 = [produced.out.artifacts[0]!.artifact_id, finalized.out.artifacts[0]!.artifact_id];

    const run2 = plan();
    expect(w.store.listStageRuns(run2.run_id).map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(w.store.listStageRuns(run2.run_id).flatMap((s) => s.reused_artifact_ids ?? [])).toEqual(ids1);
    w.planner.enqueue(run2.run_id);

    // run3 reuses run2's stages, which are themselves pointers: it must land on run1's originals, not on nothing
    const run3 = plan();
    expect(w.store.listStageRuns(run3.run_id).map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(w.store.listStageRuns(run3.run_id).flatMap((s) => s.reused_artifact_ids ?? [])).toEqual(ids1);
    const key = w.store.listStageRuns(run3.run_id)[1]!.cache_key!;
    expect(findReusableArtifacts(w.store, { variantId: w.variant.variant_id, stageKey: "finalize", cacheKey: key, excludeRunId: run3.run_id }).map((a) => a.artifact_id)).toEqual([ids1[1]]);
  });

  it("a run whose every stage was reused settles SUCCEEDED at enqueue without dispatching anything", async () => {
    const w = world();
    const plan = () => w.planner.plan({ workflow: wf1, profile, harness: w.harness, projectId: "p", portfolioId: "pf", content: w.content, variant: w.variant, executorVersionFor });
    const run1 = plan();
    w.planner.enqueue(run1.run_id);
    await driveOneStage(w, wf1, "hello");
    expect(w.store.getRun(run1.run_id)?.state).toBe("SUCCEEDED");

    const run2 = plan();
    expect(w.store.listStageRuns(run2.run_id).map((s) => s.state)).toEqual(["SUCCEEDED"]);
    w.planner.enqueue(run2.run_id);
    expect(w.store.getRun(run2.run_id)?.state).toBe("SUCCEEDED");
    expect(w.planner.advance(run2.run_id).runState).toBe("SUCCEEDED");
    const stage2 = w.store.listStageRuns(run2.run_id)[0]!;
    expect(w.store.listAttempts(stage2.stage_run_id)).toEqual([]);
    expect(w.store.getLease(stage2.stage_run_id)).toBeUndefined();
    const events = w.store.listEvents({ run_id: run2.run_id }).map((e) => e.event_type);
    expect(events).toContain("run.started");
    expect(events).toContain("run.succeeded");
    expect(w.store.claim({ owner: "w2", capabilities: [], now: w.clock.now(), leaseSeconds: 90 })).toBeUndefined();
  });
});
