import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { StageRequest } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore } from "@harness/core";
import { tsxLoaderUrl } from "@harness/adapter-fake";
import { ScriptExecutor } from "../src/script-executor.js";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
const SDK_URL = pathToFileURL(join(HARNESS_ROOT, "packages", "script-sdk", "src", "index.js")).href;
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "se-ops-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  return dir;
}

describe("ScriptExecutor + @harness/script-sdk ctx.op.* end to end", () => {
  it("a wrapper's intent+confirm through `harness op ...` journals a CONFIRMED external operation", async () => {
    const projectDir = freshProject();
    cli(projectDir, "db", "migrate");
    const { run_id } = JSON.parse(cli(projectDir, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json").out);
    cli(projectDir, "enqueue", run_id);

    const store = new SqliteStateStore(join(projectDir, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    store.close();

    writeFileSync(join(projectDir, "w.mjs"), `
      import { start } from ${JSON.stringify(SDK_URL)};
      const ctx = await start();
      const op = await ctx.op.intent({ provider: "heygen", kind: "render", target: "t", payload: {} });
      await ctx.op.confirm(op.operation_id, { provider_ref: "hg-1", receipt: { ok: true } });
      await ctx.done({ external_operations: [op.operation_id] });
    `);

    const workspaceDir = mkdtempSync(join(tmpdir(), "se-ops-ws-"));
    const request: StageRequest = {
      schema_version: "harness.stage-request/v1", run_id: claim.stageRun.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id,
      project_id: "project-minimal", portfolio_id: "portfolio-minimal", stage_key: claim.stageRun.stage_key,
      workflow: { id: "sample-three-stage", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
      inputs: [], workspace_uri: workspaceDir, stage_config: { __script: "w" },
      limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: claim.lease.fencing_token,
    };
    mkdirSync(workspaceDir, { recursive: true });

    const ex = new ScriptExecutor({ w: { argv: [process.execPath, "w.mjs"], cwd: "." } }, { projectDir, cliArgv: [process.execPath, "--import", tsxLoaderUrl(), MAIN] });
    const res = await ex.execute(request, { workspaceDir, logger: silent, clock: wall });

    expect(res.outcome, JSON.stringify(res)).toBe("succeeded");
    expect(res.external_operations).toHaveLength(1);
    const operationId = res.external_operations[0]!;

    const check = new SqliteStateStore(join(projectDir, "data", "state", "harness.db"));
    expect(check.getExternalOperation(operationId)?.status).toBe("CONFIRMED");
    check.close();
  });
});
