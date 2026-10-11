import type { AgentPart, AgentPhase } from "../../api/workspace-client";

/** A translate function (react-i18next's, or the one that fills in the AI's name). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** `mcp__studio__video_create` → `video_create`; built-in tools keep their name. */
export const toolKey = (name: string) => name.replace(/^mcp__studio__/, "");

/** A tool's name as people read it ("Ghi file", "Tạo video"), else its own name. */
export function toolLabel(t: Translate, name: string): string {
  const key = toolKey(name);
  const label = t(`ws.tool.${key}`, { defaultValue: "" });
  return label || key;
}

/** What the tool works on, in a few words: the file, the pattern, the skill. */
export function toolTarget(p: Extract<AgentPart, { kind: "tool" }>): string | null {
  const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : null;
  if (!input) return null;
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const path = pick("file_path") ?? pick("path");
  if (path) return path.replace(/\\/g, "/").replace(/^.*?\/(?=(CLAUDE\.md|context|research|channel|videos|inputs|memory|skills|threads|\.studio)(\/|$))/, "");
  const other = pick("pattern") ?? pick("skill") ?? pick("title") ?? pick("query") ?? pick("topic");
  return other ? (other.length > 60 ? `${other.slice(0, 60)}…` : other) : null;
}

/** "Đang suy nghĩ", "Đang viết", "Đang ghi file context/a.md"… */
export function phaseLabel(t: Translate, phase: AgentPhase | null, parts: AgentPart[]): string {
  if (!phase || phase.kind === "starting") return t("ws.chat.phase.starting");
  if (phase.kind === "thinking") return t("ws.chat.phase.thinking");
  if (phase.kind === "writing") return t("ws.chat.phase.writing");
  if (phase.kind === "tool") {
    const running = [...parts].reverse().find((p): p is Extract<AgentPart, { kind: "tool" }> => p.kind === "tool" && !p.ended_at);
    const target = running ? toolTarget(running) : phase.detail;
    return t("ws.chat.phase.tool", { tool: toolLabel(t, phase.tool), target: target ? ` · ${target}` : "" });
  }
  return t("ws.chat.phase.done");
}
