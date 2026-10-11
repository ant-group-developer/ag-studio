import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StreamJsonReader, toolDetail, toolResultText } from "../src/stream-json.js";

const sample = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../fixtures/agent-stream/${name}.jsonl`, import.meta.url)), "utf8");
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 10, 8, 0, tick++)).toISOString();

function readAll(text: string, chunk = 97): StreamJsonReader {
  const r = new StreamJsonReader(clock);
  for (let i = 0; i < text.length; i += chunk) r.push(text.slice(i, i + chunk));
  r.end();
  return r;
}

describe("StreamJsonReader on a real turn (fixtures/agent-stream/turn-tools)", () => {
  const r = readAll(sample("turn-tools"));

  it("knows the session, the model, the tools and the MCP server", () => {
    expect(r.state.session_id).toBe("13201e7e-c166-45f6-b996-96299351dd0f");
    expect(r.state.model).toBe("claude-sonnet-5-5");
    expect(r.state.tools).toEqual(["Edit", "Glob", "Grep", "Read", "Skill", "Write", "mcp__studio__echo", "mcp__studio__sleep"]);
    expect(r.state.mcp_servers).toEqual([{ name: "studio", status: "connected" }]);
  });

  it("keeps the text and the tool calls in order, each tool with its input, times and answer", () => {
    const tools = r.state.parts.filter((p) => p.kind === "tool");
    expect(tools.map((t) => t.kind === "tool" && t.name)).toEqual([
      "mcp__studio__echo", "Read", "Read", "Write", "Write", "Write", "Read", "Skill", "Read", "Read", "Edit", "Read",
    ]);
    const echo = tools[0]!;
    expect(echo).toMatchObject({ input: { text: "xin chao" }, is_error: false });
    expect(echo.kind === "tool" && echo.result).toContain("echo:xin chao token=present");
    expect(tools.every((t) => t.kind === "tool" && !!t.started_at && !!t.ended_at)).toBe(true);
    const denied = tools[1]!;
    expect(denied).toMatchObject({ is_error: true });
    const picture = tools.find((t) => t.kind === "tool" && typeof t.result === "string" && t.result.includes("[ảnh]"));
    expect(picture).toBeDefined();
    expect(r.state.parts[0]?.kind).toBe("text");
    expect(r.text).toContain("KET-THUC-A");
  });

  it("records refused file access, the plan's limits, and the result with its cost", () => {
    expect(r.state.permission_denials.map((d) => d.tool)).toEqual(["Read", "Read", "Read"]);
    expect(r.state.rate_limit).toMatchObject({ status: "allowed", five_hour: 0.1, seven_day: 0.58 });
    expect(r.state.result).toMatchObject({ subtype: "success", is_error: false, num_turns: expect.any(Number) });
    expect(r.state.result!.cost_usd).toBeGreaterThan(0);
    expect(r.state.result!.input_tokens).toBeGreaterThan(0);
    // the cache split and the time are kept for the Claude stats; input_tokens stays the sum
    expect(r.state.result).toMatchObject({ input_tokens: 6 + 11616 + 19365, cache_creation_tokens: 11616, cache_read_tokens: 19365, output_tokens: 2848, num_turns: 13, duration_ms: 19248 });
    expect(r.state.phase).toEqual({ kind: "done" });
  });

  it("reads the same whatever the chunk size", () => {
    expect(readAll(sample("turn-tools"), 7).text).toBe(r.text);
    expect(readAll(sample("turn-tools"), 100_000).state.parts.length).toBe(r.state.parts.length);
  });
});

describe("other turns", () => {
  it("a turn killed during a tool call: the call has started, never ended, no result", () => {
    const r = readAll(sample("turn-killed"));
    const tool = r.state.parts.find((p) => p.kind === "tool");
    expect(tool).toMatchObject({ name: "mcp__studio__sleep", input: { seconds: 40 } });
    expect(tool?.kind === "tool" && tool.ended_at).toBeUndefined();
    expect(r.state.result).toBeNull();
  });

  it("a turn that ran out of turns says so", () => {
    expect(readAll(sample("turn-max-turns")).state.result).toMatchObject({ subtype: "error_max_turns", is_error: true });
  });

  it("a skill from the plugin folder is a tool call named Skill", () => {
    const r = readAll(sample("turn-plugin-skill"));
    expect(r.state.parts.find((p) => p.kind === "tool")).toMatchObject({ name: "Skill", input: { skill: "studio:kiem-tra-plugin" } });
    expect(r.text).toBe("PLUGIN-OK-88");
  });

  it("follows the phase: thinking, writing, a tool with its detail, done", () => {
    const r = new StreamJsonReader(clock);
    const seen: string[] = [];
    for (const line of sample("turn-tools").split(/\r?\n/)) {
      r.push(`${line}\n`);
      const p = r.state.phase;
      const label = p.kind === "tool" ? `tool:${p.tool}` : p.kind;
      if (seen.at(-1) !== label) seen.push(label);
    }
    expect(seen.slice(0, 4)).toEqual(["starting", "thinking", "writing", "tool:mcp__studio__echo"]);
    expect(seen.at(-1)).toBe("done");
  });

  it("drops a line too long to keep and goes on", () => {
    const r = new StreamJsonReader(clock);
    r.push(`{"type":"user","message":{"content":[{"type":"tool_result","content":"${"x".repeat(9 * 1024 * 1024)}`);
    r.push(`"}]}}\n{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1,"session_id":"s"}\n`);
    r.end();
    expect(r.state.result).toMatchObject({ subtype: "success", text: "ok" });
    expect(r.text).toBe("ok");
  });
});

describe("helpers", () => {
  it("summarises a tool's answer and its input", () => {
    expect(toolResultText([{ type: "text", text: "a" }, { type: "image", source: {} }])).toBe("a\n[ảnh]");
    expect(toolResultText("x".repeat(2000)).length).toBe(1501);
    expect(toolDetail("Read", { file_path: "C:\\ws\\p\\channel\\branding.md" })).toBe("p/channel/branding.md");
    expect(toolDetail("Glob", { pattern: "videos/**/*.md" })).toBe("videos/**/*.md");
    expect(toolDetail("mcp__studio__render_preview", { video_id: "v1" })).toBe("v1");
  });
});
