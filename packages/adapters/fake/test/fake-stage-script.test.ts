import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, StageResultSchema, type StageRequest } from "@harness/contracts";
import { fakeScriptCommands } from "../src/index.js";

function run(stage_config: Record<string, unknown>, ws = mkdtempSync(join(tmpdir(), "fs-"))) {
  const attempt_id = newId("attempt");
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id, project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
  mkdirSync(join(ws, "output"), { recursive: true });
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(request));
  const { argv } = fakeScriptCommands()["fake-stage"]!;
  const proc = spawnSync(argv[0]!, argv.slice(1), { cwd: ws, encoding: "utf8" });
  return { ws, proc, attempt_id };
}

describe("fake-stage-script", () => {
  it("writes an output and a valid stage-result.json", () => {
    const { ws, proc, attempt_id } = run({ content: "hello" });
    expect(proc.status, proc.stderr).toBe(0);
    const result = StageResultSchema.parse(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8")));
    expect(result.attempt_id).toBe(attempt_id);
    expect(result.outcome).toBe("succeeded");
    expect(readFileSync(join(ws, result.outputs[0]!.path), "utf8")).toBe("hello");
  });
  it("fails transiently N times using a counter next to the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "fs-"));
    const ws1 = join(parent, "attempt-1"); mkdirSync(ws1);
    const ws2 = join(parent, "attempt-2"); mkdirSync(ws2);
    const a = run({ fail_transient_times: 1 }, ws1);
    expect(a.proc.status).toBe(1);
    expect(existsSync(join(ws1, "stage-result.json"))).toBe(false);
    const b = run({ fail_transient_times: 1 }, ws2);
    expect(b.proc.status).toBe(0);
  });
  it("can declare a wrong checksum on purpose", () => {
    const { ws, proc } = run({ write_bad_checksum: true });
    expect(proc.status).toBe(0);
    const result = JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"));
    expect(result.outputs[0].checksum).toBe("sha256:" + "0".repeat(64));
  });
  it("resolves tsx as an absolute file URL so the command works from any cwd", () => {
    const { argv } = fakeScriptCommands()["fake-stage"]!;
    expect(argv[1]).toBe("--import");
    expect(argv[2]).toMatch(/^file:\/\/\/.*tsx.*\.mjs$/);
  });
});
