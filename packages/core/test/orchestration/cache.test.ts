import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProductionProfileSchema, WorkflowDefinitionSchema, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, NullMediaProber, Planner, SourceCatalog, Verifier, computeCacheKey, createWorkspace, loadHarnessConfig, sha256String, stageDefinitionDigest } from "../../src/index.js";
import { acceptedInputsFor } from "../../src/artifacts/registry.js";
import { beginAttempt, openTempStore } from "../helpers.js";

const wf = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "two", version: "1.0.0", defaults: {}, stages: [
  { key: "produce", executor: { type: "script", script: "fake-stage" }, required_checks: ["schema-valid"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
  { key: "finalize", executor: { type: "script", script: "fake-stage" }, depends_on: ["produce"], required_checks: ["schema-valid"] },
] }), digest: "sha256:" + "f".repeat(64) };
const profile = ProductionProfileSchema.parse({ schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "two@1.0.0", options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" } });

describe("cache", () => {
  it("cache key depends on definition, inputs, options and config", () => {
    const d = stageDefinitionDigest(wf.definition.stages[0]!);
    const k1 = computeCacheKey({ stageDefinitionDigest: d, inputChecksums: [], optionsDigest: "sha256:" + "1".repeat(64), effectiveConfigDigest: "sha256:" + "2".repeat(64) });
    expect(k1).toMatch(/^sha256:/);
    expect(computeCacheKey({ stageDefinitionDigest: d, inputChecksums: ["sha256:" + "9".repeat(64)], optionsDigest: "sha256:" + "1".repeat(64), effectiveConfigDigest: "sha256:" + "2".repeat(64) })).not.toBe(k1);
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
    const run1 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant });
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
    const run2 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant });
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
    const run3 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant: other });
    expect(t.store.listStageRuns(run3.run_id)[0]?.state).toBe("PENDING");
    // reuse: never
    const run4 = planner.plan({ workflow: wf, profile: { ...profile, reuse: "never" }, harness, projectId: "p", portfolioId: "pf", content, variant });
    expect(t.store.listStageRuns(run4.run_id)[0]?.state).toBe("PENDING");
  });
});
