/**
 * Tool names as people read them: every tool the agent can call has a label in both locales (a missing one showed as
 * `footage_search` in the chat), and what it works on reads as words, not ids.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "../../i18n/config";
import { en } from "../../i18n/locales/en";
import { vi } from "../../i18n/locales/vi";
import type { AgentPart } from "../../api/workspace-client";
import { toolLabel, toolTarget, type Translate } from "./labels";

const AGENT_SRC = join(__dirname, "../../../../../packages/studio-engine/src/agent");

/** The Studio tools (`tool({ name: "…" })`) and the built-in ones a turn may use (`AGENT_BUILTIN_TOOLS`). */
function agentToolNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(AGENT_SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(AGENT_SRC, file), "utf8");
    for (const m of text.matchAll(/tool\(\{\s*name:\s*"([a-z_]+)"/g)) names.add(m[1]!);
    const builtin = /AGENT_BUILTIN_TOOLS\s*=\s*\[([^\]]*)\]/.exec(text);
    if (builtin) for (const m of builtin[1]!.matchAll(/"([A-Za-z]+)"/g)) names.add(m[1]!);
  }
  return [...names];
}

const tool = (name: string, input: unknown): Extract<AgentPart, { kind: "tool" }> => ({ kind: "tool", id: "x", name, input, started_at: "2026-10-12T00:00:00Z" });
const tVi = i18n.getFixedT("vi") as unknown as Translate;

describe("tool labels", () => {
  const names = agentToolNames();

  it("finds the agent's tools", () => {
    expect(names).toEqual(expect.arrayContaining(["Read", "Write", "footage_search", "inputs_add", "timeline_apply_ops"]));
    expect(names.length).toBeGreaterThan(25);
  });

  it.each([["vi", vi], ["en", en]] as const)("every agent tool has a label in %s", (_lang, messages) => {
    const labels = (messages as unknown as { ws: { tool: Record<string, string> } }).ws.tool;
    expect(names.filter((n) => !labels[n])).toEqual([]);
  });

  it("reads Studio's tools by their label, and spells out one nobody named yet", () => {
    expect(toolLabel(tVi, "mcp__studio__footage_search")).toBe("tìm cảnh trong footage");
    expect(toolLabel(tVi, "inputs_add")).toBe("thêm video vào đầu vào");
    expect(toolLabel(tVi, "mcp__studio__brand_new_tool")).toBe("brand new tool");
  });

  it("says what a tool works on", () => {
    expect(toolTarget(tool("Write", { file_path: "/data/workspaces/p1/videos/v1/plan.md" }))).toBe("videos/v1/plan.md");
    expect(toolTarget(tool("mcp__studio__footage_search", { q: "chùa trên núi" }), tVi)).toBe("chùa trên núi");
    expect(toolTarget(tool("mcp__studio__inputs_add", { assets: [{ asset_id: "a", name: "Hoa Lư 03.mp4" }] }), tVi)).toBe("Hoa Lư 03.mp4");
    expect(toolTarget(tool("mcp__studio__inputs_add", { assets: [{ asset_id: "a" }, { asset_id: "b" }] }), tVi)).toBe("2 video");
    expect(toolTarget(tool("mcp__studio__inputs_prepare", { asset_ids: ["a", "b", "c"] }), tVi)).toBe("3 video");
    expect(toolTarget(tool("mcp__studio__timeline_apply_ops", { base_revision: 2, ops: [{}, {}] }), tVi)).toBe("2 thay đổi");
  });
});
