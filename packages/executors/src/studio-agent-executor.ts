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
  claudeOutputJsonSchema, STUDIO_SKILL_OUTPUTS, STUDIO_SKILL_STEP, teamGuidesForStep, TrendReportSchema,
  type AgentCallTrace, type AgentRuntime, type CheckerInput, type StudioChatSkill, type Executor, type ExecutorContext, type StageRequest, type StageResult, type StudioSkill,
  type TeamGuide,
} from "@harness/contracts";
import {
  isFollowUpWarning, loadBrief, loadCatalog, loadOptionalBranding, loadSeed, STUDIO_TYPES, summarizeCatalog, validateBranding, validateRnd,
  validateSeriesPlan, validateTrendReport, validateYoutubeKit,
  type StudioProblem, type StudioValidation,
} from "@harness/core";
import { StudioCatalogSchema, StudioEpisodeSchema } from "@harness/contracts";

/** One Claude call of a stage with what the deterministic check made of it (the call log / training dataset). */
export interface StudioLlmCall {
  run_id: string; stage_key: string; attempt_id: string; skill: StudioSkill | StudioChatSkill;
  /** 0 = first answer, 1 = the repair round. */
  round: number;
  outcome: "accepted" | "rejected" | "failed" | "rate_limited";
  problems: StudioProblem[];
  warnings: StudioProblem[];
  trace: AgentCallTrace;
}

export interface StudioAgentExecutorOptions {
  /** A runtime bound to one output JSON Schema. Optionally receives the skill name for per-skill model selection,
   *  and a hook the runtime hands every call's trace to. */
  runtimeFor: (jsonSchema: string, skill?: StudioSkill, onCall?: (trace: AgentCallTrace) => void) => AgentRuntime;
  /** Keeps each call; a failure here is logged and never fails the stage. */
  recordCall?: (call: StudioLlmCall) => Promise<void>;
  rateLimitBackoffMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Every enabled skill of the team the run works for; the executor keeps the ones of its step. A failure to read
   *  them fails the attempt as transient (a call without the team's rules would be a different answer). */
  teamGuidesFor?: (request: StageRequest) => TeamGuide[] | Promise<TeamGuide[]>;
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

/**
 * Claude must follow what a person decided (a hint typed before research, the approved branding): those warnings
 * become problems here, so the repair round fixes them. The same validators at a gate keep them as warnings.
 */
function followUpsAsProblems(v: StudioValidation<unknown>): StudioValidation<unknown> {
  const followUps = v.warnings.filter(isFollowUpWarning);
  if (!followUps.length) return v;
  return { ...v, ok: false, problems: [...v.problems, ...followUps], warnings: v.warnings.filter((w) => !isFollowUpWarning(w)) };
}

const VALIDATORS: Record<StudioSkill, Validator> = {
  "studio-trend-report": (raw) => validateTrendReport(raw),
  "studio-rnd": (raw, i) => followUpsAsProblems(validateRnd(raw, { seed: loadSeed(i) })),
  "studio-branding": (raw) => validateBranding(raw),
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
    return followUpsAsProblems(validateYoutubeKit(raw, { episode, branding: loadOptionalBranding(i) }));
  },
};

/**
 * The check a stage's answer must pass, for anything else that writes the same document (a chat reply proposing a
 * new version): `raw` against the inputs of `request` materialised in `workspaceDir`.
 */
export function studioValidator(skill: StudioSkill): (raw: unknown, request: StageRequest, workspaceDir: string) => StudioValidation<unknown> {
  const v = VALIDATORS[skill];
  return (raw, request, workspaceDir) => v(raw, { request, workspaceDir } as CheckerInput);
}

/** Skills that get a summary of the footage instead of every asset (they decide a direction, not a cut). */
const CATALOG_SUMMARY_SKILLS = new Set<string>(["studio-rnd", "studio-branding"]);

/** Compact a catalog: one line per asset (drop empty/null fields). */
function compactCatalogLine(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === null || (Array.isArray(v) && v.length === 0) || v === "" ? undefined : v));
}

type ResearchVideoLike = Record<string, unknown> & { views_per_day?: number | null };
type ResearchLike = { channels?: Array<{ videos?: ResearchVideoLike[] } & Record<string, unknown>>; keywords?: Array<{ videos?: ResearchVideoLike[] } & Record<string, unknown>>; [k: string]: unknown };

/** The fields of a research video Claude reads (tags cut to 10). */
function promptVideo(v: ResearchVideoLike): Record<string, unknown> {
  return {
    title: v["title"], views: v["views"], views_per_day: v["views_per_day"], duration_s: v["duration_s"], published_at: v["published_at"],
    tags: (v["tags"] as string[] | undefined)?.slice(0, 10), outlier: v["outlier"],
  };
}

