import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError, StageResultSchema, type Executor, type ExecutorContext, type StageRequest, type StageResult } from "@harness/contracts";

export class ScriptExecutor implements Executor {
  readonly version = "script-executor@0.1.0";
  constructor(private readonly commands: Record<string, string[]>) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const name = String(request.stage_config.__script ?? "");
    const argv = this.commands[name];
    if (!argv || argv.length === 0) throw new HarnessError("NOT_FOUND", `no script registered for "${name}"`, { script: name });
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const timeoutMs = Math.max(1, Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now()));
    const failed = (kind: "transient" | "result", message: string, details: Record<string, unknown>): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details }],
    });
    const started = Date.now();
    const { code, timedOut, stderr } = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: ctx.workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_STAGE_KEY: request.stage_key } });
      let stderr = ""; let timedOut = false;
      child.stdout.on("data", (d) => ctx.logger.info(String(d).trimEnd(), { stream: "stdout" }));
      child.stderr.on("data", (d) => { stderr += String(d); ctx.logger.warn(String(d).trimEnd(), { stream: "stderr" }); });
      const onAbort = () => child.kill();
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => { clearTimeout(timer); ctx.signal?.removeEventListener("abort", onAbort); resolve({ code, timedOut, stderr }); });
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
