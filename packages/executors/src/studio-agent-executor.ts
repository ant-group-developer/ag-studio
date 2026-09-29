/**
 * Executor for Studio's Claude stages (`treatment`, `select-shots`, `narration`; plan 3.2 + 4.1).
 *
 * - The whole prompt goes through stdin: skill + stage brief + every input inlined as JSON. Claude runs with no
 *   tools at all, so nothing in a caption or `visible_text` can make it read or write anything.
 * - The output shape is forced with `--json-schema` (constraints structured outputs cannot express are
 *   stripped, see `claudeOutputJsonSchema`), then checked for real by the stage's deterministic validator.
 * - A rejected answer gets exactly one repair round with the problem list appended; a second rejection fails
 *   the stage as `contract` (it parks WAITING_HUMAN; a person retries or edits at the next gate).
 * - Hitting the subscription limit is not a failed attempt: the executor waits with a growing backoff inside
 *   the stage deadline (the worker's heartbeat keeps the lease) and tries again.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  claudeOutputJsonSchema, STUDIO_SKILL_OUTPUTS,
  type AgentRuntime, type CheckerInput, type Executor, type ExecutorContext, type StageRequest, type StageResult, type StudioSkill,
} from "@harness/contracts";
import {
  loadBrief, loadCatalog, loadTreatment, STUDIO_TYPES, validateNarration, validateSelection, validateTreatment,
  type StudioProblem, type StudioValidation,
} from "@harness/core";

export interface StudioAgentExecutorOptions {
  /** A runtime bound to one output JSON Schema (`CliAgentRuntime` in structured mode in production). */
  runtimeFor: (jsonSchema: string) => AgentRuntime;
  /** Waits after a RATE_LIMITED answer, in order; the last value repeats. Default 5, 10, 20, 40, 60 minutes. */
  rateLimitBackoffMs?: number[];
  /** Test seam for the backoff wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * 60_000);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
    const onAbort = () => { clearTimeout(t); res(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type Validator = (raw: unknown, input: CheckerInput) => StudioValidation<unknown>;
const VALIDATORS: Record<StudioSkill, Validator> = {
  "studio-treatment": (raw, i) => validateTreatment(raw, loadBrief(i)),
  "studio-select-shots": (raw, i) => validateSelection(raw, { brief: loadBrief(i), catalog: loadCatalog(i), treatment: loadTreatment(i) }),
  "studio-narration": (raw, i) => validateNarration(raw, { brief: loadBrief(i), treatment: loadTreatment(i) }),
};

/** Catalog entries without the empty fields: the catalog is by far the largest part of the prompt. */
function compactJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === null || (Array.isArray(v) && v.length === 0) || v === "" ? undefined : v));
}

export function studioPrompt(request: StageRequest, workspaceDir: string, problems: StudioProblem[] | null): string {
  const parts: string[] = [String(request.stage_config.__brief ?? ""), "", "# Dữ liệu vào"];
  for (const input of request.inputs) {
    if (input.kind === "directory") continue;
    const path = join(workspaceDir, input.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    let body = text;
    if (input.type === STUDIO_TYPES.catalog) {
      const cat = JSON.parse(text) as { segments: unknown[]; [k: string]: unknown };
      body = [compactJson({ ...cat, segments: undefined }), ...cat.segments.map((s) => compactJson(s))].join("\n");
    }
    parts.push("", `## ${input.type} (${input.path.split("/").pop()})`, "```json", body.trim(), "```");
  }
  parts.push("", "# Đầu ra", "Trả lời bằng đúng một đối tượng JSON khớp JSON Schema đã cho. Không viết gì ngoài JSON đó.");
  if (problems) {
    parts.push("", "# Lần trả lời trước bị hệ thống kiểm tra từ chối", "Sửa đúng các lỗi sau rồi trả lại toàn bộ đối tượng JSON:",
      ...problems.map((p) => `- [${p.code}] ${p.message}`));
  }
  return parts.join("\n");
}

export class StudioAgentExecutor implements Executor {
  readonly version = "studio-agent-executor@1.0.0";
  constructor(private readonly opts: StudioAgentExecutorOptions) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const started = Date.now();
    const skill = String(request.stage_config.__skill ?? "") as StudioSkill;
    const failed = (kind: "transient" | "contract", message: string, details: Record<string, unknown> = {}, cost = 0): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost }, external_operations: [], errors: [{ kind, message, details }],
    });
    if (!(skill in STUDIO_SKILL_OUTPUTS)) return failed("contract", `"${skill}" is not a Studio skill`, { skill });
    const out = request.expected_outputs[0];
    if (!out?.name) return failed("contract", "a Studio agent stage needs one named output", { skill });

    const runtime = this.opts.runtimeFor(JSON.stringify(claudeOutputJsonSchema(skill)));
    const validator = VALIDATORS[skill];
    const backoff = this.opts.rateLimitBackoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    const deadline = Date.parse(request.limits.deadline_at);
    const outPath = join(ctx.workspaceDir, "output", out.name);

    let cost = 0;
    let problems: StudioProblem[] | null = null;
    let waits = 0;
    for (let round = 0; round < 2;) {
      rmSync(outPath, { force: true });
      const brief = studioPrompt(request, ctx.workspaceDir, problems);
      const result = await runtime.runTask({ skill, brief, request, workspaceDir: ctx.workspaceDir }, ctx);
      cost += result.usage.cost_usd;
      const err = result.errors[0];
      if (result.outcome !== "succeeded") {
        if (err?.details?.code === "RATE_LIMITED") {
          const wait = backoff[Math.min(waits, backoff.length - 1)]!;
          if (Date.parse(ctx.clock.now()) + wait >= deadline) return failed("transient", "Claude rate limit did not reset before the stage deadline", { code: "RATE_LIMITED", waits }, cost);
          ctx.logger.warn("Claude subscription limit reached; waiting before trying again (not counted as an attempt)", { wait_ms: wait, waits });
          waits++;
          await sleep(wait, ctx.signal);
          if (ctx.signal?.aborted) return failed("transient", "stage aborted while waiting for the Claude limit to reset", { code: "RATE_LIMITED" }, cost);
          continue;
        }
        return { ...result, usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost } };
      }
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(outPath, "utf8")); }
      catch (e) { return failed("contract", `Claude returned no JSON for ${out.name}`, { error: String(e) }, cost); }
      const checkerInput = { request, result, workspaceDir: ctx.workspaceDir } as CheckerInput;
      let verdict: StudioValidation<unknown>;
      try { verdict = validator(raw, checkerInput); }
      catch (e) { return failed("contract", `cannot validate ${out.name}: ${e instanceof Error ? e.message : String(e)}`, {}, cost); }
      if (verdict.ok) {
        ctx.logger.info("Studio agent output accepted", { skill, repaired: round > 0 });
        return { ...result, usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost } };
      }
      problems = verdict.problems;
      ctx.logger.warn("Studio agent output rejected by the deterministic check", { skill, round, problems: problems.length });
      round++;
    }
    return failed("contract", `${skill}: output still invalid after one repair round`, { problems }, cost);
  }
}
