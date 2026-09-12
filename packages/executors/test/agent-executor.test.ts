import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest } from "@harness/contracts";
import { FakeAgentRuntime } from "@harness/adapter-fake";
import { AgentExecutor } from "../src/agent-executor.js";
import { ExecutorRegistry } from "../src/registry.js";

const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };
function request(): StageRequest {
  const ws = mkdtempSync(join(tmpdir(), "ae-")); mkdirSync(join(ws, "output"));
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "review", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config: { __skill: "fake-review", __brief: "review it" }, limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
}

describe("AgentExecutor + FakeAgentRuntime", () => {
  it("runs the skill brief through the runtime and writes an output", async () => {
    const ex = new AgentExecutor(new FakeAgentRuntime());
    const req = request();
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome).toBe("succeeded");
    expect(readFileSync(join(req.workspace_uri, res.outputs[0]!.path), "utf8")).toContain("fake-review");
  });
  it("registry resolves by executor ref type", () => {
    const reg = new ExecutorRegistry();
    const agent = new AgentExecutor(new FakeAgentRuntime());
    reg.register("agent", agent);
    expect(reg.resolve({ type: "agent", skill: "x", brief: "" })).toBe(agent);
    expect(() => reg.resolve({ type: "script", script: "x" })).toThrow(/no executor/);
  });
});
