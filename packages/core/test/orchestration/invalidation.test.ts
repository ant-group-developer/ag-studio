import { describe, expect, it } from "vitest";
import { newId, type Artifact, type Run, type StageRun } from "@harness/contracts";
import { dependantsOf, invalidateDownstream } from "../../src/orchestration/invalidation.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-12T00:00:00.000Z"; const sha = "sha256:" + "a".repeat(64);
const graph = [
  { stage_key: "script", depends_on: [], depends_on_optional: [] },
  { stage_key: "tts", depends_on: ["script"], depends_on_optional: [] },
  { stage_key: "edit-plan", depends_on: ["script"], depends_on_optional: [] },
  { stage_key: "cut", depends_on: ["edit-plan"], depends_on_optional: [] },
  { stage_key: "assemble", depends_on: ["cut"], depends_on_optional: ["tts"] },
  { stage_key: "thumb", depends_on: ["cut", "script"], depends_on_optional: [] },
];

describe("dependantsOf", () => {
  it("returns transitive dependants over required and optional edges", () => {
    expect(dependantsOf(graph, "edit-plan").sort()).toEqual(["assemble", "cut", "thumb"]);
    expect(dependantsOf(graph, "tts")).toEqual(["assemble"]);
    expect(dependantsOf(graph, "thumb")).toEqual([]);
  });
});

describe("invalidateDownstream", () => {
  function seedRun(store: ReturnType<typeof openTempStore>["store"], variantId: string, keys: string[]) {
    const run: Run = { schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf", workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "footage", revision: 1 }, variant_id: variantId, options: {}, state: "SUCCEEDED", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now };
    store.insertRun(run);
    const arts: Record<string, Artifact> = {};
    for (const key of keys) {
      const g = graph.find((x) => x.stage_key === key)!;
      const s: StageRun = { schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: key, executor: { type: "script", script: "x" }, depends_on: g.depends_on, depends_on_optional: g.depends_on_optional, requires_resources: [], required_capabilities: [], required_checks: [], retry: { max_attempts: 1, backoff_seconds: [0], retry_on: [] }, stage_config: {}, state: "SUCCEEDED", attempt_count: 1, result_failures: 0, created_at: now, updated_at: now };
      store.insertStageRun(s);
      const a: Artifact = { schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: run.run_id, stage_run_id: s.stage_run_id, attempt_id: newId("attempt"), type: key, status: "ACCEPTED", uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "footage@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null }, checks: [], created_at: now, updated_at: now };
      store.insertArtifact(a); arts[key] = a;
    }
    return { run, arts };
  }
  it("marks downstream accepted artifacts of earlier runs of the same variant STALE, leaves siblings alone", () => {
    const { store } = openTempStore();
    const variant = newId("content_variant");
    const old = seedRun(store, variant, graph.map((g) => g.stage_key));
    const other = seedRun(store, newId("content_variant"), ["cut"]);
    const current = seedRun(store, variant, graph.map((g) => g.stage_key));
    const { stale } = invalidateDownstream({ store, run: current.run, stageKey: "edit-plan", now });
    expect(stale.sort()).toEqual([old.arts["edit-plan"]!.artifact_id, old.arts.cut!.artifact_id, old.arts.assemble!.artifact_id, old.arts.thumb!.artifact_id].sort());
    expect(store.getArtifact(old.arts.tts!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(old.arts.script!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(other.arts.cut!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(current.arts.cut!.artifact_id)?.status).toBe("ACCEPTED"); // the current run is never invalidated
    expect(store.listEvents({ run_id: old.run.run_id }).filter((e) => e.event_type === "artifact.stale")).toHaveLength(4);
    expect(invalidateDownstream({ store, run: current.run, stageKey: "edit-plan", now }).stale).toEqual([]); // idempotent
  });
  it("does nothing for a run without a variant", () => {
    const { store } = openTempStore();
    const { run } = seedRun(store, newId("content_variant"), ["script"]);
    const noVariant: Run = { ...run, run_id: newId("run"), variant_id: undefined as unknown as string };
    delete (noVariant as { variant_id?: string }).variant_id;
    store.insertRun(noVariant);
    expect(invalidateDownstream({ store, run: noVariant, stageKey: "script", now }).stale).toEqual([]);
  });
});
