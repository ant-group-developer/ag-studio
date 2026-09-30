/**
 * Executor for Studio's Claude agent stages (GĐ2: studio-trend-report, studio-plan-episodes, studio-youtube-kit).
 *
 * - The whole prompt goes through stdin: skill + stage brief + every input inlined as JSON. Claude runs with no
 *   tools at all, so nothing in a caption can make it read or write anything.
 * - The output shape is forced with `--json-schema`, then checked by the stage's deterministic validator.
 * - A rejected answer gets exactly one repair round with the problem list appended; a second rejection fails
 *   the stage as `contract` (parks WAITING_HUMAN; a person retries or edits at the next gate).
 * - Hitting the subscription limit waits with growing backoff inside the deadline; not counted as an attempt.
 * - `studio-trend-report` is skipped when research has no videos (writes a `skipped: true` document, cost 0).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeOutputJsonSchema, STUDIO_SKILL_OUTPUTS, TrendReportSchema,
  type AgentRuntime, type CheckerInput, type Executor, type ExecutorContext, type StageRequest, type StageResult, type StudioSkill,
} from "@harness/contracts";
import {
  loadBrief, loadCatalog, STUDIO_TYPES, validateSeriesPlan, validateTrendReport, validateYoutubeKit,
  type StudioProblem, type StudioValidation,
} from "@harness/core";
import { StudioEpisodeSchema } from "@harness/contracts";

export interface StudioAgentExecutorOptions {
  /** A runtime bound to one output JSON Schema. Optionally receives the skill name for per-skill model selection. */
  runtimeFor: (jsonSchema: string, skill?: StudioSkill) => AgentRuntime;
  rateLimitBackoffMs?: number[];
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
  "studio-trend-report": (raw) => validateTrendReport(raw),
  "studio-plan-episodes": (raw, i) => {
    const brief = loadBrief(i);
    const catalog = loadCatalog(i);
    return validateSeriesPlan(raw, { brief, catalog: catalog.assets });
  },
  "studio-youtube-kit": (raw, i) => {
    const episodePath = i.request.inputs.find((x) => x.type === STUDIO_TYPES.episode);
    if (!episodePath) return { ok: false, value: undefined, problems: [{ code: "missing_input", message: "missing studio_episode input" }], warnings: [] };
    const episodeRaw = JSON.parse(readFileSync(join(i.workspaceDir, episodePath.path), "utf8"));
    const episode = StudioEpisodeSchema.parse(episodeRaw);
    return validateYoutubeKit(raw, { episode });
  },
};

/** Compact a catalog: one line per asset (drop empty/null fields). */
function compactCatalogLine(value: unknown): string {
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
      // Compact v2: header line + one asset per line (omit empty fields)
      try {
        const cat = JSON.parse(text) as { assets?: unknown[]; [k: string]: unknown };
        const assets = cat.assets ?? [];
        body = [compactCatalogLine({ ...cat, assets: undefined }), ...assets.map((a) => compactCatalogLine(a))].join("\n");
      } catch { /* leave as-is */ }
    } else if (input.type === STUDIO_TYPES.research) {
      // research: per channel/keyword only the top 15 videos by views_per_day
      try {
        const r = JSON.parse(text) as { channels?: Array<{ videos?: unknown[] }>; keywords?: Array<{ videos?: unknown[] }>; [k: string]: unknown };
        const compact = {
          ...r,
          channels: (r.channels ?? []).map((ch) => ({
            ...ch,
            videos: (ch.videos ?? [])
              .sort((a, b) => (b as { views_per_day?: number }).views_per_day ?? 0 - ((a as { views_per_day?: number }).views_per_day ?? 0))
              .slice(0, 15)
              .map((v) => {
                const vv = v as Record<string, unknown>;
                return { title: vv["title"], views: vv["views"], views_per_day: vv["views_per_day"], duration_s: vv["duration_s"], published_at: vv["published_at"], tags: (vv["tags"] as string[] | undefined)?.slice(0, 10), outlier: vv["outlier"] };
              }),
          })),
          keywords: (r.keywords ?? []).map((kw) => ({
            ...kw,
            videos: (kw.videos ?? [])
              .sort((a, b) => (b as { views_per_day?: number }).views_per_day ?? 0 - ((a as { views_per_day?: number }).views_per_day ?? 0))
              .slice(0, 15)
              .map((v) => {
                const vv = v as Record<string, unknown>;
                return { title: vv["title"], views: vv["views"], views_per_day: vv["views_per_day"], duration_s: vv["duration_s"], published_at: vv["published_at"], tags: (vv["tags"] as string[] | undefined)?.slice(0, 10), outlier: vv["outlier"] };
              }),
          })),
        };
        body = JSON.stringify(compact, null, 2);
      } catch { /* leave as-is */ }
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

/** Write a skipped TrendReport (no research videos -> Claude skipped). */
function writeSkipped(outPath: string, skill: StudioSkill, workspaceDir: string, request: StageRequest): void {
  void workspaceDir; void request;
  if (skill !== "studio-trend-report") return;
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(TrendReportSchema.parse({
    schema_version: "studio.trend-report/v1",
    skipped: true, summary: "Không có dữ liệu nghiên cứu.",
    working_angles: [], title_patterns: [], hook_patterns: [], thumbnail_patterns: [],
    recommended_duration_s: null, posting_schedule: "", recommendations: [],
  }), null, 2));
}

