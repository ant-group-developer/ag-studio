/**
 * Reads `claude -p --output-format stream-json --verbose --include-partial-messages` as it comes (spec 2026-10-10
 * agent-workspace §3.2, samples in fixtures/agent-stream): what the agent is doing now (thinking, writing, which tool),
 * its text and tool calls in order with their times, the session, and the final result with cost. Unknown event types
 * are ignored; images and long tool results are never kept.
 */

/** One piece of an agent's answer, in the order it happened. */
export type AgentPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** The tool's input once known (`null` while it streams in). */
      input: unknown;
      started_at: string;
      ended_at?: string;
      is_error?: boolean;
      /** The tool's answer, shortened (images replaced by `[ảnh]`). */
      result?: string;
    };

export type AgentPhase =
  | { kind: "starting" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; tool: string; detail: string | null }
  | { kind: "done" };

export interface AgentResult {
  subtype: string;
  is_error: boolean;
  text: string;
  cost_usd: number;
  num_turns: number;
  input_tokens: number;
  output_tokens: number;
  errors: string[];
}

export interface AgentTurnState {
  session_id: string | null;
  model: string | null;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  parts: AgentPart[];
  phase: AgentPhase;
  permission_denials: { tool: string; reason: string }[];
  rate_limit: { status: string; resets_at: number | null; five_hour: number | null; seven_day: number | null } | null;
  result: AgentResult | null;
}

/** A line longer than this is dropped (a base64 screenshot in a tool result). */
const MAX_LINE = 8 * 1024 * 1024;
/** How much of a tool's answer is kept with the part. */
export const TOOL_RESULT_CHARS = 1500;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function shorten(text: string, max = TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A tool result's content as short text: text blocks joined, images as `[ảnh]`. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return shorten(content);
  if (!Array.isArray(content)) return "";
  return shorten(content.map((c) => {
    if (!isObj(c)) return "";
    if (c.type === "text") return str(c.text) ?? "";
    if (c.type === "image") return "[ảnh]";
    return "";
  }).filter(Boolean).join("\n"));
}

/** The one-line detail of a tool call for the status line: the file it reads or writes, the pattern it looks for. */
export function toolDetail(name: string, input: unknown): string | null {
  if (!isObj(input)) return null;
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (path) return path.replace(/\\/g, "/").split("/").slice(-3).join("/");
  const pattern = str(input.pattern) ?? str(input.query) ?? str(input.skill) ?? str(input.command);
  if (pattern) return shorten(pattern, 80);
  if (name.startsWith("mcp__")) {
    const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
    return first ? shorten(first, 80) : null;
  }
  return null;
}

/**
 * Feed it stdout chunks (`push`) as they arrive and `end()` once the process exits; `state` is always current.
 * `push`/`end` answer whether anything a person would see changed (callers throttle their writes on it).
 */
