/**
 * One structured answer from the CLI with no tools and no session (`--json-schema`): Studio's own small jobs around
 * agent threads, like summarizing a thread (spec 2026-10-10 agent-workspace §4).
 */
import { spawn } from "node:child_process";
import { agentChildEnv, isRateLimitMessage, RUNTIME_COMMANDS } from "./cli-agent-runtime.js";
import { killTree } from "./kill-tree.js";
import { defaultResolveDeps, resolveCommand } from "./resolve-command.js";

export interface StructuredCallOptions {
  command: string[];
  cwd: string;
  prompt: string;
  jsonSchema: string;
  model: string;
  baseEnv: Record<string, string | undefined>;
  configDir: string;
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface StructuredCallOutcome {
  status: "done" | "failed" | "rate_limited" | "timeout" | "cancelled";
  output: unknown;
  costUsd: number;
  error: string | null;
}

export function runStructuredCall(o: StructuredCallOptions): Promise<StructuredCallOutcome> {
  const { cmd, prefixArgs } = resolveCommand(o.command[0]!, defaultResolveDeps(o.baseEnv.PATH ?? o.baseEnv.Path));
  const env = { ...agentChildEnv(o.baseEnv, [...RUNTIME_COMMANDS.claude.env_passthrough.filter((k) => k !== "CLAUDE_CONFIG_DIR"), "FAKE_AGENT_LOG_DIR"], o.cwd), CLAUDE_CONFIG_DIR: o.configDir };
  const argv = [
    ...prefixArgs, ...o.command.slice(1),
    "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "3",
    "--model", o.model, "--json-schema", o.jsonSchema,
  ];
  const child = spawn(cmd, argv, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let stdout = "";
  let stderr = "";
  let stopped: "timeout" | "cancelled" | null = null;
  const stop = (why: "timeout" | "cancelled") => { if (!stopped) { stopped = why; if (child.pid) killTree(child.pid); } };
  const timer = setTimeout(() => stop("timeout"), Math.max(1000, o.deadlineMs));
  const onAbort = () => stop("cancelled");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { stdout += d; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
  child.stdin.on("error", () => {});
  child.stdin.end(o.prompt);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null, spawnError: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      let env: Record<string, unknown> = {};
      try { env = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>; } catch { /* not JSON */ }
      const costUsd = typeof env.total_cost_usd === "number" ? env.total_cost_usd : 0;
      if (stopped) return resolve({ status: stopped, output: null, costUsd, error: stopped });
      if (spawnError) return resolve({ status: "failed", output: null, costUsd, error: spawnError });
      if (isRateLimitMessage(`${stdout}\n${stderr}`)) return resolve({ status: "rate_limited", output: null, costUsd, error: "rate_limited" });
      if (code !== 0 || env.is_error === true || env.structured_output === undefined) {
        return resolve({ status: "failed", output: null, costUsd, error: stderr.trim().split("\n").at(-1) || `exit ${code}` });
      }
      resolve({ status: "done", output: env.structured_output, costUsd, error: null });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code, null));
  });
}
