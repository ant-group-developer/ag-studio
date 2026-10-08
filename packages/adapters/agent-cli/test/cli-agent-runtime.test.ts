import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPackageDraftSchema, newId, type ExecutorContext, type StageRequest } from "@harness/contracts";
import { agentChildEnv, CliAgentRuntime, studioFilesArgv } from "../src/cli-agent-runtime.js";

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

  it("rate-limit: fails transient with code RATE_LIMITED, not EXECUTOR_FAILED", async () => {
    process.env.FAKE_AGENT_MODE = "rate-limit";
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: [process.execPath, fixture, "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("transient");
    expect(res.errors[0]!.details.code).toBe("RATE_LIMITED");
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

  it("missing binary: spawn ENOENT fails contract (spec 4.3: the CLI is not installed) instead of crashing the process", async () => {
    const { ws, req } = makeWorkspace();
    const runtime = new CliAgentRuntime({ runtime: "claude", skillsDir, argv: ["definitely-missing-binary-xyz", "{prompt}"] });
    const res = await runtime.runTask({ skill: "channel-package", brief: "b", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]!.kind).toBe("contract");
  });
});

describe("agentChildEnv", () => {
  it("keeps only the allow-listed keys and always drops HARNESS_SECRET_*, even when explicitly passed through", () => {
    const env = agentChildEnv(
      { HARNESS_SECRET_X_Y: "s3cret", FAKE_AGENT_MODE: "ok", PATH: "/bin", SOME_OTHER: "nope" },
      ["HARNESS_SECRET_X_Y", "FAKE_AGENT_MODE"],
      "/workspace",
    );
    expect(env.PATH).toBe("/bin");
    expect(env.FAKE_AGENT_MODE).toBe("ok");
    expect(env.HARNESS_WORKSPACE).toBe("/workspace");
    expect(env).not.toHaveProperty("HARNESS_SECRET_X_Y");
    expect(env).not.toHaveProperty("SOME_OTHER");
  });

  it("matches allow-listed base-env keys case-insensitively but emits the canonical name", () => {
    const env = agentChildEnv({ Path: "C:\\Windows", Temp: "C:\\Temp" }, [], "/workspace");
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env).not.toHaveProperty("Path");
    expect(env).not.toHaveProperty("Temp");
  });

  it("regression: a differently-cased HARNESS_SECRET_* passthrough entry is still stripped, not leaked under a lowercase key", () => {
    const env = agentChildEnv(
      { HARNESS_SECRET_X_Y: "s3cret", FAKE_AGENT_MODE: "ok" },
      ["harness_secret_x_y", "Fake_Agent_Mode"],
      "/workspace",
    );
    // the mode value passes through fine (not a secret) — only its exact key casing depends on the
    // passthrough entry's own spelling, which is not what this regression is about
    expect(Object.values(env)).toContain("ok");
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith("HARNESS_SECRET_"))).toBe(false);
    expect(Object.values(env)).not.toContain("s3cret");
  });
});

// Exercises the real `claude` CLI end to end. Opt-in only (HARNESS_REAL_CLAUDE_TEST=1): tests must not call
// an LLM by default, and since `claude` now resolves through its npm .cmd shim on Windows, "installed" alone
// would run it on every dev machine, logged in or not. Costs real usage — do not loop or retry this test; if
// it flakes on network/auth, convert it to `it.skip` with a comment rather than leaving a flaky assertion.
describe.skipIf(process.env.HARNESS_REAL_CLAUDE_TEST !== "1" || !CliAgentRuntime.isAvailable("claude"))("CliAgentRuntime against the real claude CLI", () => {
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

describe("CliAgentRuntime files mode (Studio stages that look at pictures, phase 5)", () => {
  /** A fake `claude`: records its argv and stdin, writes output/survey.json in its cwd, answers with a session id. */
  function fakeCli(): string {
    const dir = mkdtempSync(join(tmpdir(), "fake-files-cli-"));
    const path = join(dir, "fake.mjs");
    writeFileSync(path, [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "let stdin = ''; process.stdin.on('data', (d) => { stdin += d; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
      "  writeFileSync('stdin.txt', stdin);",
      "  mkdirSync('output', { recursive: true });",
      "  writeFileSync('output/survey.json', JSON.stringify({ ok: true }));",
      "  const resume = process.argv.indexOf('--resume');",
      "  console.log(JSON.stringify({ type: 'result', session_id: resume > 0 ? process.argv[resume + 1] + '-next' : 'sess-1', total_cost_usd: 0.25 }));",
      "});",
    ].join("\n"));
    return path;
  }

  function surveyWorkspace(): { ws: string; req: StageRequest } {
    const { ws, req } = makeWorkspace();
    return { ws, req: { ...req, stage_key: "source-survey", expected_outputs: [{ type: "survey_index", mime_type: "application/json", kind: "file", name: "survey.json" }] } };
  }

  it("default argv: file tools only, edits allowed, the session kept (no --no-session-persistence)", () => {
    const argv = studioFilesArgv({ model: "claude-sonnet-5-5", maxTurns: 40, tools: ["Read", "Write", "Glob"] });
    expect(argv).toEqual(["claude", "-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Glob",
      "--strict-mcp-config", "--max-turns", "40", "--model", "claude-sonnet-5-5"]);
    expect(studioFilesArgv({ model: "m", maxTurns: 5, tools: ["Read"], resume: "abc", forkSession: true, jsonSchema: "{}" }))
      .toEqual(expect.arrayContaining(["--resume", "abc", "--fork-session", "--json-schema", "{}"]));
  });

  it("sends the prompt on stdin, collects the files the agent wrote and reports its session", async () => {
    const { ws, req } = surveyWorkspace();
    let trace: { session_id?: string | null; cost_usd: number } | null = null;
    const runtime = new CliAgentRuntime({
      runtime: "claude", skillsDir, argv: [process.execPath, fakeCli()],
      files: { model: "m", maxTurns: 40, tools: ["Read", "Write", "Glob"] },
      onCall: (t) => { trace = t; },
    });
    const res = await runtime.runTask({ skill: "channel-package", brief: "Chọn cảnh", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(res.outputs.map((o) => o.path)).toEqual(["output/survey.json"]);
    expect(readFileSync(join(ws, "stdin.txt"), "utf8")).toContain("# Brief\nChọn cảnh");
    expect(JSON.parse(readFileSync(join(ws, "argv.json"), "utf8"))).not.toContain("--no-session-persistence");
    expect(trace).toMatchObject({ session_id: "sess-1", cost_usd: 0.25 });
  });

  it("resumes the session it is given (the repair round)", async () => {
    const { ws, req } = surveyWorkspace();
    let trace: { session_id?: string | null } | null = null;
    const runtime = new CliAgentRuntime({
      runtime: "claude", skillsDir, argv: [process.execPath, fakeCli()],
      files: { model: "m", maxTurns: 40, tools: ["Read", "Write"], resume: "sess-1" },
      onCall: (t) => { trace = t; },
    });
    const res = await runtime.runTask({ skill: "channel-package", brief: "sửa", request: req, workspaceDir: ws }, { ...ctx, workspaceDir: ws });
    expect(res.outcome).toBe("succeeded");
    expect(JSON.parse(readFileSync(join(ws, "argv.json"), "utf8"))).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(trace).toMatchObject({ session_id: "sess-1-next" });
  });
});
