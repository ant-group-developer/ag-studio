/**
 * Checkers of `ag-studio-production@1.0.0` (GĐ4). They read the stage's own output (by output type) and the
 * inputs it was judged against (by input type), and fail with the same problem list the Studio agent executor
 * feeds back to Claude and the API returns to the web on a refused gate submit.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  StudioBriefSchema, StudioCatalogSchema, StudioExportSchema, TimelineV2Schema, TreatmentSchema,
  type Checker, type CheckerInput, type StudioBrief, type StudioCatalog, type Treatment,
} from "@harness/contracts";
import { childEnvWithoutSecrets } from "../media/child-env.js";
import { layoutTimeline, timelineIssues } from "../studio/layout.js";
import { validateNarration, validateSelection, validateTreatment, type StudioValidation } from "../studio/validate.js";

/** Artifact types the workflow gives Studio documents; stage definitions and checkers must agree on them. */
export const STUDIO_TYPES = {
  brief: "studio_brief",
  catalog: "studio_catalog",
  treatment: "treatment",
  selection: "selection",
  narration: "studio_narration",
  ttsManifest: "tts_manifest",
  voiceSet: "voice_set",
  timeline: "timeline_v2",
  finalVideo: "final_video",
  renderManifest: "render_manifest",
  export: "studio_export",
  subtitles: "subtitles",
} as const;

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
export const loadTreatment = (i: CheckerInput): Treatment => requireInput(i, STUDIO_TYPES.treatment, (v) => TreatmentSchema.parse(v));

type Verdict = Awaited<ReturnType<Checker["check"]>>;

function fromValidation(v: StudioValidation<unknown>): Verdict {
  return v.ok ? { verdict: "pass", evidence: {} } : { verdict: "fail", evidence: { problems: v.problems } };
}

