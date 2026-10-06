/**
 * Checkers for the GĐ2 Studio series workflows.
 *
 * Each checker reads the stage output (by output type) and the inputs it was judged against (by input type).
 * On failure the evidence carries `problems` — the same list the agent executor feeds back to Claude and the
 * API returns to the web when a gate submit is refused.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  StudioBrandingSchema, StudioBriefSchema, StudioCatalogSchema, StudioEpisodeSchema, StudioExportSchema, StudioSeedSchema, StudioThumbnailsSchema,
  StoredTimelineSchema,
  TrendReportSchema,
  type CatalogAsset, type Checker, type CheckerInput, type StudioBranding, type StudioBrief, type StudioCatalog, type StudioSeed,
} from "@harness/contracts";
import { childEnvWithoutSecrets } from "../media/child-env.js";
import { layoutTimeline, timelineIssues } from "../studio/layout.js";
import {
  validateBranding, validateRnd, validateSeriesPlan, validateTrendReport, validateYoutubeKit, type StudioValidation,
} from "../studio/validate.js";

// ---------------------------------------------------------------------------
// Artifact type names (workflow stage defs and checkers must agree)
// ---------------------------------------------------------------------------

export const STUDIO_TYPES = {
  seed: "studio_seed",
  rnd: "studio_rnd",
  branding: "studio_branding",
  brief: "studio_brief",
  research: "studio_research",
  trendReport: "trend_report",
  catalog: "studio_catalog",
  seriesPlan: "series_plan",
  episodes: "studio_episodes",
  episode: "studio_episode",
  timeline: "timeline_v3",
  /** Timeline v4 of a shot-cut episode (`ag-studio-episode-cut`). */
  timelineV4: "timeline_v4",
  youtubeKit: "youtube_kit",
  finalVideo: "final_video",
  renderManifest: "render_manifest",
  thumbnail: "thumbnail",
  thumbnailSet: "thumbnail_set",
  thumbnails: "studio_thumbnails",
  youtube: "studio_youtube",
  export: "studio_export",
} as const;

/** A timeline artifact of either version, in the order a stage or checker looks for them. */
export const STUDIO_TIMELINE_TYPES = [STUDIO_TYPES.timeline, STUDIO_TYPES.timelineV4] as const;

export class StudioInputError extends Error {}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function outputPath(input: CheckerInput, type: string): string | null {
  const o = input.result.outputs.find((x) => x.type === type);
  return o ? join(input.workspaceDir, o.path) : null;
}

export function inputPath(input: Pick<CheckerInput, "request" | "workspaceDir">, type: string): string | null {
  const i = input.request.inputs.find((x) => x.type === type);
  return i ? join(input.workspaceDir, i.path) : null;
}

function requireInput<T>(input: CheckerInput, type: string, parse: (v: unknown) => T): T {
  const p = inputPath(input, type);
  if (!p || !existsSync(p)) throw new StudioInputError(`missing input ${type}`);
  return parse(readJson(p));
}

export const loadBrief = (i: CheckerInput): StudioBrief => requireInput(i, STUDIO_TYPES.brief, (v) => StudioBriefSchema.parse(v));
export const loadCatalog = (i: CheckerInput): StudioCatalog => requireInput(i, STUDIO_TYPES.catalog, (v) => StudioCatalogSchema.parse(v));
export const loadSeed = (i: CheckerInput): StudioSeed => requireInput(i, STUDIO_TYPES.seed, (v) => StudioSeedSchema.parse(v));
/** The branding input when the stage has one (episode runs of a production planned before branding have none). */
export function loadOptionalBranding(i: Pick<CheckerInput, "request" | "workspaceDir">): StudioBranding | null {
  const p = inputPath(i, STUDIO_TYPES.branding);
  return p && existsSync(p) ? StudioBrandingSchema.parse(readJson(p)) : null;
}

type Verdict = Awaited<ReturnType<Checker["check"]>>;

function fromValidation(v: StudioValidation<unknown>): Verdict {
  return v.ok ? { verdict: "pass", evidence: { warnings: v.warnings } } : { verdict: "fail", evidence: { problems: v.problems } };
}

