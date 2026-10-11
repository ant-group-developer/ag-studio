/**
 * A thread as text (spec 2026-10-10 agent-workspace §4): what people asked, what the agent answered, the tools it used
 * and the files it changed. Studio writes it to `.studio/history/<thread>.md` after each turn so another thread can
 * read it; the `thread_history` tool answers a slice of it.
 */
import type { AgentPart } from "@harness/adapter-agent-cli";
import type { StudioDb } from "../studio-db.js";
import { listMessages, messageView, type MessageView, type ThreadRecord } from "./threads-db.js";

const ROLE_LABEL = { user: "Người dùng", assistant: "Agent", system: "Studio" } as const;

function toolLine(p: Extract<AgentPart, { kind: "tool" }>): string {
  const input = p.input && typeof p.input === "object" ? JSON.stringify(p.input) : "";
  const short = input.length > 160 ? `${input.slice(0, 160)}…` : input;
  return `- ${p.is_error ? "✗" : "·"} \`${p.name.replace(/^mcp__studio__/, "")}\` ${short}`;
}

/** One message as markdown: its text, then (for the agent) the tools it called. */
export function messageMarkdown(m: MessageView): string {
  const head = `### ${ROLE_LABEL[m.role]} · ${m.createdAt.slice(0, 16).replace("T", " ")}${m.status !== "done" ? ` · ${m.status}` : ""}`;
  const tools = m.parts.filter((p): p is Extract<AgentPart, { kind: "tool" }> => p.kind === "tool");
  const files = m.attachments.length ? `\nĐính kèm: ${m.attachments.map((a) => `\`${a}\``).join(", ")}` : "";
  return [head, m.text.trim() || (tools.length ? "" : "_(không có chữ)_"), files.trim(), tools.length ? `Công cụ đã dùng:\n${tools.map(toolLine).join("\n")}` : ""]
    .filter(Boolean).join("\n\n");
}

/** The whole thread (or the messages that mention `query`) as markdown, oldest first. */
export function threadMarkdown(db: StudioDb, thread: ThreadRecord, opts: { query?: string; limit?: number } = {}): string {
  let messages = listMessages(db, thread.id, { limit: 5000 }).map(messageView).filter((m) => m.status !== "pending");
  if (opts.query) {
    const q = opts.query.toLowerCase();
    messages = messages.filter((m) => m.text.toLowerCase().includes(q));
  }
  if (opts.limit) messages = messages.slice(-opts.limit);
  const title = `# Luồng chat: ${thread.title}\n\n_${thread.kind === "video" ? "Luồng của video" : "Luồng của dự án"} · ${messages.length} tin_`;
  return [title, ...messages.map(messageMarkdown)].join("\n\n") + "\n";
}