function documentChecker(id: string, outputType: string, validate: (raw: unknown, input: CheckerInput) => Verdict): Checker {
  return {
    id, version: "1.0.0",
    async check(input) {
      // A gate parked for a person has produced nothing yet: there is nothing to judge (and "fail" here
      // would show up in the web as an error under a gate that is simply waiting).
      if (input.result.outcome === "deferred") return { verdict: "skip", evidence: { reason: "gate waiting for input" } };
      const p = outputPath(input, outputType);
      if (!p || !existsSync(p)) return { verdict: "fail", evidence: { reason: `no ${outputType} output` } };
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

export const treatmentValidChecker = documentChecker("treatment-valid", STUDIO_TYPES.treatment,
  (raw, i) => fromValidation(validateTreatment(raw, loadBrief(i))));

export const selectionValidChecker = documentChecker("selection-valid", STUDIO_TYPES.selection,
  (raw, i) => fromValidation(validateSelection(raw, { brief: loadBrief(i), catalog: loadCatalog(i), treatment: loadTreatment(i) })));

export const narrationValidChecker = documentChecker("narration-valid", STUDIO_TYPES.narration,
  (raw, i) => fromValidation(validateNarration(raw, { brief: loadBrief(i), treatment: loadTreatment(i) })));

/** `build-timeline`: a draft may still carry issues for the editor to fix; only its shape is checked here. */
export const timelineSchemaValidChecker = documentChecker("timeline-schema-valid", STUDIO_TYPES.timeline, (raw) => {
  const parsed = TimelineV2Schema.safeParse(raw);
  if (!parsed.success) return { verdict: "fail", evidence: { problems: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  return { verdict: "pass", evidence: { issues: timelineIssues(parsed.data) } };
});

/** `edit` gate and before the final render: no `error` issue may remain. */
export const timelineValidChecker = documentChecker("timeline-valid", STUDIO_TYPES.timeline, (raw, i) => {
  const parsed = TimelineV2Schema.safeParse(raw);
  if (!parsed.success) return { verdict: "fail", evidence: { problems: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  const brief = loadBrief(i);
  const t = parsed.data;
  const issues = timelineIssues(t);
  if (t.production_id !== brief.production_id) issues.push({ severity: "error", code: "wrong_production", message: `timeline của production ${t.production_id}, không phải ${brief.production_id}` });
  if (t.canvas.width !== brief.canvas.width || t.canvas.height !== brief.canvas.height) issues.push({ severity: "error", code: "wrong_canvas", message: "khung hình timeline khác brief" });
  const errors = issues.filter((x) => x.severity === "error");
  return errors.length ? { verdict: "fail", evidence: { problems: errors } } : { verdict: "pass", evidence: { warnings: issues } };
});

/** Delivered loudness band (same targets as harness `render-valid`, spec §6.2). */
export const STUDIO_LOUDNESS_MIN_LUFS = -16;
export const STUDIO_LOUDNESS_MAX_LUFS = -12;
/** Picture length may differ from the timeline by this much (encoder frame rounding). */
export const STUDIO_DURATION_TOLERANCE_S = 0.5;

/** Integrated loudness of `file` via ffmpeg's `loudnorm` analysis pass; `null` when ffmpeg could not tell. */
export function measureIntegratedLufs(ffmpeg: string, file: string): number | null {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000, env: childEnvWithoutSecrets() });
  if (r.status !== 0) return null;
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(r.stderr ?? "");
  if (!m) return null;
  const v = Number((JSON.parse(m[0]) as { input_i: string }).input_i);
  return Number.isFinite(v) ? v : null;
}

/**
 * `studio-render-valid` (render-final + qc): the farm's `render.json` matches the file that came back, the
 * canvas and length match the timeline that was rendered, and -- when ffmpeg is on this node -- the loudness
 * sits in the delivery band.
 */
export function studioRenderValidChecker(opts: { ffmpeg?: string } = {}): Checker {
  return {
    id: "studio-render-valid", version: "1.0.0",
    async check(input) {
      const video = outputPath(input, STUDIO_TYPES.finalVideo);
      const manifestPath = outputPath(input, STUDIO_TYPES.renderManifest);
      if (!video || !existsSync(video)) return { verdict: "fail", evidence: { reason: "no final video" } };
      if (!manifestPath || !existsSync(manifestPath)) return { verdict: "fail", evidence: { reason: "no render manifest" } };
      const m = readJson(manifestPath) as { schema?: string; width?: number; height?: number; duration_s?: number; size_bytes?: number; watermarked?: boolean };
      const tlPath = inputPath(input, STUDIO_TYPES.timeline);
      if (!tlPath || !existsSync(tlPath)) return { verdict: "fail", evidence: { reason: "no timeline input" } };
      const t = TimelineV2Schema.parse(readJson(tlPath));
      const expected = layoutTimeline(t).duration;
      const problems: string[] = [];
      if (m.schema !== "ag.studio.render/v1") problems.push(`render.json schema ${String(m.schema)}`);
      if (m.width !== t.canvas.width || m.height !== t.canvas.height) problems.push(`khung ${m.width}x${m.height}, cần ${t.canvas.width}x${t.canvas.height}`);
      if (typeof m.duration_s !== "number" || Math.abs(m.duration_s - expected) > STUDIO_DURATION_TOLERANCE_S) problems.push(`dài ${m.duration_s}s, timeline ${expected}s`);
      const size = statSync(video).size;
      if (m.size_bytes !== size) problems.push(`file ${size} byte, render.json ghi ${m.size_bytes}`);
      let lufs: number | null = null;
      if (opts.ffmpeg) {
        lufs = measureIntegratedLufs(opts.ffmpeg, video);
        if (lufs === null) problems.push("không đo được loudness");
        else if (lufs < STUDIO_LOUDNESS_MIN_LUFS || lufs > STUDIO_LOUDNESS_MAX_LUFS) problems.push(`loudness ${lufs} LUFS ngoài [${STUDIO_LOUDNESS_MIN_LUFS}, ${STUDIO_LOUDNESS_MAX_LUFS}]`);
      }
      const evidence = { duration_s: m.duration_s, expected_s: expected, integrated_lufs: lufs, loudness_checked: !!opts.ffmpeg, watermarked: m.watermarked ?? null };
      return problems.length ? { verdict: "fail", evidence: { ...evidence, problems } } : { verdict: "pass", evidence };
    },
  };
}

export const exportValidChecker = documentChecker("export-valid", STUDIO_TYPES.export, (raw) => {
  const parsed = StudioExportSchema.safeParse(raw);
  if (!parsed.success) return { verdict: "fail", evidence: { problems: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) } };
  const kinds = new Set(parsed.data.files.map((f) => f.kind));
  const missing = (["mp4", "srt"] as const).filter((k) => !kinds.has(k));
  return missing.length ? { verdict: "fail", evidence: { missing } } : { verdict: "pass", evidence: { files: parsed.data.files.length } };
});

export function studioCheckers(opts: { ffmpeg?: string } = {}): Checker[] {
  return [treatmentValidChecker, selectionValidChecker, narrationValidChecker, timelineSchemaValidChecker, timelineValidChecker, studioRenderValidChecker(opts), exportValidChecker];
}
