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
  claudeOutputJsonSchema, STUDIO_FILE_SKILLS, STUDIO_SKILL_OUTPUTS, STUDIO_SKILL_STEP, teamGuidesForStep, TrendReportSchema, StudioStyleSchema, StudioWebFindsSchema,
  type AgentCallTrace, type AgentRuntime, type CheckerInput, type StudioChatSkill, type Executor, type ExecutorContext, type StageRequest, type StageResult, type StudioSkill,
  type TeamGuide,
} from "@harness/contracts";
import {
  hasGaps, isFollowUpWarning, loadBrief, loadCatalog, loadOptionalBranding, loadOptionalStyle, loadOptionalStyleWatch, loadOptionalTimelineV4, loadSeed, loadShots, loadSurvey, researchGapsOf, STUDIO_TYPES,
  summarizeCatalog, validateBranding, validateEditPlan, validateRnd, validateSeriesPlan, validateStudioSurvey, validateStyle, validateTrendReport,
  validateWebFinds, validateYoutubeKit,
  type StudioProblem, type StudioValidation,
} from "@harness/core";
import { StudioCatalogSchema, StudioEpisodeSchema, StudioSurveySchema, type StudioSurvey } from "@harness/contracts";

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
  runtimeFor: (jsonSchema: string, skill?: StudioSkill, onCall?: (trace: AgentCallTrace) => void, files?: { resume?: string }) => AgentRuntime;
  /** Files-mode skills (`STUDIO_FILE_SKILLS`): the CLI session of each call, to resume it (repair round, chat). */
  onSession?: (request: StageRequest, sessionId: string) => void | Promise<void>;
  /** Keeps each call; a failure here is logged and never fails the stage. */
  recordCall?: (call: StudioLlmCall) => Promise<void>;
  rateLimitBackoffMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Every enabled skill of the team the run works for; the executor keeps the ones of its step. A failure to read
   *  them fails the attempt as transient (a call without the team's rules would be a different answer). */
  teamGuidesFor?: (request: StageRequest) => TeamGuide[] | Promise<TeamGuide[]>;
  /** What a person said in the chat about this stage's refused answer, oldest first, for running it again. */
  feedbackFor?: (request: StageRequest) => string[] | Promise<string[]>;
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
  "studio-source-survey": (raw, i) => validateStudioSurvey(raw, { shots: loadShots(i) }),
  "studio-edit-plan": (raw, i) => followUpsAsProblems(validateEditPlan(raw, { survey: loadSurvey(i), shots: loadShots(i), style: loadOptionalStyle(i) })),
  "studio-youtube-kit": (raw, i) => {
    const episodePath = i.request.inputs.find((x) => x.type === STUDIO_TYPES.episode);
    if (!episodePath) return { ok: false, value: undefined, problems: [{ code: "missing_input", message: "missing studio_episode input" }], warnings: [] };
    const episodeRaw = JSON.parse(readFileSync(join(i.workspaceDir, episodePath.path), "utf8"));
    const episode = StudioEpisodeSchema.parse(episodeRaw);
    return followUpsAsProblems(validateYoutubeKit(raw, { episode, branding: loadOptionalBranding(i), timeline: loadOptionalTimelineV4(i) }));
  },
  "studio-web-research": (raw, i) => validateWebFinds(raw, { gaps: researchGapsOf(i) }),
  "studio-style": (raw, i) => followUpsAsProblems(validateStyle(raw, { watch: loadOptionalStyleWatch(i) })),
};

/**
 * The check a stage's answer must pass, for anything else that writes the same document (a chat reply proposing a
 * new version): `raw` against the inputs of `request` materialised in `workspaceDir`.
 */
export function studioValidator(skill: StudioSkill): (raw: unknown, request: StageRequest, workspaceDir: string) => StudioValidation<unknown> {
  const v = VALIDATORS[skill];
  return (raw, request, workspaceDir) => v(raw, { request, workspaceDir } as CheckerInput);
}

