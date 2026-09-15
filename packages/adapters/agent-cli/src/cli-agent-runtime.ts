import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directoryListing } from "@harness/script-sdk";
import type { AgentRuntime, AgentTask, ExecutorContext, StageOutput, StageResult } from "@harness/contracts";

export type AgentCliRuntimeKind = "claude" | "codex";

/** Argv and the env vars each headless CLI is allowed to see, keyed by runtime kind. One place to tune flags. */
// Sub-project 4's five studio skills (style-analyze, style-review, source-survey, edit-plan, library-review)
// drive the fake agent CLI through a few extra test-only knobs beyond FAKE_AGENT_MODE (see
// fixtures/fake-agent-cli.mjs's own header comment) -- harmless in production (the real `claude`/`codex`
// binaries simply never read them), but they must be in this allow-list or `agentChildEnv` strips them
// before the fake CLI ever sees them.
const FAKE_AGENT_TEST_ENV = ["FAKE_AGENT_MODE", "FAKE_REVIEW_MODE", "FAKE_AGENT_FAIL_STAGE", "FAKE_STYLE_STATUS", "FAKE_STYLE_REVIEW"];

export const RUNTIME_COMMANDS: Record<AgentCliRuntimeKind, { argv: string[]; env_passthrough: string[] }> = {
  claude: {
    argv: ["claude", "-p", "{prompt}", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(ffprobe:*)"],
    env_passthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", ...FAKE_AGENT_TEST_ENV],
  },
  codex: {
    argv: ["codex", "exec", "--full-auto", "--json", "{prompt}"],
    env_passthrough: ["OPENAI_API_KEY", "CODEX_HOME", ...FAKE_AGENT_TEST_ENV],
  },
};

export const PROMPT_POINTER = "Read the file ./agent-prompt.md in the current directory and follow it exactly. Work only inside this directory.";

export interface CliAgentRuntimeOptions {
  runtime: AgentCliRuntimeKind;
  skillsDir: string;
  argv?: string[];
  redact?: (s: string) => string;
  baseEnv?: Record<string, string | undefined>;
}

/** Vars every child CLI process may see regardless of runtime, beyond its own `env_passthrough`. */
const BASE_ENV_ALLOWLIST = ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"];

/**
 * Builds the child process env for an agent CLI: the shared allowlist plus this runtime's
 * `env_passthrough`, nothing else — and never a `HARNESS_SECRET_*` key, even if someone adds one to
 * `env_passthrough` by mistake. `HARNESS_WORKSPACE` is always set so the CLI (or its tools) can find
 * the workspace root even though `cwd` already points there.
 */
export function agentChildEnv(base: Record<string, string | undefined>, passthrough: string[], workspace: string): Record<string, string> {
  // Windows env var names vary in case (Path/PATH, Temp/TEMP, ...); compare upper-cased so the lookup
  // finds them regardless of how the host process happens to have cased them, but always emit the
  // canonical name from the allow-list so the child sees a predictable key.
  const upper = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(base)) upper.set(k.toUpperCase(), v);
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV_ALLOWLIST, ...passthrough]) {
    const canonical = key.toUpperCase();
    // Case-insensitive on both sides: a passthrough entry spelled "harness_secret_x_y" must be
    // stripped exactly like "HARNESS_SECRET_X_Y" — the lookup below is already case-insensitive
    // (matches base env keys via `canonical`), so the secret guard must be too, or a
    // differently-cased passthrough entry would sail through and leak the resolved value.
    if (canonical.startsWith("HARNESS_SECRET_")) continue;
    const v = upper.get(canonical);
    if (v !== undefined) env[key] = v;
  }
  env.HARNESS_WORKSPACE = workspace;
  return env;
}

function sha256File(path: string): { checksum: string; size_bytes: number } {
  return { checksum: "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex"), size_bytes: statSync(path).size };
}

export class CliAgentRuntime implements AgentRuntime {
  readonly name: string;
  readonly version = "0.1.0";
  constructor(private readonly opts: CliAgentRuntimeOptions) {
    this.name = `agent-cli-${opts.runtime}`;
  }

  /** Cheap availability probe (`<argv0> --version`); never invokes the model. Used by `doctor` and by tests to skip real-CLI runs. */
  static isAvailable(runtime: AgentCliRuntimeKind, argv0?: string): boolean {
    const r = spawnSync(argv0 ?? runtime, ["--version"], { timeout: 10000 });
    return r.status === 0;
  }

