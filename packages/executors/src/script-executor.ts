import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HarnessError, StageResultSchema, type Executor, type ExecutorContext, type ScriptCommand, type SecretResolver, type StageRequest, type StageResult } from "@harness/contracts";

export interface ScriptExecutorOptions { projectDir?: string; secrets?: SecretResolver; cliArgv?: string[] }

/** Buffers stdout into lines, forwarding each through the logger; a JSON object with a known `level` and string `msg` is logged structurally, everything else as a plain `info` line. Call with `flush: true` once the stream ends to emit any trailing partial line. */
function forwardStdout(logger: ExecutorContext["logger"]) {
  let buf = "";
  return (chunk: Buffer | string, flush = false) => {
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j && typeof j === "object" && typeof j.msg === "string" && (j.level === "info" || j.level === "warn" || j.level === "error")) {
          const { level, msg, ...rest } = j;
          logger[level as "info" | "warn" | "error"](msg as string, rest);
          continue;
        }
      } catch { /* not JSON: fall through to a plain line */ }
      logger.info(line, { stream: "stdout" });
    }
  };
}

export class ScriptExecutor implements Executor {
  readonly version = "script-executor@0.2.0";
  constructor(private readonly commands: Record<string, ScriptCommand>, private readonly opts: ScriptExecutorOptions = {}) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const name = String(request.stage_config.__script ?? "");
    const cmd = this.commands[name];
    if (!cmd || cmd.argv.length === 0) throw new HarnessError("NOT_FOUND", `no script registered for "${name}"`, { script: name });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HARNESS_WORKSPACE: ctx.workspaceDir,
      HARNESS_PROJECT: this.opts.projectDir ?? ctx.workspaceDir,
      HARNESS_RUN_ID: request.run_id,
      HARNESS_STAGE_RUN_ID: request.stage_run_id,
      HARNESS_ATTEMPT_ID: request.attempt_id,
      HARNESS_FENCING_TOKEN: String(request.fencing_token),
      HARNESS_STAGE_KEY: request.stage_key,
      ...(this.opts.cliArgv ? { HARNESS_CLI_ARGV: JSON.stringify(this.opts.cliArgv) } : {}),
    };
    for (const [k, ref] of Object.entries(cmd.env_refs ?? {})) {
      if (!this.opts.secrets) throw new HarnessError("SECRET_UNRESOLVED", `script "${name}" needs ${k} from ${ref} but no secret resolver is configured`, { script: name, env: k, ref });
      env[k] = this.opts.secrets.resolve(ref); // throws SECRET_UNRESOLVED; the value never touches request/result/event
    }

    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const deadlineMs = Math.max(1, Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now()));
    const timeoutMs = cmd.timeout_seconds ? Math.min(deadlineMs, cmd.timeout_seconds * 1000) : deadlineMs;
    const cwd = cmd.cwd ? resolve(this.opts.projectDir ?? ctx.workspaceDir, cmd.cwd) : ctx.workspaceDir;

    const failed = (kind: "transient" | "result", message: string, details: Record<string, unknown>): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details }],
    });
    const started = Date.now();
    const { code, timedOut, stderr } = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>((res) => {
      const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env });
      const onStdout = forwardStdout(ctx.logger);
      let stderr = ""; let timedOut = false;
      child.stdout.on("data", (d) => onStdout(d));
      child.stderr.on("data", (d) => { stderr += String(d); ctx.logger.warn(String(d).trimEnd(), { stream: "stderr" }); });
      const onAbort = () => child.kill();
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => { onStdout("", true); clearTimeout(timer); ctx.signal?.removeEventListener("abort", onAbort); res({ code, timedOut, stderr }); });
    });
    mkdirSync(join(ctx.workspaceDir, "logs"), { recursive: true });
    writeFileSync(join(ctx.workspaceDir, "logs", "script-stderr.log"), stderr);
    if (timedOut) return failed("transient", "script exceeded deadline", { code: "EXECUTOR_TIMEOUT", timeout_ms: timeoutMs });
    if (code !== 0) return failed("transient", `script exited with code ${code}`, { code: "EXECUTOR_FAILED", exit_code: code });
    const resultPath = join(ctx.workspaceDir, "stage-result.json");
    if (!existsSync(resultPath)) return failed("result", "script exited 0 but wrote no stage-result.json", { code: "SCHEMA_INVALID" });
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(resultPath, "utf8")); }
    catch (e) { return { ...failed("result", "stage-result.json is not valid JSON", { code: "SCHEMA_INVALID" }), errors: [{ kind: "contract", message: "stage-result.json is not valid JSON", details: { code: "SCHEMA_INVALID", reason: e instanceof Error ? e.message : String(e) } }] }; }
    const parsed = StageResultSchema.safeParse(raw);
    if (!parsed.success) return { ...failed("result", "stage-result.json failed schema validation", { code: "SCHEMA_INVALID", issues: parsed.error.issues }), errors: [{ kind: "contract", message: "stage-result.json failed schema validation", details: { issues: parsed.error.issues } }] };
    return { ...parsed.data, usage: { ...parsed.data.usage, wall_seconds: parsed.data.usage.wall_seconds || (Date.now() - started) / 1000 } };
  }
}
