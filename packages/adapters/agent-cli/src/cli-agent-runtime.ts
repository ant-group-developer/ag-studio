import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directoryListing } from "@harness/script-sdk";
import type { AgentCallTrace, AgentRuntime, AgentTask, ExecutorContext, StageOutput, StageResult } from "@harness/contracts";
import { defaultResolveDeps, resolveCommand } from "./resolve-command.js";

export type AgentCliRuntimeKind = "claude" | "codex";

/** Argv and the env vars each headless CLI is allowed to see, keyed by runtime kind. One place to tune flags. */
// Sub-project 4's five studio skills (style-analyze, style-review, source-survey, edit-plan, library-review)
// drive the fake agent CLI through a few extra test-only knobs beyond FAKE_AGENT_MODE (see
// fixtures/fake-agent-cli.mjs's own header comment) -- harmless in production (the real `claude`/`codex`
// binaries simply never read them), but they must be in this allow-list or `agentChildEnv` strips them
// before the fake CLI ever sees them.
// Sub-project 3B's channel-planning/channel-package skills add two more (FAKE_ANGLE overrides the fake
// draft's/proposal's angle, FAKE_METRIC overrides the fake draft's expected.metric) -- same rationale as the
// rest of this list: harmless for the real `claude`/`codex` binaries, needed by the fake CLI in tests.
// Sub-project 5A task 8 adds FAKE_NARRATION_CHARS: the length of each fake `narration.json` line's
// placeholder text (edit-plan skill, library-production@1.2.0), used by media-fit-edl tests that need a
// narration line longer than the footage a fake shoot provides. Sub-project 5B adds FAKE_OVERLAYS (which
// overlay plan the fake `edit-plan` writes) and, at task 11, FAKE_NARRATION_TEXT: real "|"-separated
// sentences in place of that placeholder, so a real 4K run on this machine reads real speech and burns real
// (accented) subtitles instead of a row of `x`.
const FAKE_AGENT_TEST_ENV = ["FAKE_AGENT_MODE", "FAKE_REVIEW_MODE", "FAKE_AGENT_FAIL_STAGE", "FAKE_STYLE_STATUS", "FAKE_STYLE_REVIEW", "FAKE_ANGLE", "FAKE_METRIC", "FAKE_NARRATION_CHARS", "FAKE_NARRATION_TEXT", "FAKE_OVERLAYS", "FAKE_STUDIO_MODE"];

