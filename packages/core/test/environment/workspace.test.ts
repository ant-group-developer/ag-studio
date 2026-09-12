import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newId, type Artifact } from "@harness/contracts";
import { createWorkspace, materializeInputs, workspacePath } from "../../src/environment/workspace.js";

describe("workspace", () => {
  it("creates the standard layout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const dir = await createWorkspace(root, "run_A", "produce", "attempt_B");
    expect(dir).toBe(workspacePath(root, "run_A", "produce", "attempt_B"));
    for (const sub of ["input", "output", "logs"]) expect(existsSync(join(dir, sub))).toBe(true);
  });
  it("copies accepted artifacts into input/<artifact_id>/", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const src = join(root, "script.txt"); writeFileSync(src, "abc");
    const art: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      type: "script_text", status: "ACCEPTED", uri: pathToFileURL(src).href, checksum: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      size_bytes: 3, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: "2026-09-11T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
    };
    const dir = await createWorkspace(root, "run_A", "verify", "attempt_C");
    const inputs = await materializeInputs(dir, [art]);
    expect(inputs).toEqual([{ artifact_id: art.artifact_id, checksum: art.checksum, path: `input/${art.artifact_id}/script.txt`, type: "script_text", kind: "file" }]);
    expect(readFileSync(join(dir, inputs[0]!.path), "utf8")).toBe("abc");
  });
  it("materialises a directory artifact as a tree under input/<artifact_id>/", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const srcDir = join(root, "cuts"); mkdirSync(srcDir); writeFileSync(join(srcDir, "001.mp4"), "aaa");
    const art: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      type: "clip_set", status: "ACCEPTED", uri: pathToFileURL(srcDir).href, checksum: "sha256:" + "a".repeat(64), size_bytes: 3, mime_type: "application/x-directory",
      lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "footage@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: "2026-09-12T00:00:00.000Z", updated_at: "2026-09-12T00:00:00.000Z",
    };
    const dir = await createWorkspace(root, "run_A", "assemble", "attempt_D");
    const inputs = await materializeInputs(dir, [art]);
    expect(inputs).toEqual([{ artifact_id: art.artifact_id, checksum: art.checksum, path: `input/${art.artifact_id}/cuts`, type: "clip_set", kind: "directory" }]);
    expect(readFileSync(join(dir, inputs[0]!.path, "001.mp4"), "utf8")).toBe("aaa");
  });
});
