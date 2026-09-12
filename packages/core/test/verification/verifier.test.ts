import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest, type StageResult } from "@harness/contracts";
import { sha256String } from "../../src/artifacts/checksum.js";
import { directoryDigest, listDirectoryFiles } from "../../src/artifacts/directory.js";
import { BUILTIN_CHECKERS, Verifier } from "../../src/verification/verifier.js";

const sha = "sha256:" + "a".repeat(64);
function fixture(content: string, declared: string) {
  const ws = mkdtempSync(join(tmpdir(), "vf-"));
  mkdirSync(join(ws, "output")); writeFileSync(join(ws, "output", "r.txt"), content);
  const attempt_id = newId("attempt");
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id, project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 }, inputs: [],
    workspace_uri: ws, stage_config: {}, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
  const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id, outcome: "succeeded", outputs: [{ path: "output/r.txt", type: "t", checksum: declared, size_bytes: content.length }], checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [] };
  return { ws, request, result };
}

describe("Verifier", () => {
  it("passes all three built-in checks for a good result", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const v = new Verifier(BUILTIN_CHECKERS);
    const out = await v.verify({ request, result, workspaceDir: ws }, ["schema-valid", "output-exists", "checksum-match"]);
    expect(out.allRequiredPassed).toBe(true);
    expect(out.results.map((r) => [r.check_id, r.verdict])).toEqual([["schema-valid", "pass"], ["output-exists", "pass"], ["checksum-match", "pass"]]);
  });
  it("fails checksum-match with evidence and reports missing checkers", async () => {
    const { ws, request, result } = fixture("hello", sha256String("nope"));
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result, workspaceDir: ws }, ["checksum-match", "video-probe"]);
    expect(out.allRequiredPassed).toBe(false);
    expect(out.results.find((r) => r.check_id === "checksum-match")).toMatchObject({ verdict: "fail", evidence: { path: "output/r.txt", declared: sha256String("nope") } });
    expect(out.missing).toEqual(["video-probe"]);
  });
  it("fails output-exists when the file is absent", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const bad = { ...result, outputs: [{ ...result.outputs[0]!, path: "output/missing.txt" }] };
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: bad, workspaceDir: ws }, ["output-exists"]);
    expect(out.results[0]).toMatchObject({ check_id: "output-exists", verdict: "fail" });
  });
  it("fails schema-valid for a result with an attempt_id mismatch", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: { ...result, attempt_id: newId("attempt") }, workspaceDir: ws }, ["schema-valid"]);
    expect(out.results[0]).toMatchObject({ check_id: "schema-valid", verdict: "fail" });
  });
  it("output-exists and checksum-match handle directory outputs", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    mkdirSync(join(ws, "output", "set")); writeFileSync(join(ws, "output", "set", "a.txt"), "A");
    const entries = await listDirectoryFiles(join(ws, "output", "set"));
    const { checksum, size_bytes } = directoryDigest(entries);
    const withDir = { ...result, outputs: [...result.outputs, { path: "output/set", type: "image_set", checksum, size_bytes, kind: "directory" as const }] };
    const ok = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: withDir, workspaceDir: ws }, ["output-exists", "checksum-match"]);
    expect(ok.allRequiredPassed).toBe(true);
    writeFileSync(join(ws, "output", "set", "a.txt"), "B");
    const bad = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: withDir, workspaceDir: ws }, ["checksum-match"]);
    expect(bad.results[0]).toMatchObject({ verdict: "fail", evidence: { path: "output/set" } });
  });
});
