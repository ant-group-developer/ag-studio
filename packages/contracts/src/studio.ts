import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * AG Studio production documents (GĐ4, workflow `ag-studio-production@1.0.0`).
 *
 * Every file a stage of that workflow reads or writes is one of these. Claude only ever sees text: the
 * catalog is captions/tags written by the scan worker, never pictures. Times inside a segment are seconds
 * from the segment's own start (`src_in`/`src_out`); `start_ms`/`end_ms` place the segment inside its asset,
 * and only the composition sent to the render worker uses asset-absolute times.
 */
export function studioVersion<N extends string, V extends number = 1>(name: N, version: V = 1 as V) {
  return z.literal(`studio.${name}/v${version}` as const);
}

export const STUDIO_ASPECTS = ["16:9", "9:16"] as const;
export type StudioAspect = (typeof STUDIO_ASPECTS)[number];

/** A logical input the render worker asks Studio's `/farm/sign` for, e.g. `library:music/calm.mp3`. */
export const LibraryInputSchema = z.string().regex(/^library:[A-Za-z0-9._\-/]+$/, "expected library:<path>");
/** A key relative to `productions/<id>/` in the Studio bucket, e.g. `audio/<sha256>.wav`. */
export const ProductionKeySchema = z.string().regex(/^[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$/, "expected a relative key").refine(
  (v) => !v.split("/").some((s) => s === ".." || s === "."), "no . or .. segments",
);

export const StudioCanvasSchema = z.object({
  width: z.number().int().min(160).max(7680),
  height: z.number().int().min(160).max(7680),
}).strict();
export type StudioCanvas = z.infer<typeof StudioCanvasSchema>;

export const BEAT_ID = /^B\d{2}$/;
export const LINE_ID = /^L\d{3}$/;

export const StudioVoiceSchema = z.object({
  reference: LibraryInputSchema.nullable(),
  reference_text: z.string().max(2000).nullable(),
  speed: z.number().min(0.5).max(2),
}).strict();

export const StudioMusicSchema = z.object({
  track: LibraryInputSchema,
  gain_db: z.number().min(-40).max(0),
  ducking: z.boolean(),
}).strict();
export type StudioMusic = z.infer<typeof StudioMusicSchema>;

/** `brief.json` (`intake`): what the production asked for, frozen for the whole run. */
export const StudioBriefSchema = z.object({
  schema_version: studioVersion("brief"),
  production_id: z.string().min(1),
  run_id: z.string().min(1),
  /** Background stages act as this user towards ag-go (plan 3.1). */
  owner_user_id: z.string().min(1),
  title: z.string().min(1).max(200),
  topic: z.string().min(1).max(4000),
  folder_ids: z.array(z.string().min(1)).min(1).max(50),
  target_seconds: z.number().min(10).max(1800),
  aspect: z.enum(STUDIO_ASPECTS),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  voice: StudioVoiceSchema,
  music: StudioMusicSchema.nullable(),
}).strict();
export type StudioBrief = z.infer<typeof StudioBriefSchema>;

/** One footage segment as text (ag-go `/footage/catalog`, normalised). */
export const CatalogSegmentSchema = z.object({
  id: z.string().min(1),
  asset_id: z.string().min(1),
  start_ms: z.number().int().min(0),
  end_ms: z.number().int().min(0),
  duration_s: z.number().min(0),
  caption_vi: z.string(),
  caption_en: z.string(),
  tags: z.array(z.string()),
  keywords_vi: z.array(z.string()),
  subjects: z.array(z.string()),
  actions: z.array(z.string()),
  shot_size: z.string().nullable(),
  camera_motion: z.string().nullable(),
  time_of_day: z.string().nullable(),
  setting: z.string().nullable(),
  people_count: z.string().nullable(),
  orientation: z.string().nullable(),
  quality: z.number().nullable(),
  usable: z.boolean(),
  approved: z.boolean(),
}).strict();
export type CatalogSegment = z.infer<typeof CatalogSegmentSchema>;

/** `catalog.json` (`catalog`): exactly the text Claude read, kept for learning later (plan 4.3). */
export const StudioCatalogSchema = z.object({
  schema_version: studioVersion("catalog"),
  production_id: z.string().min(1),
  folder_ids: z.array(z.string()),
  /** Segments ag-go returned before the ~800 pre-filter. */
  total_available: z.number().int().min(0),
  truncated: z.boolean(),
  segments: z.array(CatalogSegmentSchema),
}).strict();
export type StudioCatalog = z.infer<typeof StudioCatalogSchema>;

/** `treatment.json` (`treatment`, edited at `approve-treatment`). */
export const TreatmentSchema = z.object({
  schema_version: studioVersion("treatment"),
  title: z.string().min(1).max(200),
  logline: z.string().min(1).max(600),
  beats: z.array(z.object({
    beat_id: z.string().regex(BEAT_ID),
    purpose: z.string().min(1).max(300),
    seconds: z.number().min(2).max(600),
    visual_idea: z.string().min(1).max(600),
    narration_idea: z.string().max(1200),
  }).strict()).min(1).max(40),
}).strict();
export type Treatment = z.infer<typeof TreatmentSchema>;

const reasoned = z.object({ segment_id: z.string().min(1), reason: z.string().min(1).max(300) }).strict();

/** `selection.json` (`select-shots`, swapped at `shot-board`). Picks play in order inside the beat. */
export const SelectionSchema = z.object({
  schema_version: studioVersion("selection"),
  beats: z.array(z.object({
    beat_id: z.string().regex(BEAT_ID),
    picks: z.array(reasoned).min(1).max(8),
    alternates: z.array(reasoned).max(4),
  }).strict()).min(1),
}).strict();
export type Selection = z.infer<typeof SelectionSchema>;

/** `narration.json` (`narration`): one TTS call per line; lines of a beat are read in order. */
export const StudioNarrationSchema = z.object({
  schema_version: studioVersion("narration"),
  language: z.string().min(2).max(10),
  lines: z.array(z.object({
    line_id: z.string().regex(LINE_ID),
    beat_id: z.string().regex(BEAT_ID),
    text: z.string().min(1).max(1200),
  }).strict()).min(1).max(300),
}).strict();
export type StudioNarration = z.infer<typeof StudioNarrationSchema>;

export const TEXT_KINDS = ["title", "callout", "lower_third"] as const;
export const TEXT_POSITIONS_V2 = ["top_left", "top_center", "top_right", "center", "bottom_left", "bottom_center", "bottom_right"] as const;

/**
 * `timeline.json` (Timeline v2, `build-timeline`, every editor revision, `edit`). Only the editorial facts
 * are stored; positions on the timeline are derived by `layoutTimeline` (core) so a trim or a re-order can
 * never leave two tracks disagreeing about where a beat starts.
 */
export const TimelineV2Schema = z.object({
  schema_version: studioVersion("timeline", 2),
  production_id: z.string().min(1),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  /** Array order is play order. */
  beats: z.array(z.object({
    beat_id: z.string().regex(BEAT_ID),
    title: z.string().max(300),
  }).strict()).min(1),
  /** V1. Array order inside one beat is play order; a beat lasts as long as its clips. */
  clips: z.array(z.object({
    clip_id: z.string().regex(/^C\d{3,4}$/),
    beat_id: z.string().regex(BEAT_ID),
    segment_id: z.string().min(1),
    src_in: z.number().min(0),
    src_out: z.number().min(0),
  }).strict()),
  /** A1. Lines of a beat play back to back from the beat's start; `audio: null` = needs TTS. */
  narration: z.array(z.object({
    line_id: z.string().regex(LINE_ID),
    beat_id: z.string().regex(BEAT_ID),
    text: z.string().min(1).max(1200),
    audio: z.object({ key: ProductionKeySchema, duration: z.number().positive() }).strict().nullable(),
  }).strict()),
  /** T. `offset` is seconds from the beat's start. */
  texts: z.array(z.object({
    text_id: z.string().regex(/^T\d{3}$/),
    beat_id: z.string().regex(BEAT_ID),
    kind: z.enum(TEXT_KINDS),
    text: z.string().min(1).max(64),
    offset: z.number().min(0),
    duration: z.number().min(0.5).max(20),
    position: z.enum(TEXT_POSITIONS_V2),
  }).strict()),
  /** A2. */
  music: StudioMusicSchema.nullable(),
  /** A3: the footage's own sound. The composition can only switch it on or off (no gain), so neither can this. */
  source_audio: z.object({ muted: z.boolean() }).strict(),
  captions: z.object({ enabled: z.boolean() }).strict(),
  /** Bounds and preview lookup for every segment the timeline or its alternates refer to. */
  segments: z.record(z.string(), z.object({
    asset_id: z.string().min(1),
    start_ms: z.number().int().min(0),
    end_ms: z.number().int().min(0),
    caption: z.string(),
    orientation: z.string().nullable(),
  }).strict()),
  /** Editor "Phương án thay thế" per beat. */
  alternates: z.record(z.string(), z.array(reasoned)),
}).strict();
export type TimelineV2 = z.infer<typeof TimelineV2Schema>;
export type TimelineClip = TimelineV2["clips"][number];
export type TimelineLine = TimelineV2["narration"][number];
export type TimelineText = TimelineV2["texts"][number];

/** `export.json` (`export`): where the deliverables landed in the Studio bucket. */
export const StudioExportSchema = z.object({
  schema_version: studioVersion("export"),
  production_id: z.string().min(1),
  run_id: z.string().min(1),
  duration_seconds: z.number().min(0),
  files: z.array(z.object({
    kind: z.enum(["mp4", "srt", "vtt", "timeline"]),
    key: z.string().min(1),
    size_bytes: z.number().int().min(0),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict()).min(1),
  watermarked: z.boolean(),
}).strict();
export type StudioExport = z.infer<typeof StudioExportSchema>;

/** Output schema per Studio skill: what Claude must return, and what the stage writes to disk. */
export const STUDIO_SKILL_OUTPUTS = {
  "studio-treatment": TreatmentSchema,
  "studio-select-shots": SelectionSchema,
  "studio-narration": StudioNarrationSchema,
} as const;
export type StudioSkill = keyof typeof STUDIO_SKILL_OUTPUTS;

const UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "default", "$schema",
]);

function stripForClaude(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripForClaude);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, stripForClaude(s)]));
      continue;
    }
    out[k] = stripForClaude(v);
  }
  if (out.type === "object") {
    // Structured outputs require every object closed; `z.record` has no fixed properties and is not used in
    // any Claude-facing schema, so closing is always right here.
    out.additionalProperties = false;
    if (out.properties && !out.required) out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * JSON Schema handed to `claude -p --json-schema`. Structured outputs reject numeric/string/array
 * constraints, so they are stripped here and enforced after the fact by the Zod schema plus the stage's
 * checker (one repair round, see `StudioAgentExecutor`).
 */
export function claudeOutputJsonSchema(skill: StudioSkill): Record<string, unknown> {
  const raw = zodToJsonSchema(STUDIO_SKILL_OUTPUTS[skill], { $refStrategy: "none", target: "jsonSchema7" });
  return stripForClaude(raw) as Record<string, unknown>;
}