export class StudioAgentExecutor implements Executor {
  readonly version = "studio-agent-executor@2.0.0";
  constructor(private readonly opts: StudioAgentExecutorOptions) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const started = Date.now();
    const skill = String(request.stage_config.__skill ?? "") as StudioSkill;
    const failed = (kind: "transient" | "contract", message: string, details: Record<string, unknown> = {}, cost = 0): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost }, external_operations: [], errors: [{ kind, message, details }],
    });
    const succeeded = (cost = 0): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded", outputs: [], checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost }, external_operations: [], errors: [],
    });
    if (!(skill in STUDIO_SKILL_OUTPUTS)) return failed("contract", `"${skill}" is not a Studio skill`, { skill });
    const out = request.expected_outputs[0];
    if (!out?.name) return failed("contract", "a Studio agent stage needs one named output", { skill });
    const outPath = join(ctx.workspaceDir, "output", out.name);

    // --- Skip rule for studio-trend-report: no research videos -> write skipped doc ---
    if (skill === "studio-trend-report") {
      const resPath = request.inputs.find((x) => x.type === STUDIO_TYPES.research);
      if (resPath) {
        try {
          const res = JSON.parse(readFileSync(join(ctx.workspaceDir, resPath.path), "utf8")) as {
            channels?: Array<{ videos?: unknown[] }>; keywords?: Array<{ videos?: unknown[] }>;
          };
          const totalVideos = (res.channels ?? []).reduce((n, ch) => n + (ch.videos?.length ?? 0), 0)
            + (res.keywords ?? []).reduce((n, kw) => n + (kw.videos?.length ?? 0), 0);
          if (totalVideos === 0) {
            mkdirSync(join(ctx.workspaceDir, "output"), { recursive: true });
            writeSkipped(outPath, skill, ctx.workspaceDir, request);
            ctx.logger.info("studio-trend-report skipped (no research videos)");
            // Register the written file as an output so the harness stages it and checks pass.
            const bytes = readFileSync(outPath);
            const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            const rel = `output/${out.name}`;
            return {
              schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
              outputs: [{ path: rel, type: out.type, checksum, size_bytes: bytes.length, kind: "file" as const }],
              checks: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
              external_operations: [], errors: [],
            };
          }
        } catch { /* if we can't read it, proceed to Claude */ }
      }
    }

    const runtime = this.opts.runtimeFor(JSON.stringify(claudeOutputJsonSchema(skill)), skill);
    const validator = VALIDATORS[skill];
    const backoff = this.opts.rateLimitBackoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    const deadline = Date.parse(request.limits.deadline_at);

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
          ctx.logger.warn("Claude subscription limit; waiting before retry (not counted as attempt)", { wait_ms: wait, waits });
          waits++;
          await sleep(wait, ctx.signal);
          if (ctx.signal?.aborted) return failed("transient", "stage aborted while waiting for the Claude limit", { code: "RATE_LIMITED" }, cost);
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
        // warnings never block; just log them
        if (verdict.warnings.length) ctx.logger.warn("Studio agent output has warnings", { skill, warnings: verdict.warnings.map((w) => w.message) });
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