/**
 * Skills that read the production's edit style (series plan 3.2.0, cut 1.1.0). A stage of another skill may have it
 * among its inputs (every stage after the episode intake does): its prompt leaves it out, as before the style.
 */
const STYLE_PROMPT_SKILLS = new Set<string>(["studio-branding", "studio-plan-episodes", "studio-edit-plan"]);

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

/**
 * The scene selection as the YouTube kit reads it (cut 1.1.0): what Claude saw in each shot the approved cut uses —
 * truer than ag-go's AI titles in the episode. Every shot when there is no cut to go by.
 */
export function surveyForKit(survey: StudioSurvey, timeline: { clips: readonly { shot_id: string | null }[] } | null) {
  const used = timeline ? new Set(timeline.clips.map((c) => c.shot_id).filter((x): x is string => !!x)) : null;
  return {
    shots: survey.shots.filter((s) => !used || used.has(s.shot_id))
      .map((s) => ({ shot_id: s.shot_id, usable: s.usable, score: s.score, tags: s.tags, note: s.note })),
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
    if (input.type === STUDIO_TYPES.style && !STYLE_PROMPT_SKILLS.has(skill)) continue;
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
    } else if (input.type === STUDIO_TYPES.surveyIndex && skill === "studio-youtube-kit") {
      try {
        body = JSON.stringify(surveyForKit(StudioSurveySchema.parse(JSON.parse(text)), loadOptionalTimelineV4({ request, workspaceDir })), null, 2);
      } catch { /* leave as-is */ }
    } else if (input.type === STUDIO_TYPES.researchApi && skill === "studio-web-research") {
      // the web research is told only what is missing, not what the API already found
      try {
        body = JSON.stringify(researchGapsOf({ request, workspaceDir } as CheckerInput), null, 2);
        heading = "research_gaps";
      } catch { /* leave as-is */ }
    }
    parts.push("", `## ${heading} (${input.path.split("/").pop()})`, "```json", body.trim(), "```");
  }
  const dirs = request.inputs.filter((x) => x.kind === "directory");
  if (dirs.length) {
    parts.push("", "## Thư mục trong thư mục làm việc", "Mở các tệp trong đó bằng công cụ đọc tệp (ảnh xem được trực tiếp).",
      ...dirs.map((x) => `- ${x.type}: ${x.path}/`));
  }
  return parts.join("\n");
}

/** Files-mode output: the agent writes the file itself (no JSON on stdout). */
export function studioFilesPromptTail(outName: string): string {
  return [
    "# Đầu ra",
    `Ghi đúng một tệp \`output/${outName}\` (JSON đúng định dạng đầu ra của skill). Chỉ đọc tệp trong thư mục làm việc này, không dùng mạng.`,
    "Bạn chỉ có Read, Write, Glob, Grep: không có Bash, không chạy được Python hay script nào. Tự viết toàn bộ JSON rồi ghi bằng **một** lệnh Write, kể cả khi tệp dài.",
    "Ghi xong thì trả lời một dòng ngắn nói đã ghi.",
  ].join("\n");
}