/** Videos by views per day, best first (on a copy: the research document is not reordered). */
function byViewsPerDay(videos: ResearchVideoLike[] | undefined): ResearchVideoLike[] {
  return [...(videos ?? [])].sort((a, b) => (b.views_per_day ?? 0) - (a.views_per_day ?? 0));
}

/**
 * Research as Claude reads it: per reference channel and per keyword only the 15 videos with the most views per day.
 * The team's own channels show what works AND what does not: their 10 best and 5 weakest.
 */
export function compactResearch(r: ResearchLike): { channels: Array<Record<string, unknown> & { videos: Record<string, unknown>[] }>; keywords: Array<Record<string, unknown> & { videos: Record<string, unknown>[] }>; [k: string]: unknown } {
  return {
    ...r,
    channels: (r.channels ?? []).map((ch) => {
      const sorted = byViewsPerDay(ch.videos);
      const picked = ch["role"] === "own" ? [...sorted.slice(0, 10), ...sorted.slice(Math.max(10, sorted.length - 5))] : sorted.slice(0, 15);
      return { ...ch, videos: picked.map(promptVideo) };
    }),
    keywords: (r.keywords ?? []).map((kw) => ({ ...kw, videos: byViewsPerDay(kw.videos).slice(0, 15).map(promptVideo) })),
  };
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\s+/g, " ").trim();

/**
 * The team's own rules, before the inputs: instructions the team wrote (unlike the inputs, which are data). Each one
 * in its own tag so its headings cannot pass for the prompt's own sections; a closing tag inside is escaped.
 */
export function teamGuidesSection(guides: readonly TeamGuide[]): string[] {
  if (!guides.length) return [];
  return [
    "# Quy chuẩn của nhóm",
    "Nhóm sản xuất đặt các quy chuẩn dưới đây cho bước này. Làm theo chúng; quy chuẩn nào trái với quy tắc kiểm tra tự động " +
      "hay định dạng đầu ra ở phần Skill thì làm theo phần Skill.",
    ...guides.flatMap((g) => [
      "",
      `<team_guide name="${attr(g.name)}"${g.purpose.trim() ? ` purpose="${attr(g.purpose)}"` : ""}>`,
      g.content.replace(/<\/team_guide/gi, "<\\/team_guide").trim(),
      "</team_guide>",
    ]),
  ];
}

/**
 * The part of a stage's prompt that does not change between its calls: the brief, the team's rules and the inputs.
 * Chat replies about the stage's document start with exactly this (spec local-chat §3.1), so a prompt cache hit
 * covers it.
 */