  async runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult> {
    const { request } = task;
    const redact = this.opts.redact ?? ((s: string) => s);
    const started = Date.now();
    const failed = (kind: "transient" | "contract", message: string, details: Record<string, unknown> = {}): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details }],
    });

    const skillPath = join(this.opts.skillsDir, task.skill, "SKILL.md");
    if (!existsSync(skillPath)) return failed("contract", `skill not found: ${task.skill}`, { skill: task.skill, skillPath });
    const skillContent = readFileSync(skillPath, "utf8");
    const promptContent = `# Skill\n${skillContent}\n\n# Brief\n${task.brief}\n\n# Stage request\nĐọc stage-request.json cùng thư mục. Ghi output vào output/ theo skill.\n`;
    writeFileSync(join(task.workspaceDir, "agent-prompt.md"), redact(promptContent));

    const rawArgv = this.opts.argv ?? RUNTIME_COMMANDS[this.opts.runtime].argv;
    const argv = rawArgv.map((a) => (a === "{prompt}" ? PROMPT_POINTER : a));
    const [cmd, ...cmdArgs] = argv;
    if (!cmd) return failed("contract", "empty argv for agent CLI", { runtime: this.opts.runtime });

    const passthrough = RUNTIME_COMMANDS[this.opts.runtime].env_passthrough;
    const env = agentChildEnv(this.opts.baseEnv ?? process.env, passthrough, task.workspaceDir);
    const deadlineMs = Math.max(1, Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now()));

    let stdoutBuf = "";
    let combinedLog = "";
    const forward = (level: "info" | "warn", chunk: string) => {
      const s = redact(chunk);
      combinedLog += s;
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        ctx.logger[level](line, { stream: level === "info" ? "stdout" : "stderr" });
      }
    };

    type SpawnResult = { code: number | null; timedOut: boolean; spawnError: Error | null };
    const { code, timedOut, spawnError } = await new Promise<SpawnResult>((resolve) => {
      const child = spawn(cmd, cmdArgs, { cwd: task.workspaceDir, env, stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      let settled = false;
      const onAbort = () => child.kill();
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, deadlineMs);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = (result: SpawnResult) => {
        if (settled) return; // "error" and "close" can both fire (or neither cleanly); resolve once
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.stdout.on("data", (d) => { const s = String(d); stdoutBuf += s; forward("info", s); });
      child.stderr.on("data", (d) => forward("warn", String(d)));
      // Without this handler, a missing binary (ENOENT) or similar spawn failure throws an unhandled
      // "error" event and crashes the whole process instead of resolving the promise.
      child.on("error", (e) => settle({ code: null, timedOut, spawnError: e }));
      child.on("close", (code) => settle({ code, timedOut, spawnError: null }));
    });

    mkdirSync(join(task.workspaceDir, "logs"), { recursive: true });
    writeFileSync(join(task.workspaceDir, "logs", "agent-stdout.log"), redact(combinedLog));

    // Spec §4.3: "CLI không có trên PATH → failed contract" -- a missing agent CLI is a machine that was never
    // set up (doctor's `agent:runtime` row says so up front), not a blip worth retrying the stage over.
    if (spawnError) return failed("contract", `agent CLI failed to start: ${spawnError.message}`, { code: "EXECUTOR_FAILED", reason: spawnError.message });
    if (timedOut) return failed("transient", "agent CLI exceeded deadline", { code: "EXECUTOR_TIMEOUT", timeout_ms: deadlineMs });
    if (code !== 0) return failed("transient", `agent CLI exited with code ${code}`, { code: "EXECUTOR_FAILED", exit_code: code });

    const outputs: StageOutput[] = [];
    for (const eo of request.expected_outputs) {
      if (!eo.name) return failed("contract", "expected_outputs entry has no name", { type: eo.type });
      const rel = `output/${eo.name}`;
      const abs = join(task.workspaceDir, rel);
      if (!existsSync(abs)) return failed("contract", `agent wrote no output/${eo.name}`, { name: eo.name });
      if (eo.kind === "directory") {
        const { checksum, size_bytes } = directoryListing(abs);
        outputs.push({ path: rel, type: eo.type, checksum, size_bytes, kind: "directory" });
      } else {
        outputs.push({ path: rel, type: eo.type, ...sha256File(abs), kind: "file" });
      }
    }

    let cost_usd = 0;
    const lastLine = stdoutBuf.trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const parsed = JSON.parse(lastLine) as Record<string, unknown>;
      if (typeof parsed.total_cost_usd === "number") cost_usd = parsed.total_cost_usd;
    } catch { /* last line is not JSON, or has no total_cost_usd: cost stays 0 */ }

    return {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
      outputs, checks: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd }, external_operations: [], errors: [],
    };
  }
}
