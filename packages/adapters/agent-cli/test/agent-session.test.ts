import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentTurnArgv, isAlive, runAgentTurn, type AgentTurnOptions } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));
const FAKE = join(FIXTURES, "fake-studio-agent.mjs");
const MCP = join(FIXTURES, "fake-mcp-server.mjs");

function setup(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-turn-"));
  const ws = join(root, "ws");
  const turn = join(root, "turn");
  const logs = join(root, "logs");
  for (const d of [ws, turn, logs]) mkdirSync(d, { recursive: true });
  writeFileSync(join(turn, "mcp.json"), JSON.stringify({ mcpServers: { studio: { type: "stdio", command: process.execPath, args: [MCP], env: { FAKE_MCP_TOKEN: "t" } } } }));
  writeFileSync(join(turn, "settings.json"), "{}");
  const options = (over: Partial<AgentTurnOptions>): AgentTurnOptions => ({
    command: [process.execPath, FAKE], cwd: ws, prompt: "xin chào", model: "sonnet", sessionId: "11111111-2222-4333-8444-555555555555",
    resume: false, tools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill"], allowedTools: ["mcp__studio__echo"], appendSystemPrompt: "# Quy tắc",
    settingsPath: join(turn, "settings.json"), mcpConfigPath: join(turn, "mcp.json"), pluginDirs: [], maxTurns: 10,
    baseEnv: { ...process.env, FAKE_AGENT_LOG_DIR: logs, CLAUDE_CODE_OAUTH_TOKEN: "oauth", HARNESS_SECRET_X_Y: "secret", ...env },
    configDir: join(root, "claude-config"), deadlineMs: 30_000, ...over,
  });
  const calls = () => readdirSync(join(logs, "calls")).sort().map((f) => JSON.parse(readFileSync(join(logs, "calls", f), "utf8")) as { argv: string[]; prompt: string; env: string[] });
  return { root, ws, logs, options, calls };
}

describe("agentTurnArgv", () => {
  it("runs restricted, with only the Studio MCP server, skills from plugin folders, and a session", () => {
    const argv = agentTurnArgv({
      command: ["claude"], model: "sonnet", sessionId: "s", resume: false, tools: ["Read", "Skill"], allowedTools: ["mcp__studio__x"],
      appendSystemPrompt: "P", settingsPath: "S", mcpConfigPath: "M", pluginDirs: ["D"], maxTurns: 40,
    });
    expect(argv.join(" ")).toBe([
      "-p --output-format stream-json --verbose --include-partial-messages --restricted --tools Read,Skill",
      "--allowedTools Read,Skill,mcp__studio__x --permission-mode acceptEdits --permission-prompts none --settings S",
      "--strict-mcp-config --mcp-config M --plugin-dir D --system-prompt-snapshot off --append-system-prompt P",
      "--max-turns 40 --model sonnet --session-id s",
    ].join(" "));
    expect(agentTurnArgv({ command: ["claude"], model: "m", sessionId: "s", resume: true, tools: [], allowedTools: [], appendSystemPrompt: "", settingsPath: "", mcpConfigPath: "", pluginDirs: [], maxTurns: 1 }).slice(-2)).toEqual(["--resume", "s"]);
  });
});

describe("runAgentTurn with the fake CLI", { timeout: 60_000 }, () => {
  it("streams the turn: text, a file written, an MCP tool called for real, the session and the cost", async () => {
    const { ws, options, calls } = setup();
    const updates: string[] = [];
    const out = await runAgentTurn(options({
      prompt: "@fake say Chào bạn\n@fake write notes/a.md ok\n@fake mcp echo {\"text\":\"hi\"}\n@fake say Xong",
      onUpdate: (_s, text) => updates.push(text),
    }));
    expect(out.status).toBe("done");
    expect(out.text).toBe("Chào bạn\n\nXong");
    expect(readFileSync(join(ws, "notes", "a.md"), "utf8")).toBe("ok");
    const tools = out.state.parts.filter((p) => p.kind === "tool");
    expect(tools.map((t) => t.kind === "tool" && [t.name, t.is_error, t.result?.slice(0, 20)])).toEqual([
      ["Write", false, "File created success"], ["mcp__studio__echo", false, "echo:hi token=yes"],
    ]);
    expect(out.state.session_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(out.state.result?.cost_usd).toBe(0.001);
    expect(updates.length).toBeGreaterThan(3);
    const env = calls()[0]!.env;
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).toContain("CLAUDE_CONFIG_DIR");
    expect(env.some((k) => k.startsWith("HARNESS_SECRET_"))).toBe(false);
  });

  it("resumes the session next turn; an unknown session is lost, not a failure", async () => {
    const { options } = setup();
    expect((await runAgentTurn(options({ prompt: "@fake say một" }))).status).toBe("done");
    expect((await runAgentTurn(options({ prompt: "@fake say hai", resume: true }))).status).toBe("done");
    const lost = await runAgentTurn(options({ prompt: "x", resume: true, sessionId: "99999999-2222-4333-8444-555555555555" }));
    expect(lost.status).toBe("session_lost");
    expect(lost.error).toContain("No conversation found");
  });

  it("refuses a write outside the workspace or into .studio as the real CLI does", async () => {
    const { options } = setup();
    const out = await runAgentTurn(options({ prompt: "@fake write ../escape.md x\n@fake write .studio/x.md y" }));
    expect(out.state.parts.filter((p) => p.kind === "tool").map((t) => t.kind === "tool" && t.is_error)).toEqual([true, true]);
  });

  it("a stop kills the CLI and what it started", async () => {
    const { options, logs } = setup();
    const ac = new AbortController();
    const pending = runAgentTurn(options({ prompt: "@fake say bắt đầu\n@fake hang", signal: ac.signal }));
    const pidFile = join(logs, "hang.pid");
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    ac.abort();
    const out = await pending;
    expect(out.status).toBe("cancelled");
    expect(out.text).toBe("bắt đầu");
    for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(pid)).toBe(false);
  });

  it("a turn past its deadline is stopped as a timeout", async () => {
    const { options } = setup();
    expect((await runAgentTurn(options({ prompt: "@fake hang", deadlineMs: 1500 }))).status).toBe("timeout");
  });

  it("the plan's limit is a rate limit, not a failure", async () => {
    const { options } = setup({ FAKE_STUDIO_MODE: "agent-rate-limit-once" });
    expect((await runAgentTurn(options({}))).status).toBe("rate_limited");
    expect((await runAgentTurn(options({}))).status).toBe("done");
  });
});
