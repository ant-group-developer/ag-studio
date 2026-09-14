import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPackageDraftSchema, newId, type ExecutorContext, type StageRequest } from "@harness/contracts";
import { CliAgentRuntime } from "../src/cli-agent-runtime.js";

const skillsDir = fileURLToPath(new URL("../../../../skills", import.meta.url));
const fixture = fileURLToPath(new URL("../../../../fixtures/fake-agent-cli.mjs", import.meta.url));
const skillMd = readFileSync(join(skillsDir, "channel-package", "SKILL.md"), "utf8");

const silent = { info() {}, warn() {}, error() {} };
const wallClock = { now: () => new Date().toISOString() };
const ctx: ExecutorContext = { workspaceDir: "", logger: silent, clock: wallClock };

function makeWorkspace(deadlineMs = 60_000): { ws: string; req: StageRequest } {
  const ws = mkdtempSync(join(tmpdir(), "agent-cli-"));
  mkdirSync(join(ws, "inputs", "thumbnails"), { recursive: true });
  writeFileSync(join(ws, "inputs", "thumbnails", "thumb-01.png"), "not-really-a-png");
  const req: StageRequest = {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "p", portfolio_id: "pf", stage_key: "channel-package",
    workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) },
    profile_snapshot: { id: "channel", revision: 1 },
    inputs: [{ artifact_id: newId("artifact"), checksum: "sha256:" + "b".repeat(64), path: "inputs/thumbnails", type: "thumbnail_set", kind: "directory" }],
    workspace_uri: ws,
    stage_config: {},
    expected_outputs: [{ type: "channel_package_draft", mime_type: "application/json", kind: "file", name: "package.json" }],
    limits: { deadline_at: new Date(Date.now() + deadlineMs).toISOString(), max_cost_usd: 5, max_attempts: 3 },
    capabilities: [], fencing_token: 1,
  };
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(req, null, 2));
  return { ws, req };
}

describe("CliAgentRuntime", () => {
  afterEach(() => { delete process.env.FAKE_AGENT_MODE; delete process.env.HARNESS_SECRET_X_Y; });

  it("ok: succeeds, output checksum matches sha256File, cost read from the last stdout line, prompt has skill + brief", async () => {
    process.env.FAKE_AGENT_MODE = "ok";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "title_hint: Test Episode Title", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });

    expect(res.outcome).toBe("succeeded");
    expect(res.outputs).toHaveLength(1);
    const out = res.outputs[0]!;
    expect(out.path).toBe("output/package.json");
    expect(out.kind).toBe("file");
    const bytes = readFileSync(join(ws, out.path));
    expect(out.checksum).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
    expect(out.size_bytes).toBe(bytes.length);
    expect(res.usage.cost_usd).toBe(0.01);

    const prompt = readFileSync(join(ws, "agent-prompt.md"), "utf8");
    expect(prompt).toContain(skillMd);
    expect(prompt).toContain("title_hint: Test Episode Title");
  });

  it("no-output: fails with kind contract when the named output is missing", async () => {
    process.env.FAKE_AGENT_MODE = "no-output";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("contract");
    expect(res.errors[0]!.message).toContain("output/package.json");
  });

  it("crash: fails with kind transient and EXECUTOR_FAILED", async () => {
    process.env.FAKE_AGENT_MODE = "crash";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("transient");
    expect(res.errors[0]!.details.code).toBe("EXECUTOR_FAILED");
  });

  it("env-dump: never leaks a HARNESS_SECRET_* key or value into the stdout log", async () => {
    process.env.FAKE_AGENT_MODE = "env-dump";
    process.env.HARNESS_SECRET_X_Y = "s3cret";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("succeeded");
    const log = readFileSync(join(ws, "logs", "agent-stdout.log"), "utf8");
    expect(log).not.toContain("HARNESS_SECRET_X_Y");
    expect(log).not.toContain("s3cret");
  });

  it("unknown skill: fails with kind contract", async () => {
    process.env.FAKE_AGENT_MODE = "ok";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "does-not-exist", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("contract");
  });

  it("hang: killed at its deadline, fails with kind transient and EXECUTOR_TIMEOUT", async () => {
    process.env.FAKE_AGENT_MODE = "hang";
    const { ws, req } = makeWorkspace(1000);
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("transient");
    expect(res.errors[0]!.details.code).toBe("EXECUTOR_TIMEOUT");
  }, 15_000);

  it("isAvailable: true for a real binary answering --version, false for a missing one", () => {
    expect(CliAgentRuntime.isAvailable("claude", process.execPath)).toBe(true);
    expect(CliAgentRuntime.isAvailable("claude", "definitely-missing-bin")).toBe(false);
  });
});

// Exercises the real `claude` CLI end to end: skipped wherever the binary is not on PATH (most dev/CI
// machines). Costs real API usage — do not loop or retry this test; if it flakes on network/auth, convert
// it to `it.skip` with a comment rather than leaving a flaky assertion in the suite.
describe.skipIf(!CliAgentRuntime.isAvailable("claude"))("CliAgentRuntime against the real claude CLI", () => {
  it("writes a schema-valid output/package.json from the channel-package skill", async () => {
    const { ws, req } = makeWorkspace(300_000);
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir });
    const res = await runtime.runTask({
      skill: "channel-package",
      brief: "Đây là một tập demo cho kênh thử nghiệm nội bộ. Ghi output/package.json theo đúng skill. "
        + "Không cần tìm web thật nếu không có mạng — dùng basis kind manual với ghi chú rõ ràng.",
      request: req, workspaceDir: ws,
    }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("succeeded");
    const draft = JSON.parse(readFileSync(join(ws, "output", "package.json"), "utf8"));
    expect(ChannelPackageDraftSchema.safeParse(draft).success).toBe(true);
  }, 300_000);
});
