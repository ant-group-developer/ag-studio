import type { AgentPart, AgentPhase } from "../../api/workspace-client";

/** A translate function (react-i18next's, or the one that fills in the AI's name). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** `mcp__studio__video_create` → `video_create`; built-in tools keep their name. */
export const toolKey = (name: string) => name.replace(/^mcp__studio__/, "");

/** `footage_search` → "footage search": a tool nobody has named yet still reads as words. */
const spelledOut = (key: string) => key.replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();

/** A tool's name as people read it ("ghi file", "tìm cảnh trong footage"), else its name spelled out. */
export function toolLabel(t: Translate, name: string): string {
  const key = toolKey(name);
  const label = t(`ws.tool.${key}`, { defaultValue: "" });
  return label || spelledOut(key);
}

const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** A file path as the workspace names it (`videos/v1/plan.md`), whatever folder the agent ran in. */
export const workspacePath = (path: string) =>
  path.replace(/\\/g, "/").replace(/^.*?\/(?=(CLAUDE\.md|context|research|channel|videos|inputs|memory|skills|threads|\.studio)(\/|$))/, "");

/** What the tool works on, in a few words: the file, the search, the videos, the skill. `t` words the counts. */
export function toolTarget(p: Extract<AgentPart, { kind: "tool" }>, t?: Translate): string | null {
  const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : null;
  if (!input) return null;
  const pick = (k: string) => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : null);
  const list = (k: string) => (Array.isArray(input[k]) ? (input[k] as unknown[]) : null);
  const path = pick("file_path") ?? pick("path");
  if (path) return workspacePath(path);
  const key = toolKey(p.name);
  if (key === "inputs_add") {
    const assets = list("assets") ?? [];
    const names = assets.map((a) => (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : null));
    if (names.length && names.every(Boolean)) return short(names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", "));
    return t && assets.length ? t("ws.toolTarget.videos", { count: assets.length }) : null;
  }
  if (key === "inputs_prepare") {
    const n = list("asset_ids")?.length ?? 0;
    return t && n ? t("ws.toolTarget.videos", { count: n }) : null;
  }
  if (key === "timeline_apply_ops") {
    const n = list("ops")?.length ?? 0;
    return t && n ? t("ws.toolTarget.changes", { count: n }) : null;
  }
  if (key === "thumbnail_make") {
    const texts = (list("items") ?? []).map((i) => (i && typeof i === "object" ? (i as { text?: unknown }).text : null)).filter((x): x is string => typeof x === "string");
    return texts.length ? short(texts.map((x) => `“${x}”`).join(", ")) : null;
  }
  const other = pick("pattern") ?? pick("skill") ?? pick("title") ?? pick("query") ?? pick("q") ?? pick("channel") ?? pick("topic") ?? pick("mood")
    ?? pick("description") ?? pick("url") ?? pick("command");
  return other ? short(other) : null;
}

/** "Đang suy nghĩ", "Đang viết", "Đang ghi file context/a.md"… */
export function phaseLabel(t: Translate, phase: AgentPhase | null, parts: AgentPart[]): string {
  if (!phase || phase.kind === "starting") return t("ws.chat.phase.starting");
  if (phase.kind === "thinking") return t("ws.chat.phase.thinking");
  if (phase.kind === "writing") return t("ws.chat.phase.writing");
  if (phase.kind === "tool") {
    const running = [...parts].reverse().find((p): p is Extract<AgentPart, { kind: "tool" }> => p.kind === "tool" && !p.ended_at);
    const target = running ? toolTarget(running, t) : phase.detail;
    return t("ws.chat.phase.tool", { tool: toolLabel(t, phase.tool), target: target ? ` · ${target}` : "" });
  }
  return t("ws.chat.phase.done");
}