export const RUNTIME_COMMANDS: Record<AgentCliRuntimeKind, { argv: string[]; env_passthrough: string[] }> = {
  claude: {
    // File-based (agentic) mode: claude reads agent-prompt.md via PROMPT_POINTER and writes output files.
    argv: ["claude", "-p", "{prompt}", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(ffprobe:*)"],
    // CLAUDE_CODE_OAUTH_TOKEN (subscription) is the preferred auth method. When ANTHROPIC_API_KEY is also
    // present, the CLI uses the key first and ignores OAuth — so we intentionally do NOT pass the API key
    // here; studio workflows use OAuth tokens only.
    env_passthrough: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", ...FAKE_AGENT_TEST_ENV],
  },
  codex: {
    argv: ["codex", "exec", "--full-auto", "--json", "{prompt}"],
    env_passthrough: ["OPENAI_API_KEY", "CODEX_HOME", ...FAKE_AGENT_TEST_ENV],
  },
};

/** Argv for studio (structured-output) skills: no file tools, prompt via stdin, JSON schema output.
 *  `{schema}` is replaced with the JSON-encoded schema string. `{max_turns}` and `{model}` are replaced
 *  with their configured values. The `--no-session-persistence` flag prevents cross-run state leakage. */
export const STUDIO_ARGV = ["claude", "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "{max_turns}", "--model", "{model}"];

/**
 * A structured call's argv. With `tools` (web mode, ADR-0001 item 176: `WebSearch`, `WebFetch`) those are the only
 * tools available and they are allowed without asking; still no session, no MCP server, no file or shell tool.
 */
export function studioStructuredArgv(o: { model: string; maxTurns: number; tools?: readonly string[] }): string[] {
  const tools = o.tools?.length ? o.tools.join(",") : "";
  const argv = STUDIO_ARGV.map((a) => (a === "{model}" ? o.model : a === "{max_turns}" ? String(o.maxTurns) : a));
  if (!tools) return argv;
  argv[argv.indexOf("--tools") + 1] = tools;
  return [...argv, "--allowedTools", tools];
}

/**
 * Studio stages that must LOOK at files (contact sheets of the shot-cut workflow, ADR-0001 item 155): the prompt on
 * stdin as in structured mode, but the agent may read and write files in its workspace and the session is kept, so
 * a repair round or a chat turn can `--resume` it with every frame it already saw.
 */
export interface StudioFilesMode {
  model?: string;
  maxTurns?: number;
  /** `--allowedTools`, e.g. `["Read", "Write", "Glob", "Grep"]`: no Bash, no web. */
  tools: string[];
  /** Session to continue (`--resume`); with `forkSession` the answer runs in a new session forked from it. */
  resume?: string;
  forkSession?: boolean;
  /** A structured answer as well (`--json-schema`), e.g. a chat reply. */
  jsonSchema?: string;
}

export function studioFilesArgv(f: StudioFilesMode): string[] {
  return [
    "claude", "-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", f.tools.join(","),
    "--strict-mcp-config", "--max-turns", String(f.maxTurns ?? 40), "--model", f.model ?? "claude-sonnet-5-5",
    ...studioFilesFlags(f),
  ];
}

/** The flags a files-mode call needs whatever the argv (a fake CLI in tests must receive them too). */
function studioFilesFlags(f: StudioFilesMode): string[] {
  return [
    ...(f.resume ? ["--resume", f.resume] : []),
    ...(f.resume && f.forkSession ? ["--fork-session"] : []),
    ...(f.jsonSchema ? ["--json-schema", f.jsonSchema] : []),
  ];
}

/** In studio mode, the prompt + catalog go to the agent via stdin (not via agent-prompt.md + Read).
 *  This avoids the 100k+ token catalog having to be written to disk and read back in a single Read call,
 *  and removes the file-system surface for prompt injection via visible_text/caption. */
export const PROMPT_POINTER = "Read the file ./agent-prompt.md in the current directory and follow it exactly. Work only inside this directory.";

/** What the Claude CLI prints when the subscription limit is reached. The wording varies between versions:
 *  "You've hit your 5-hour limit" (straight or curly apostrophe, or "you have"), "You've reached your usage
 *  limit", "Claude AI usage limit reached|<epoch>". */
const RATE_LIMIT_PATTERNS = [
  /\byou(?:['’]ve| have) (?:hit|reached) your\b[^\n]*\blimit\b/i,
  /\busage limit reached\b/i,
  // claude 2.x JSON mode: the envelope only says "Request rejected (429) · Subscription limit exceeded", api_error_status 429
  /\bsubscription limit exceeded\b/i,
  /"api_error_status"\s*:\s*429\b/,
];

export function isRateLimitMessage(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

export interface CliAgentRuntimeOptions {
  runtime: AgentCliRuntimeKind;
  skillsDir: string;
  argv?: string[];
  redact?: (s: string) => string;
  baseEnv?: Record<string, string | undefined>;
  /** When set, the runtime operates in structured-output (studio) mode:
   *  • prompt is sent via stdin rather than written to agent-prompt.md
   *  • `--tools ""` / `--no-session-persistence` / `--output-format json` are used
   *  • the `structured_output` field in the JSON response is written to the first expected output file
   *  • rate-limit detection is active and failures are tagged with code RATE_LIMITED */
  structured?: {
    jsonSchema?: string;   // JSON-encoded schema string passed via --json-schema
    model?: string;        // model to request (default: claude-opus-4-5)
    maxTurns?: number;     // default: 3
    /** Web mode: the only tools available (`WebSearch`, `WebFetch`); none by default. */
    tools?: string[];
  };
  /** Studio files mode (see `StudioFilesMode`); exclusive with `structured`. */
  files?: StudioFilesMode;
  /** Structured mode only: receives every call (redacted prompt and raw answer) once the CLI exits, whatever the outcome. */
  onCall?: (trace: AgentCallTrace) => void;
}

/** Cost and token counts from the CLI's JSON envelope (the last stdout line). */
function envelopeUsage(stdout: string): { cost_usd: number; input_tokens: number | null; output_tokens: number | null; structured_output: unknown; session_id: string | null } {
  const out = { cost_usd: 0, input_tokens: null as number | null, output_tokens: null as number | null, structured_output: undefined as unknown, session_id: null as string | null };
  try {
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "") as Record<string, unknown>;
    if (typeof parsed.total_cost_usd === "number") out.cost_usd = parsed.total_cost_usd;
    out.structured_output = parsed.structured_output;
    if (typeof parsed.session_id === "string") out.session_id = parsed.session_id;
    const u = parsed.usage as Record<string, unknown> | undefined;
    const n = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
    if (u) {
      out.input_tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
      out.output_tokens = n("output_tokens");
    }
  } catch { /* not a JSON envelope: the CLI failed before answering */ }
  return out;
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
    const { cmd, prefixArgs } = resolveCommand(argv0 ?? runtime, defaultResolveDeps(process.env.PATH));
    const r = spawnSync(cmd, [...prefixArgs, "--version"], { timeout: 10000 });
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

    const isStructured = !!this.opts.structured;
    const files = this.opts.files;
    let stdinPayload: string | null = null;

    if (isStructured || files) {
      // Studio (structured-output) mode: prompt + brief sent via stdin; no agent-prompt.md written.
      // Tools are disabled on the CLI side, so catalog content embedded in the brief cannot trigger tool calls.
      stdinPayload = `# Skill\n${skillContent}\n\n# Brief\n${task.brief}\n`;
    } else {
      // Agentic (file-based) mode: write agent-prompt.md; claude reads it via PROMPT_POINTER.
      const promptContent = `# Skill\n${skillContent}\n\n# Brief\n${task.brief}\n\n# Stage request\nĐọc stage-request.json cùng thư mục. Ghi output vào output/ theo skill.\n`;
      writeFileSync(join(task.workspaceDir, "agent-prompt.md"), redact(promptContent));
    }

    let rawArgv: string[];
    if (isStructured) {
      const s = this.opts.structured!;
      const model = s.model ?? "claude-opus-5-5";
      rawArgv = this.opts.argv ?? studioStructuredArgv({ model, maxTurns: s.maxTurns ?? 3, ...(s.tools ? { tools: s.tools } : {}) });
      // The schema and the tools allowed are part of the contract of a structured call, so they are appended even
      // when `argv` is overridden (a fake CLI in tests must receive exactly what the real one would).
      if (this.opts.argv && s.tools?.length) rawArgv = [...rawArgv, "--allowedTools", s.tools.join(",")];
      if (s.jsonSchema) rawArgv = [...rawArgv, "--json-schema", s.jsonSchema];
    } else if (files) {
      rawArgv = this.opts.argv ? [...this.opts.argv, ...studioFilesFlags(files)] : studioFilesArgv(files);
    } else if (this.opts.argv) {
      rawArgv = this.opts.argv;
    } else {
      rawArgv = RUNTIME_COMMANDS[this.opts.runtime].argv;
    }
    const argv = isStructured || files
      ? rawArgv  // studio mode: no {prompt} substitution; -p reads from stdin
      : rawArgv.map((a) => (a === "{prompt}" ? PROMPT_POINTER : a));
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
      // Studio mode reads the prompt from stdin; agentic mode ignores stdin entirely.
      const stdinMode = stdinPayload !== null ? "pipe" : "ignore";
      // `claude` on Windows is usually an npm .cmd shim that spawn() cannot run; follow it to the real binary.
      const resolved = resolveCommand(cmd, defaultResolveDeps(env.PATH));
      const child = spawn(resolved.cmd, [...resolved.prefixArgs, ...cmdArgs], { cwd: task.workspaceDir, env, stdio: [stdinMode, "pipe", "pipe"] });
      if (stdinPayload !== null) {
        child.stdin!.end(stdinPayload, "utf8");
      }
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
      child.stdout!.on("data", (d) => { const s = String(d); stdoutBuf += s; forward("info", s); });
      child.stderr!.on("data", (d) => forward("warn", String(d)));
      // Without this handler, a missing binary (ENOENT) or similar spawn failure throws an unhandled
      // "error" event and crashes the whole process instead of resolving the promise.
      child.on("error", (e) => settle({ code: null, timedOut, spawnError: e }));
      child.on("close", (code) => settle({ code, timedOut, spawnError: null }));
    });

    mkdirSync(join(task.workspaceDir, "logs"), { recursive: true });
    writeFileSync(join(task.workspaceDir, "logs", "agent-stdout.log"), redact(combinedLog));

    if ((isStructured || files) && stdinPayload !== null && this.opts.onCall) {
      const usage = envelopeUsage(stdoutBuf);
      try {
        this.opts.onCall({
          model: (isStructured ? this.opts.structured!.model : files!.model) ?? "claude-opus-5-5",
          prompt: redact(stdinPayload),
          json_schema: (isStructured ? this.opts.structured!.jsonSchema : files!.jsonSchema) ?? null,
          response: redact(stdoutBuf),
          structured_output: usage.structured_output,
          exit_code: code,
          timed_out: timedOut,
          rate_limited: code !== 0 && isRateLimitMessage(combinedLog),
          wall_seconds: (Date.now() - started) / 1000,
          cost_usd: usage.cost_usd,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          session_id: usage.session_id,
        });
      } catch (e) {
        ctx.logger.warn("agent call trace hook failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Spec §4.3: "CLI không có trên PATH → failed contract" -- a missing agent CLI is a machine that was never
    // set up (doctor's `agent:runtime` row says so up front), not a blip worth retrying the stage over.
    if (spawnError) return failed("contract", `agent CLI failed to start: ${spawnError.message}`, { code: "EXECUTOR_FAILED", reason: spawnError.message });
    if (timedOut) return failed("transient", "agent CLI exceeded deadline", { code: "EXECUTOR_TIMEOUT", timeout_ms: deadlineMs });

    // Rate-limit detection: the Claude CLI prints "You've hit your … limit" and exits non-zero when the
    // subscription usage limit is reached. Tag it with RATE_LIMITED so the planner can treat it specially
    // (no retry deduction; wait until reset). Check the combined log since the message may appear on stderr.
    if (code !== 0 && isRateLimitMessage(combinedLog)) {
      return failed("transient", "Claude subscription rate limit reached", { code: "RATE_LIMITED", exit_code: code });
    }
    if (code !== 0) return failed("transient", `agent CLI exited with code ${code}`, { code: "EXECUTOR_FAILED", exit_code: code });

    // Structured mode: parse `structured_output` from the JSON response and write it to the first expected
    // output file. The checker then reads from that file exactly as it would for a file-based stage.
    if (isStructured) {
      const eo = request.expected_outputs[0];
      if (eo?.name) {
        let structuredOutput: unknown = undefined;
        try {
          const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
          structuredOutput = parsed.structured_output;
        } catch { /* not valid JSON -- fall through to the missing-output failure below */ }
        if (structuredOutput !== undefined) {
          const outDir = join(task.workspaceDir, "output");
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, eo.name), JSON.stringify(structuredOutput));
        }
      }
    }

    const outputs: StageOutput[] = [];
    for (const eo of request.expected_outputs) {
      if (!eo.name) return failed("contract", "expected_outputs entry has no name", { type: eo.type });
      const rel = `output/${eo.name}`;
      const abs = join(task.workspaceDir, rel);
      // Sub-project 5B: an `optional: true` output the agent chose not to write is simply absent from
      // `outputs` -- no artifact, no contract failure. Every downstream consumer already treats a missing
      // input of that type as "there is none" (`media-compose` composes without overlays).
      if (!existsSync(abs)) {
        if (eo.optional) continue;
        return failed("contract", `agent wrote no output/${eo.name}`, { name: eo.name });
      }
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