function documentChecker(id: string, outputType: string | readonly string[], validate: (raw: unknown, input: CheckerInput) => Verdict): Checker {
  const types = typeof outputType === "string" ? [outputType] : outputType;
  return {
    id, version: "1.0.0",
    async check(input) {
      if (input.result.outcome === "deferred") return { verdict: "skip", evidence: { reason: "gate waiting for input" } };
      const p = types.map((t) => outputPath(input, t)).find((x) => x !== null) ?? null;
      if (!p || !existsSync(p)) return { verdict: "fail", evidence: { reason: `no ${types.join(" or ")} output` } };
      let raw: unknown;
      try { raw = readJson(p); } catch (e) { return { verdict: "fail", evidence: { reason: "output is not JSON", error: String(e) } }; }
      try { return validate(raw, input); }
      catch (e) {
        if (e instanceof StudioInputError) return { verdict: "fail", evidence: { reason: e.message } };
        throw e;
      }
    },
  };
}

export const trendReportValidChecker = documentChecker("trend-report-valid", STUDIO_TYPES.trendReport,
  (raw) => fromValidation(validateTrendReport(raw)));

export const seriesPlanValidChecker = documentChecker("series-plan-valid", STUDIO_TYPES.seriesPlan,
  (raw, i) => {
    const brief = loadBrief(i);
    const catalog = loadCatalog(i);
    return fromValidation(validateSeriesPlan(raw, { brief, catalog: catalog.assets }));
  });

