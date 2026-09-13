import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { StageRequestSchema, StageResultSchema, ArtifactManifestSchema, stageOutputSchema } from "../src/execution.js";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "c".repeat(64);

describe("execution contracts", () => {
  it("parses a StageRequest", () => {
    const req = {
      schema_version: "harness.stage-request/v1",
      run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      project_id: "project-main", portfolio_id: "portfolio-main", stage_key: "produce",
      workflow: { id: "sample-three-stage", version: "1.0.0", digest: sha },
      profile_snapshot: { id: "cartoon", revision: 1 },
      inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/script.txt", type: "text/plain", kind: "file" }],
      workspace_uri: "file:///tmp/ws",
      stage_config: { fail_transient_times: 0 },
      options: {},
      source_items: [],
      resources: [],
      expected_outputs: [],
      policy: {},
      limits: { deadline_at: now, max_cost_usd: 5, max_attempts: 3 },
      capabilities: ["write_workspace"],
      fencing_token: 1,
    };
    expect(StageRequestSchema.parse(req)).toEqual(req);
  });
  it("parses a StageResult with defaults", () => {
    const res = StageResultSchema.parse({
      schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "succeeded",
      outputs: [{ path: "output/result.txt", type: "text/plain", checksum: sha, size_bytes: 12 }],
    });
    expect(res.checks).toEqual([]);
    expect(res.usage).toEqual({ wall_seconds: 0, cost_usd: 0 });
    expect(res.external_operations).toEqual([]);
    expect(res.errors).toEqual([]);
  });
  it("rejects outcome outside the enum", () => {
    expect(StageResultSchema.safeParse({ schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "meh", outputs: [] }).success).toBe(false);
  });
  it("parses an ArtifactManifest", () => {
    expect(ArtifactManifestSchema.safeParse({
      schema_version: "harness.artifact-manifest/v1", artifact_id: newId("artifact"), type: "final_video", status: "accepted",
      uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "video/mp4",
      created_by: { run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt") },
      lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "fake@0.1.0", model_parameters_digest: null },
      checks: [],
    }).success).toBe(true);
  });
  it("defaults kind to file and accepts options, source_items and resources on a request", () => {
    const out = stageOutputSchema.parse({ path: "output/cuts", type: "clip_set", checksum: sha, size_bytes: 0 });
    expect(out.kind).toBe("file");
    const req = StageRequestSchema.parse({
      schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      project_id: "p", portfolio_id: "pf", stage_key: "cut", workflow: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "footage", revision: 1 },
      inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/x/edl.json", type: "edl", kind: "file" }], workspace_uri: "file:///ws", stage_config: {},
      options: { voice: "tts" }, source_items: [{ source_id: newId("source_item"), uri: "file:///src.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 5 }], resources: ["cpu"],
      limits: { deadline_at: now, max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
    });
    expect(req.source_items).toHaveLength(1);
    expect(StageRequestSchema.parse({ ...req, options: undefined, source_items: undefined, resources: undefined }).options).toEqual({});
  });
});