export function studioPromptHead(request: StageRequest, workspaceDir: string, guides: readonly TeamGuide[] = []): string {
  const parts: string[] = [String(request.stage_config.__brief ?? "")];
  if (guides.length) parts.push("", ...teamGuidesSection(guides));
  parts.push("", "# Dữ liệu vào");
  const skill = String(request.stage_config.__skill ?? "");
  // The brief already carries what the seed had (and the approved R&D on top): one copy, the brief's.
  const hasBrief = request.inputs.some((x) => x.type === STUDIO_TYPES.brief);
  for (const input of request.inputs) {
    if (input.kind === "directory") continue;
    if (input.type === STUDIO_TYPES.seed && hasBrief) continue;
    const path = join(workspaceDir, input.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    let body = text;
    let heading = input.type;
    if (input.type === STUDIO_TYPES.catalog && CATALOG_SUMMARY_SKILLS.has(skill)) {
      try {
        body = JSON.stringify(summarizeCatalog(StudioCatalogSchema.parse(JSON.parse(text))), null, 2);
        heading = "studio_catalog_summary";
      } catch { /* leave as-is */ }
    } else if (input.type === STUDIO_TYPES.catalog) {
      // Compact v2: header line + one asset per line (omit empty fields)
      try {
        const cat = JSON.parse(text) as { assets?: unknown[]; [k: string]: unknown };
        const assets = cat.assets ?? [];
        body = [compactCatalogLine({ ...cat, assets: undefined }), ...assets.map((a) => compactCatalogLine(a))].join("\n");
      } catch { /* leave as-is */ }
    } else if (input.type === STUDIO_TYPES.research) {
      try {
        body = JSON.stringify(compactResearch(JSON.parse(text) as ResearchLike), null, 2);
      } catch { /* leave as-is */ }
    }
    parts.push("", `## ${heading} (${input.path.split("/").pop()})`, "```json", body.trim(), "```");
  }
  return parts.join("\n");
}

/** What the stage asks for after the head: the output, and in the repair round what the check refused. */
export function studioPromptTail(problems: StudioProblem[] | null): string {
  const parts = ["# Đầu ra", "Trả lời bằng đúng một đối tượng JSON khớp JSON Schema đã cho. Không viết gì ngoài JSON đó."];
  if (problems) {
    parts.push("", "# Lần trả lời trước bị hệ thống kiểm tra từ chối", "Sửa đúng các lỗi sau rồi trả lại toàn bộ đối tượng JSON:",
      ...problems.map((p) => `- [${p.code}] ${p.message}`));
  }
  return parts.join("\n");
}

export function studioPrompt(request: StageRequest, workspaceDir: string, problems: StudioProblem[] | null, guides: readonly TeamGuide[] = []): string {
  return `${studioPromptHead(request, workspaceDir, guides)}

${studioPromptTail(problems)}`;
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

    let guides: TeamGuide[] = [];
    if (this.opts.teamGuidesFor) {
      try {
        guides = teamGuidesForStep(await this.opts.teamGuidesFor(request), STUDIO_SKILL_STEP[skill]);
      } catch (e) {
        return failed("transient", `could not read the team's skills: ${e instanceof Error ? e.message : String(e)}`, { skill });
      }
    }

    const last: { trace: AgentCallTrace | null } = { trace: null };
    const runtime = this.opts.runtimeFor(JSON.stringify(claudeOutputJsonSchema(skill)), skill, (t) => { last.trace = t; });
    const validator = VALIDATORS[skill];
    const backoff = this.opts.rateLimitBackoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    const deadline = Date.parse(request.limits.deadline_at);
    const record = async (round: number, outcome: StudioLlmCall["outcome"], problems: StudioProblem[] = [], warnings: StudioProblem[] = []) => {
      const trace = last.trace;
      last.trace = null;
      if (!trace || !this.opts.recordCall) return;
      try {
        await this.opts.recordCall({
          run_id: request.run_id, stage_key: request.stage_key, attempt_id: request.attempt_id, skill, round, outcome, problems, warnings, trace,
        });
      } catch (e) {
        ctx.logger.warn("could not record the Claude call", { skill, round, error: e instanceof Error ? e.message : String(e) });
      }
    };

    let cost = 0;
    let problems: StudioProblem[] | null = null;
    let waits = 0;
    for (let round = 0; round < 2;) {
      rmSync(outPath, { force: true });
      const brief = studioPrompt(request, ctx.workspaceDir, problems, guides);
      const result = await runtime.runTask({ skill, brief, request, workspaceDir: ctx.workspaceDir }, ctx);
      cost += result.usage.cost_usd;
      const err = result.errors[0];
      if (result.outcome !== "succeeded") {
        if (err?.details?.code === "RATE_LIMITED") {
          await record(round, "rate_limited");
          const wait = backoff[Math.min(waits, backoff.length - 1)]!;
          if (Date.parse(ctx.clock.now()) + wait >= deadline) return failed("transient", "Claude rate limit did not reset before the stage deadline", { code: "RATE_LIMITED", waits }, cost);
          ctx.logger.warn("Claude subscription limit; waiting before retry (not counted as attempt)", { wait_ms: wait, waits });
          waits++;
          await sleep(wait, ctx.signal);
          if (ctx.signal?.aborted) return failed("transient", "stage aborted while waiting for the Claude limit", { code: "RATE_LIMITED" }, cost);
          continue;
        }
        await record(round, "failed", [{ code: String(err?.details?.code ?? "agent_failed"), message: err?.message ?? "agent call failed" }]);
        return { ...result, usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost } };
      }
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(outPath, "utf8")); }
      catch (e) {
        await record(round, "failed", [{ code: "no_json", message: `Claude returned no JSON for ${out.name}` }]);
        return failed("contract", `Claude returned no JSON for ${out.name}`, { error: String(e) }, cost);
      }
      const checkerInput = { request, result, workspaceDir: ctx.workspaceDir } as CheckerInput;
      let verdict: StudioValidation<unknown>;
      try { verdict = validator(raw, checkerInput); }
      catch (e) {
        const message = `cannot validate ${out.name}: ${e instanceof Error ? e.message : String(e)}`;
        await record(round, "failed", [{ code: "validator_error", message }]);
        return failed("contract", message, {}, cost);
      }
      if (verdict.ok) {
        // warnings never block; just log them
        if (verdict.warnings.length) ctx.logger.warn("Studio agent output has warnings", { skill, warnings: verdict.warnings.map((w) => w.message) });
        ctx.logger.info("Studio agent output accepted", { skill, repaired: round > 0 });
        await record(round, "accepted", [], verdict.warnings);
        return { ...result, usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: cost } };
      }
      await record(round, "rejected", verdict.problems, verdict.warnings);
      problems = verdict.problems;
      ctx.logger.warn("Studio agent output rejected by the deterministic check", { skill, round, problems: problems.length });
      round++;
    }
    return failed("contract", `${skill}: output still invalid after one repair round`, { problems }, cost);
  }
}