export class StreamJsonReader {
  readonly state: AgentTurnState = {
    session_id: null, model: null, tools: [], mcp_servers: [], parts: [], phase: { kind: "starting" },
    permission_denials: [], rate_limit: null, result: null,
  };
  private buffer = "";
  private skipping = false;
  private messageId: string | null = null;
  /** `${message}:${block index}` → part, for the streamed blocks of the current message. */
  private blocks = new Map<string, AgentPart>();
  private finalText = new Set<AgentPart>();
  private toolJson = new Map<string, string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  push(chunk: string): boolean {
    let changed = false;
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (this.skipping) { this.skipping = false; continue; }
      if (this.line(line)) changed = true;
    }
    if (this.buffer.length > MAX_LINE) { this.buffer = ""; this.skipping = true; }
    return changed;
  }

  end(): boolean {
    const rest = this.buffer;
    this.buffer = "";
    const changed = !this.skipping && rest.trim() ? this.line(rest) : false;
    if (this.state.phase.kind !== "done") { this.state.phase = { kind: "done" }; return true; }
    return changed;
  }

  /** Every text part, joined: the answer as plain text. */
  get text(): string {
    return this.state.parts.filter((p): p is Extract<AgentPart, { kind: "text" }> => p.kind === "text").map((p) => p.text.trim()).filter(Boolean).join("\n\n");
  }

  private line(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    let ev: Json;
    try { ev = JSON.parse(trimmed) as Json; } catch { return false; }
    if (!isObj(ev)) return false;
    switch (ev.type) {
      case "system": return this.system(ev);
      case "stream_event": return isObj(ev.event) ? this.stream(ev.event) : false;
      case "assistant": return isObj(ev.message) ? this.assistant(ev.message) : false;
      case "user": return isObj(ev.message) ? this.user(ev.message) : false;
      case "rate_limit_event": return this.rateLimit(ev.rate_limit_info);
      case "result": return this.resultEvent(ev);
      default: return false;
    }
  }

  private system(ev: Json): boolean {
    if (ev.subtype === "init") {
      this.state.session_id = str(ev.session_id) ?? this.state.session_id;
      this.state.model = str(ev.model);
      this.state.tools = Array.isArray(ev.tools) ? ev.tools.filter((t): t is string => typeof t === "string") : [];
      this.state.mcp_servers = Array.isArray(ev.mcp_servers)
        ? ev.mcp_servers.filter(isObj).map((s) => ({ name: str(s.name) ?? "", status: str(s.status) ?? "" }))
        : [];
      return true;
    }
    if (ev.subtype === "permission_denied") {
      this.state.permission_denials.push({ tool: str(ev.tool_name) ?? "", reason: str(ev.decision_reason) ?? str(ev.message) ?? "" });
      return false;
    }
    if (ev.subtype === "thinking_tokens" && this.state.phase.kind !== "tool") {
      if (this.state.phase.kind === "thinking") return false;
      this.state.phase = { kind: "thinking" };
      return true;
    }
    return false;
  }

  private stream(e: Json): boolean {
    if (e.type === "message_start") {
      this.messageId = isObj(e.message) ? str(e.message.id) : null;
      this.blocks.clear();
      return false;
    }
    const key = `${this.messageId ?? ""}:${num(e.index)}`;
    if (e.type === "content_block_start" && isObj(e.content_block)) {
      const b = e.content_block;
      if (b.type === "text") {
        const part: AgentPart = { kind: "text", text: str(b.text) ?? "" };
        this.blocks.set(key, part);
        this.state.parts.push(part);
        this.state.phase = { kind: "writing" };
        return true;
      }
      if (b.type === "tool_use") {
        const name = str(b.name) ?? "?";
        const part: AgentPart = { kind: "tool", id: str(b.id) ?? key, name, input: null, started_at: this.now() };
        this.blocks.set(key, part);
        this.state.parts.push(part);
        this.state.phase = { kind: "tool", tool: name, detail: null };
        return true;
      }
      if (b.type === "thinking") {
        if (this.state.phase.kind === "thinking") return false;
        this.state.phase = { kind: "thinking" };
        return true;
      }
      return false;
    }
    if (e.type === "content_block_delta" && isObj(e.delta)) {
      const part = this.blocks.get(key);
      if (e.delta.type === "text_delta" && part?.kind === "text") {
        part.text += str(e.delta.text) ?? "";
        return true;
      }
      if (e.delta.type === "input_json_delta" && part?.kind === "tool") {
        this.toolJson.set(part.id, (this.toolJson.get(part.id) ?? "") + (str(e.delta.partial_json) ?? ""));
      }
      return false;
    }
    if (e.type === "content_block_stop") {
      const part = this.blocks.get(key);
      if (part?.kind === "tool" && part.input === null) {
        try { part.input = JSON.parse(this.toolJson.get(part.id) || "{}"); } catch { /* the assistant event brings it */ }
        if (this.state.phase.kind === "tool" && this.state.phase.tool === part.name) this.state.phase = { kind: "tool", tool: part.name, detail: toolDetail(part.name, part.input) };
        return true;
      }
    }
    return false;
  }

  private assistant(m: Json): boolean {
    const id = str(m.id);
    let changed = false;
    for (const c of Array.isArray(m.content) ? m.content.filter(isObj) : []) {
      if (c.type === "text") {
        const text = str(c.text) ?? "";
        const open = this.state.parts.find((p) => p.kind === "text" && !this.finalText.has(p) && this.blocksOf(id).includes(p));
        if (open && open.kind === "text") {
          if (open.text !== text) { open.text = text; changed = true; }
          this.finalText.add(open);
        } else if (text) {
          const part: AgentPart = { kind: "text", text };
          this.finalText.add(part);
          this.state.parts.push(part);
          changed = true;
        }
      } else if (c.type === "tool_use") {
        const toolId = str(c.id) ?? "";
        const name = str(c.name) ?? "?";
        let part = this.state.parts.find((p) => p.kind === "tool" && p.id === toolId);
        if (!part) {
          part = { kind: "tool", id: toolId, name, input: c.input ?? null, started_at: this.now() };
          this.state.parts.push(part);
          changed = true;
        }
        if (part.kind === "tool") {
          part.input = c.input ?? part.input;
          this.state.phase = { kind: "tool", tool: name, detail: toolDetail(name, part.input) };
          changed = true;
        }
      }
    }
    return changed;
  }

  private blocksOf(messageId: string | null): AgentPart[] {
    if (!messageId || messageId !== this.messageId) return [];
    return [...this.blocks.values()];
  }

  private user(m: Json): boolean {
    let changed = false;
    for (const c of Array.isArray(m.content) ? m.content.filter(isObj) : []) {
      if (c.type !== "tool_result") continue;
      const part = this.state.parts.find((p) => p.kind === "tool" && p.id === c.tool_use_id);
      if (!part || part.kind !== "tool") continue;
      part.ended_at = this.now();
      part.is_error = c.is_error === true;
      part.result = toolResultText(c.content);
      changed = true;
    }
    if (changed && this.state.parts.every((p) => p.kind !== "tool" || p.ended_at)) this.state.phase = { kind: "thinking" };
    return changed;
  }

  private rateLimit(info: unknown): boolean {
    if (!isObj(info)) return false;
    const windows = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
    const util = (k: string) => (isObj(windows[k]) && typeof (windows[k] as Json).utilization === "number" ? (windows[k] as Json).utilization as number : null);
    this.state.rate_limit = {
      status: str(info.status) ?? "", resets_at: typeof info.resetsAt === "number" ? info.resetsAt : null,
      five_hour: util("five_hour"), seven_day: util("seven_day"),
    };
    return false;
  }

  private resultEvent(ev: Json): boolean {
    const u = isObj(ev.usage) ? ev.usage : {};
    this.state.session_id = str(ev.session_id) ?? this.state.session_id;
    this.state.result = {
      subtype: str(ev.subtype) ?? "",
      is_error: ev.is_error === true,
      text: str(ev.result) ?? "",
      cost_usd: num(ev.total_cost_usd),
      num_turns: num(ev.num_turns),
      input_tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
      output_tokens: num(u.output_tokens),
      errors: Array.isArray(ev.errors) ? ev.errors.filter((x): x is string => typeof x === "string") : [],
    };
    // Without partial messages there may be no text part: the result carries the answer.
    if (!this.state.parts.some((p) => p.kind === "text") && this.state.result.text && !this.state.result.is_error) {
      this.state.parts.push({ kind: "text", text: this.state.result.text });
    }
    this.state.phase = { kind: "done" };
    return true;
  }
}
