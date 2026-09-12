import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { isHarnessError, newId, type StageRequest } from "@harness/contracts";
import { fakeScriptCommands } from "@harness/adapter-fake";
import { ScriptExecutor } from "../src/script-executor.js";

const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };
function defaultWorkspace(): string {
  const parent = mkdtempSync(join(tmpdir(), "se-"));
  return join(parent, "attempt");
}
function request(stage_config: Record<string, unknown>, ws = defaultWorkspace()): StageRequest {
  mkdirSync(join(ws, "output"), { recursive: true });
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config: { __script: "fake-stage", ...stage_config }, limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
}

describe("ScriptExecutor", () => {
  it("runs the registered script and parses stage-result.json", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = request({ content: "abc" });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome).toBe("succeeded");
    expect(res.attempt_id).toBe(req.attempt_id);
  });
  it("maps a non-zero exit to a transient failure result", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = request({ fail_transient_times: 5 });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]?.kind).toBe("transient");
  });
  it("kills the script at the deadline and reports EXECUTOR_TIMEOUT as transient", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = { ...request({ sleep_ms: 5000 }), limits: { deadline_at: new Date(Date.now() + 500).toISOString(), max_cost_usd: 5, max_attempts: 3 } };
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]).toMatchObject({ kind: "transient", details: { code: "EXECUTOR_TIMEOUT" } });
  });
  it("reports malformed stage-result.json as a contract failure instead of throwing", async () => {
    const ex = new ScriptExecutor({ "bad-json": [process.execPath, "-e", "require('fs').writeFileSync('stage-result.json','{not json')"] });
    const req = request({ __script: "bad-json" });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]).toMatchObject({ kind: "contract", message: "stage-result.json is not valid JSON", details: { code: "SCHEMA_INVALID" } });
  });
  it("throws NOT_FOUND for an unregistered script", async () => {
    const ex = new ScriptExecutor({});
    const req = request({});
    await ex.execute({ ...req }, { workspaceDir: req.workspace_uri, logger: silent, clock: wall }).catch((e) => expect(isHarnessError(e, "NOT_FOUND")).toBe(true));
  });
  it("kills the script on abort and reports a transient failure", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = request({ sleep_ms: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall, signal: ac.signal });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]?.kind).toBe("transient");
  });
  it("removes its abort listener after the script exits", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const ac = new AbortController();
    const req = request({ content: "x" });
    await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall, signal: ac.signal });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});
