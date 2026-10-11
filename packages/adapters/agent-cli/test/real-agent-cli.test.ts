/**
 * The spike of spec 2026-10-10 agent-workspace §9 against the real `claude` CLI, to re-run when the CLI is upgraded.
 * Only with HARNESS_REAL_CLAUDE_TEST=1 (it calls Claude with the machine's CLAUDE_CODE_OAUTH_TOKEN): restricted tools,
 * no reads or writes outside the workspace, writes under .studio refused, the Studio MCP server connected, skills
 * from a plugin folder only, a session resumed with a new system prompt.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentTurn, type AgentTurnOptions } from "../src/index.js";

const REAL = process.env.HARNESS_REAL_CLAUDE_TEST === "1";
const MCP = fileURLToPath(new URL("../../../../fixtures/fake-mcp-server.mjs", import.meta.url));

describe.skipIf(!REAL)("real claude CLI (agent workspace spike)", { timeout: 240_000 }, () => {
  it("is confined to the workspace, sees only Studio tools and skills, keeps its session", async () => {
    const root = mkdtempSync(join(tmpdir(), "real-agent-"));
    const ws = join(root, "ws");
    const turn = join(root, "turn");
    const plugin = join(root, "plugin");
    for (const d of [join(ws, ".studio"), turn, join(plugin, ".claude-plugin"), join(plugin, "skills", "kiem-tra")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root, "outside.txt"), "OUTSIDE");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "studio", version: "0.0.1" }));
    writeFileSync(join(plugin, "skills", "kiem-tra", "SKILL.md"), "---\nname: kiem-tra\ndescription: Trả mã kiểm tra.\n---\nTrả lời đúng chuỗi SKILL-OK.\n");
    writeFileSync(join(turn, "mcp.json"), JSON.stringify({ mcpServers: { studio: { type: "stdio", command: process.execPath, args: [MCP] } } }));
    writeFileSync(join(turn, "settings.json"), JSON.stringify({
      permissions: { deny: ["Write(.studio/**)", "Edit(.studio/**)", "Write(.claude/**)", "Edit(.claude/**)"] },
      disableBundledSkills: true, skillOverrides: { design: "off", doctor: "off" },
    }));
    const sessionId = randomUUID();
    const base: AgentTurnOptions = {
      command: ["claude"], cwd: ws, prompt: "", model: "sonnet", sessionId, resume: false,
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Skill"], allowedTools: ["mcp__studio__echo"], appendSystemPrompt: "Kết thúc câu trả lời bằng KET-A.",
      settingsPath: join(turn, "settings.json"), mcpConfigPath: join(turn, "mcp.json"), pluginDirs: [plugin], maxTurns: 20,
      baseEnv: process.env, configDir: join(root, "claude-config"), deadlineMs: 200_000,
    };
    const first = await runAgentTurn({
      ...base,
      prompt: "Làm lần lượt: 1) gọi mcp__studio__echo với text 'a'; 2) đọc ../outside.txt; 3) ghi notes/a.md nội dung ok; 4) ghi .studio/x.md nội dung x; 5) dùng skill studio:kiem-tra.",
    });
    expect(first.status).toBe("done");
    expect(first.state.tools.sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Skill", "Write", "mcp__studio__echo"]);
    expect(first.state.mcp_servers).toEqual([{ name: "studio", status: "connected" }]);
    expect(first.state.permission_denials.some((d) => /outside the working directory/.test(d.reason))).toBe(true);
    expect(existsSync(join(ws, "notes", "a.md"))).toBe(true);
    expect(existsSync(join(ws, ".studio", "x.md"))).toBe(false);
    expect(first.text).toContain("SKILL-OK");
    expect(first.text).toContain("KET-A");

    const second = await runAgentTurn({ ...base, resume: true, appendSystemPrompt: "Kết thúc câu trả lời bằng KET-B.", prompt: "Lượt trước bạn ghi file nào? Một câu." });
    expect(second.status).toBe("done");
    expect(second.text).toContain("notes/a.md");
    expect(second.text).toContain("KET-B");
  });
});