export const youtubeKitValidChecker = documentChecker("youtube-kit-valid", STUDIO_TYPES.youtubeKit,
  (raw, i) => {
    const episode = requireInput(i, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
    return fromValidation(validateYoutubeKit(raw, { episode, branding: loadOptionalBranding(i) }));
  });

export const rndValidChecker = documentChecker("rnd-valid", STUDIO_TYPES.rnd,
  (raw, i) => fromValidation(validateRnd(raw, { seed: loadSeed(i) })));

export const brandingValidChecker = documentChecker("branding-valid", STUDIO_TYPES.branding,
  (raw) => fromValidation(validateBranding(raw)));

export const timelineSchemaValidChecker = documentChecker("timeline-schema-valid", STUDIO_TIMELINE_TYPES, (raw) => {
  const r = StoredTimelineSchema.safeParse(raw);
  if (!r.success) return { verdict: "fail", evidence: { problems: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  return { verdict: "pass", evidence: { issues: timelineIssues(r.data) } };
});

export const timelineValidChecker = documentChecker("timeline-valid", STUDIO_TIMELINE_TYPES, (raw) => {
  const r = StoredTimelineSchema.safeParse(raw);
  if (!r.success) return { verdict: "fail", evidence: { problems: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  const errors = timelineIssues(r.data).filter((x) => x.severity === "error");
  return errors.length ? { verdict: "fail", evidence: { problems: errors } } : { verdict: "pass", evidence: {} };
});

export const STUDIO_LOUDNESS_MIN_LUFS = -16;
export const STUDIO_LOUDNESS_MAX_LUFS = -12;
export const STUDIO_SILENT_LUFS = -50;
export const STUDIO_DURATION_TOLERANCE_S = 0.5;

export function measureIntegratedLufs(ffmpeg: string, file: string): number | null {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000, env: childEnvWithoutSecrets() });
  if (r.status !== 0) return null;
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(r.stderr ?? "");
  if (!m) return null;
  const v = Number((JSON.parse(m[0]) as { input_i: string }).input_i);
  return Number.isFinite(v) ? v : null;
}

export function studioRenderValidChecker(opts: { ffmpeg?: string } = {}): Checker {
  return {
    id: "studio-render-valid", version: "2.0.0",
    async check(input) {
      const video = outputPath(input, STUDIO_TYPES.finalVideo);
      const manifestPath = outputPath(input, STUDIO_TYPES.renderManifest);
      if (!video || !existsSync(video)) return { verdict: "fail", evidence: { reason: "no final video" } };
      if (!manifestPath || !existsSync(manifestPath)) return { verdict: "fail", evidence: { reason: "no render manifest" } };
      const m = readJson(manifestPath) as { schema?: string; width?: number; height?: number; duration_s?: number; size_bytes?: number; watermarked?: boolean; thumbnails?: unknown[] };
      const tlPath = STUDIO_TIMELINE_TYPES.map((type) => inputPath(input, type)).find((x) => x !== null) ?? null;
      if (!tlPath || !existsSync(tlPath)) return { verdict: "fail", evidence: { reason: "no timeline input" } };
      const t = StoredTimelineSchema.parse(readJson(tlPath));
      const expected = layoutTimeline(t).duration;
      const problems: string[] = [];
      if (m.schema !== "ag.studio.render/v1") problems.push(`render.json schema ${String(m.schema)}`);
      if (m.width !== t.canvas.width || m.height !== t.canvas.height) problems.push(`khung ${m.width}x${m.height}, cần ${t.canvas.width}x${t.canvas.height}`);
      if (typeof m.duration_s !== "number" || Math.abs(m.duration_s - expected) > STUDIO_DURATION_TOLERANCE_S) problems.push(`dài ${m.duration_s?.toFixed(2)}s, timeline ${expected.toFixed(2)}s`);
      if (statSync(video).size !== m.size_bytes) problems.push("kích thước file không khớp render.json");
      // Thumbnails: the render must deliver as many .jpg outputs as the payload asked for
      const thumbOutputs = input.result.outputs.filter((o) => o.type === STUDIO_TYPES.thumbnail);
      const manifestThumbs = (m.thumbnails ?? []) as unknown[];
      if (thumbOutputs.length !== manifestThumbs.length) {
        problems.push(`yêu cầu ${manifestThumbs.length} thumbnail nhưng nhận được ${thumbOutputs.length}`);
      }
      let lufs: number | null = null;
      if (opts.ffmpeg) {
        lufs = measureIntegratedLufs(opts.ffmpeg, video);
        const silentOk = !t.music;
        if (silentOk && (lufs === null || lufs <= STUDIO_SILENT_LUFS)) lufs = null;
        else if (lufs === null) problems.push("không đo được loudness");
        else if (lufs < STUDIO_LOUDNESS_MIN_LUFS || lufs > STUDIO_LOUDNESS_MAX_LUFS) problems.push(`loudness ${lufs} LUFS ngoài [${STUDIO_LOUDNESS_MIN_LUFS}, ${STUDIO_LOUDNESS_MAX_LUFS}]`);
      }
      const evidence = { duration_s: m.duration_s, expected_s: expected, integrated_lufs: lufs, loudness_checked: !!opts.ffmpeg, watermarked: m.watermarked ?? null };
      return problems.length ? { verdict: "fail", evidence: { ...evidence, problems } } : { verdict: "pass", evidence };
    },
  };
}

export const exportValidChecker = documentChecker("export-valid", STUDIO_TYPES.export, (raw) => {
  const r = StudioExportSchema.safeParse(raw);
  if (!r.success) return { verdict: "fail", evidence: { problems: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  const kinds = new Set(r.data.files.map((f) => f.kind));
  // the YouTube pack is built when someone downloads it (ag-studio-episode@1.2.0); older exports also hold one
  const missing = (["mp4", "youtube"] as const).filter((k) => !kinds.has(k));
  return missing.length ? { verdict: "fail", evidence: { missing } } : { verdict: "pass", evidence: { files: r.data.files.length } };
});

/** The thumbnails of a render: the manifest reads, there is at least one frame, and every listed file is there. */
export const thumbnailsValidChecker = documentChecker("thumbnails-valid", STUDIO_TYPES.thumbnails, (raw, i) => {
  const r = StudioThumbnailsSchema.safeParse(raw);
  if (!r.success) return { verdict: "fail", evidence: { problems: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  const dir = outputPath(i, STUDIO_TYPES.thumbnailSet);
  const files = [...r.data.frames.map((f) => f.file), ...r.data.suggestions.map((s) => s.file)];
  const missing = dir ? files.filter((f) => !existsSync(join(dir, f))) : files;
  const problems = [
    ...(r.data.frames.length ? [] : ["không cắt được khung hình nào"]),
    ...missing.map((f) => `thiếu file ${f}`),
  ];
  return problems.length ? { verdict: "fail", evidence: { problems } } : { verdict: "pass", evidence: { frames: r.data.frames.length, suggestions: r.data.suggestions.length } };
});

export function studioCheckers(opts: { ffmpeg?: string } = {}): Checker[] {
  return [
    trendReportValidChecker,
    rndValidChecker,
    brandingValidChecker,
    seriesPlanValidChecker,
    youtubeKitValidChecker,
    timelineSchemaValidChecker,
    timelineValidChecker,
    studioRenderValidChecker(opts),
    exportValidChecker,
    thumbnailsValidChecker,
  ];
}
