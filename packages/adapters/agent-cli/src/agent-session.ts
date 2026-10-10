/**
 * One turn of a Studio agent in a project workspace (spec 2026-10-10 agent-workspace §3.2, ADR-0001 item 182):
 * `claude -p --output-format stream-json --restricted …` with cwd = the workspace, the prompt on stdin, a session kept
 * across turns (`--session-id` the first time, `--resume` after). The stream is read as it comes so the web sees the
 * agent's text and tool calls live; the whole process tree is killed on a deadline or a stop.
 */
import { spawn } from "node:child_process";
import { agentChildEnv, isRateLimitMessage, RUNTIME_COMMANDS } from "./cli-agent-runtime.js";
import { killTree } from "./kill-tree.js";
import { defaultResolveDeps, resolveCommand } from "./resolve-command.js";
import { StreamJsonReader, type AgentTurnState } from "./stream-json.js";

export interface AgentTurnOptions {
  /** The CLI: `["claude"]`, or a fake in tests (`["node", "fixtures/fake-studio-agent.mjs"]`). */
  command: string[];
  cwd: string;
  prompt: string;
  model: string;
  /** The thread's session id (a UUID Studio chose). */
  sessionId: string;
  /** `true` once a turn ran in this session (`--resume`), else `--session-id`. */
  resume: boolean;
  /** Built-in tools (`--tools`), e.g. Read, Write, Edit, Glob, Grep, Skill. */
  tools: string[];
  /** Tools allowed without asking beyond the built-in ones, e.g. `mcp__studio__project_info`. */
  allowedTools: string[];
  appendSystemPrompt: string;
  settingsPath: string;
  mcpConfigPath: string;
  pluginDirs: string[];
  maxTurns: number;
  /** The worker's env; only the allow-list reaches the CLI. */
  baseEnv: Record<string, string | undefined>;
  /** A config folder for agent sessions only (no host plugins, hooks or memory). */
  configDir: string;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Called whenever what a person would see changed (throttle on the caller's side). */
  onUpdate?: (state: AgentTurnState, text: string) => void;
  now?: () => string;
}

export type AgentTurnStatus = "done" | "failed" | "rate_limited" | "cancelled" | "timeout" | "session_lost" | "max_turns";

export interface AgentTurnOutcome {
  status: AgentTurnStatus;
  state: AgentTurnState;
  text: string;
  exitCode: number | null;
  /** The end of stderr (for logs; never shown raw to people). */
  stderr: string;
  error: string | null;
}

/** Env vars the agent CLI may see beyond the base allow-list (OAuth token; test knobs for the fake). */
const AGENT_ENV = [...RUNTIME_COMMANDS.claude.env_passthrough.filter((k) => k !== "CLAUDE_CONFIG_DIR"), "FAKE_AGENT_LOG_DIR"];

export function agentTurnArgv(o: Pick<AgentTurnOptions, "command" | "model" | "sessionId" | "resume" | "tools" | "allowedTools" | "appendSystemPrompt" | "settingsPath" | "mcpConfigPath" | "pluginDirs" | "maxTurns">): string[] {
  return [
    ...o.command.slice(1),
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--restricted",
    "--tools", o.tools.join(","),
    "--allowedTools", [...o.tools, ...o.allowedTools].join(","),
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--settings", o.settingsPath,
    "--strict-mcp-config", "--mcp-config", o.mcpConfigPath,
    ...o.pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    "--system-prompt-snapshot", "off", "--append-system-prompt", o.appendSystemPrompt,
    "--max-turns", String(o.maxTurns), "--model", o.model,
    ...(o.resume ? ["--resume", o.sessionId] : ["--session-id", o.sessionId]),
  ];
}

const SESSION_LOST = /No conversation found with session ID|is already in use/i;

export function runAgentTurn(o: AgentTurnOptions): Promise<AgentTurnOutcome> {
  const reader = new StreamJsonReader(o.now);
  const { cmd, prefixArgs } = resolveCommand(o.command[0]!, defaultResolveDeps(o.baseEnv.PATH ?? o.baseEnv.Path));
  const env = { ...agentChildEnv(o.baseEnv, AGENT_ENV, o.cwd), CLAUDE_CONFIG_DIR: o.configDir };
  const child = spawn(cmd, [...prefixArgs, ...agentTurnArgv(o)], {
    cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  let stderr = "";
  let stopped: "cancelled" | "timeout" | null = null;
  const stop = (why: "cancelled" | "timeout") => {
    if (stopped) return;
    stopped = why;
    if (child.pid) killTree(child.pid);
  };
  const timer = setTimeout(() => stop("timeout"), Math.max(1000, o.deadlineMs));
  const onAbort = () => stop("cancelled");
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { if (reader.push(d)) o.onUpdate?.(reader.state, reader.text); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.on("error", () => { /* the CLI exited before reading all of it */ });
  child.stdin.end(o.prompt);

  return new Promise((resolve) => {
    let finished = false;
    const finish = (code: number | null, spawnError: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (reader.end()) o.onUpdate?.(reader.state, reader.text);
      const result = reader.state.result;
      const all = `${stderr}\n${result?.errors.join("\n") ?? ""}`;
      let status: AgentTurnStatus;
      let error: string | null = null;
      if (stopped) status = stopped;
      else if (spawnError) { status = "failed"; error = spawnError; }
      else if (SESSION_LOST.test(all)) { status = "session_lost"; error = result?.errors[0] ?? stderr.trim().split("\n").at(-1) ?? null; }
      else if (isRateLimitMessage(all) || reader.state.rate_limit?.status === "rejected") { status = "rate_limited"; error = "rate_limited"; }
      else if (result?.subtype === "error_max_turns") { status = "max_turns"; error = "max_turns"; }
      else if (result && !result.is_error && code === 0) status = "done";
      else { status = "failed"; error = result?.errors[0] ?? (stderr.trim().split("\n").at(-1) || `exit ${code}`); }
      resolve({ status, state: reader.state, text: reader.text, exitCode: code, stderr: stderr.slice(-4000), error });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code, null));
  });
}