/** The repair round of a files-mode stage, sent into the resumed session (which already holds everything else). */
export function studioFilesRepairPrompt(outName: string, problems: StudioProblem[]): string {
  return [
    `# Tệp output/${outName} bị hệ thống kiểm tra từ chối`,
    "Sửa đúng các lỗi sau rồi ghi lại toàn bộ tệp:",
    ...problems.map((p) => `- [${p.code}] ${p.message}`),
  ].join("\n");
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

/**
 * A stage's prompt. `feedback`: what a person said in the chat about the stage's last answer when running it again
 * (spec local-chat); none = exactly the stage's usual prompt.
 */
export function studioPrompt(
  request: StageRequest, workspaceDir: string, problems: StudioProblem[] | null, guides: readonly TeamGuide[] = [], feedback: readonly string[] = [],
): string {
  const parts = [studioPromptHead(request, workspaceDir, guides)];
  if (feedback.length) {
    parts.push([
      "# Góp ý của người dùng",
      "Lần trước câu trả lời của bước này bị từ chối; người dùng góp ý như sau, làm theo:",
      ...feedback.map((f) => `- ${f.trim().replace(/\r?\n/g, "\n  ")}`),
    ].join("\n"));
  }
  parts.push(studioPromptTail(problems));
  return parts.join("\n\n");
}

/** A files-mode stage's prompt: the same head (inputs inlined, folders listed), then where to write the answer. */
export function studioFilesPrompt(
  request: StageRequest, workspaceDir: string, outName: string, problems: StudioProblem[] | null,
  guides: readonly TeamGuide[] = [], feedback: readonly string[] = [],
): string {
  const parts = [studioPromptHead(request, workspaceDir, guides)];
  if (feedback.length) {
    parts.push(["# Góp ý của người dùng", "Lần trước câu trả lời của bước này bị từ chối; người dùng góp ý như sau, làm theo:",
      ...feedback.map((f) => `- ${f.trim().replace(/\r?\n/g, "\n  ")}`)].join("\n"));
  }
  parts.push(studioFilesPromptTail(outName));
  if (problems) parts.push(studioFilesRepairPrompt(outName, problems));
  return parts.join("\n\n");
}

type ResearchSeen = {
  skipped_reason?: string | null;
  channels?: Array<{ input?: string; error?: string | null; videos?: unknown[] }>;
  keywords?: Array<{ keyword?: string; error?: string | null; videos?: unknown[] }>;
};

/**
 * Why research found nothing, for the person reading the skipped trend report: the reason it was skipped, or what
 * YouTube refused for each channel and keyword.
 */
export function researchSkipSummary(res: ResearchSeen): string {
  const why = res.skipped_reason?.trim() || [
    ...(res.channels ?? []).filter((c) => c.error).map((c) => `kênh ${c.input ?? "?"}: ${c.error}`),
    ...(res.keywords ?? []).filter((k) => k.error).map((k) => `từ khoá "${k.keyword ?? "?"}": ${k.error}`),
  ].join("; ");
  return (why ? `Không có dữ liệu nghiên cứu: ${why}` : "Không có dữ liệu nghiên cứu.").slice(0, 3000);
}

/** A skipped trend report (no research videos), saying why. */
function skippedTrendReport(summary: string): unknown {
  return TrendReportSchema.parse({
    schema_version: "studio.trend-report/v1",
    skipped: true, summary,
    working_angles: [], title_patterns: [], hook_patterns: [], thumbnail_patterns: [],
    recommended_duration_s: null, posting_schedule: "", recommendations: [],
  });
}

/**
 * The document a stage writes WITHOUT calling Claude, when there is nothing for Claude to do: a trend report with no
 * research videos, a web research with nothing missing. `null`: call Claude. An input it cannot read means Claude
 * is called (and the validator says what is wrong).
 */
function skippedOutput(skill: StudioSkill, request: StageRequest, workspaceDir: string): { doc: unknown; why: string } | null {
  try {
    if (skill === "studio-trend-report") {
      const resPath = request.inputs.find((x) => x.type === STUDIO_TYPES.research);
      if (!resPath) return null;
      const res = JSON.parse(readFileSync(join(workspaceDir, resPath.path), "utf8")) as ResearchSeen;
      const totalVideos = (res.channels ?? []).reduce((n, ch) => n + (ch.videos?.length ?? 0), 0)
        + (res.keywords ?? []).reduce((n, kw) => n + (kw.videos?.length ?? 0), 0);
      if (totalVideos > 0) return null;
      const summary = researchSkipSummary(res);
      return { doc: skippedTrendReport(summary), why: summary };
    }
    if (skill === "studio-web-research") {
      if (hasGaps(researchGapsOf({ request, workspaceDir } as CheckerInput))) return null;
      return { doc: StudioWebFindsSchema.parse({ schema_version: "studio.web-finds/v1", skipped: true, channels: [], keywords: [], sources: [] }), why: "nothing missing from the YouTube research" };
    }
    if (skill === "studio-style") {
      const watch = loadOptionalStyleWatch({ request, workspaceDir });
      if (watch?.measured && watch.videos.some((v) => !v.error)) return null;
      const why = watch?.skipped_reason ?? "Không xem được video mẫu nào";
      return {
        doc: StudioStyleSchema.parse({
          schema_version: "studio.style/v1", skipped: true, skipped_reason: why.slice(0, 500), name: "", summary: "",
          references: [], measured: null, params: null, do: [], dont: [], evidence: [],
        }),
        why,
      };
    }
  } catch { /* unreadable input: let Claude answer, the validator will say what is wrong */ }
  return null;
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

    // --- Nothing for Claude to do (a trend report without research videos, a web research with nothing missing) ---
    const skipped = skippedOutput(skill, request, ctx.workspaceDir);
    if (skipped) {
      mkdirSync(join(ctx.workspaceDir, "output"), { recursive: true });
      writeFileSync(outPath, JSON.stringify(skipped.doc, null, 2));
      ctx.logger.warn(`${skill} skipped without calling Claude`, { why: skipped.why });
      // Register the written file as an output so the harness stages it and checks pass.
      const bytes = readFileSync(outPath);
      const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      return {
        schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
        outputs: [{ path: `output/${out.name}`, type: out.type, checksum, size_bytes: bytes.length, kind: "file" as const }],
        checks: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
        external_operations: [], errors: [],
      };
    }

    let guides: TeamGuide[] = [];
    if (this.opts.teamGuidesFor) {
      try {
        guides = teamGuidesForStep(await this.opts.teamGuidesFor(request), STUDIO_SKILL_STEP[skill]);
      } catch (e) {
        return failed("transient", `could not read the team's skills: ${e instanceof Error ? e.message : String(e)}`, { skill });
      }
    }

    let feedback: string[] = [];
    if (this.opts.feedbackFor) {
      try { feedback = await this.opts.feedbackFor(request); }
      catch (e) { ctx.logger.warn("could not read the chat feedback; running without it", { error: e instanceof Error ? e.message : String(e) }); }
    }

    const last: { trace: AgentCallTrace | null } = { trace: null };
    const files = STUDIO_FILE_SKILLS.has(skill);
    const schema = JSON.stringify(claudeOutputJsonSchema(skill));
    const onCall = (t: AgentCallTrace) => { last.trace = t; };
    let runtime = this.opts.runtimeFor(schema, skill, onCall);
    let session: string | null = null;
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
      const brief = !files ? studioPrompt(request, ctx.workspaceDir, problems, guides, feedback)
        : problems && session ? studioFilesRepairPrompt(out.name, problems)
          : studioFilesPrompt(request, ctx.workspaceDir, out.name, problems, guides, feedback);
      const result = await runtime.runTask({ skill, brief, request, workspaceDir: ctx.workspaceDir }, ctx);
      cost += result.usage.cost_usd;
      if (files && last.trace?.session_id) {
        session = last.trace.session_id;
        try { await this.opts.onSession?.(request, session); }
        catch (e) { ctx.logger.warn("could not keep the Claude session", { error: e instanceof Error ? e.message : String(e) }); }
      }
      const err = result.errors[0];
      // a files-mode call that ended without the file (e.g. it reached for a Bash it does not have) already looked at
      // every picture: the repair round resumes that session to write it, rather than paying for the look again
      if (files && session && round === 0 && err?.details?.code === "NO_OUTPUT") {
        await record(round, "rejected", [{ code: "no_output", message: err.message }]);
        problems = [{ code: "no_output", message: `Chưa có tệp output/${out.name}. Không có Bash/Python: viết toàn bộ JSON rồi ghi bằng công cụ Write ngay.` }];
        ctx.logger.warn("Studio agent wrote no output; resuming its session to write it", { skill });
        runtime = this.opts.runtimeFor(schema, skill, onCall, { resume: session });
        round++;
        continue;
      }
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
      // a files-mode repair continues the session that looked at the pictures
      if (files && session) runtime = this.opts.runtimeFor(schema, skill, onCall, { resume: session });
      round++;
    }
    return failed("contract", `${skill}: output still invalid after one repair round`, { problems }, cost);
  }
}
