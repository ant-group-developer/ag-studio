import { z } from "zod";
import { checksumSchema, revisionSchema, schemaVersion, timestampSchema } from "./common.js";
import { idSchema } from "./ids.js";
import { WordSchema } from "./media-engine.js";

export const OVERLAY_KINDS = ["title", "callout", "lower_third"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

/** Sub-project 5B transition kinds. Named `CompositionTransitionKind` (not `TransitionKind`) because
 * `packages/contracts/src/interfaces.ts` already exports a `TransitionKind` type for the control-plane
 * `transition()` call ("run" | "stage_run" | ...); both are wildcard-re-exported from `index.ts`, so reusing
 * the name would collide. Fixed as an obvious bug in the brief -- see task-1-report.md. */
export const TRANSITION_KINDS = ["cut", "dissolve", "dip_black"] as const;
export type CompositionTransitionKind = (typeof TRANSITION_KINDS)[number];

export const TEXT_POSITIONS = ["top_left", "top_center", "top_right", "center", "bottom_left", "bottom_center", "bottom_right"] as const;
export type TextPosition = (typeof TEXT_POSITIONS)[number];

export const TEXT_ANIMATIONS = ["none", "fade", "slide_up", "pop"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

export const SUBTITLE_MODES = ["burn-in", "karaoke", "none"] as const;
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];

export const OVERLAY_TEXT_MAX: Record<OverlayKind, number> = { title: 48, callout: 24, lower_third: 64 };

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);

const anchorSchema = z.union([
  z.object({ line_id: z.string().regex(/^L\d{3}$/), word_index: z.number().int().min(0).optional() }).strict(),
  z.object({ edl_order: z.number().int().min(0) }).strict(),
  z.object({ speech_index: z.number().int().min(0) }).strict(),
]);

/** `overlays.json`: the editorial overlay plan an agent drafts for `plan-edit` (spec §2). */
export const OverlaysSchema = z.object({
  schema_version: schemaVersion("overlays"),
  items: z.array(z.object({
    id: z.string().regex(/^OV\d{2,3}$/),
    kind: z.enum(OVERLAY_KINDS),
    text: z.string().min(1).max(64),
    anchor: anchorSchema,
    seconds: z.number().min(1).max(10).optional(),
  }).strict()).default([]),
  transitions: z.array(z.object({
    before_order: z.number().int().min(1),
    kind: z.enum(TRANSITION_KINDS),
  }).strict()).default([]),
  music: z.object({ mood: z.string().min(1).max(40) }).strict().optional(),
}).strict();

const textStyle = (size: number, position: TextPosition, box: boolean, animation: TextAnimation, seconds: number) =>
  z.object({
    size_px: z.number().int().min(24).max(400).default(size),
    position: z.enum(TEXT_POSITIONS).default(position),
    box: z.boolean().default(box),
    animation: z.enum(TEXT_ANIMATIONS).default(animation),
    seconds: z.number().min(1).max(10).default(seconds),
  }).strict().default({});

/** `<kho>/brands/<channel_id>/brand.json`: a channel-owned brand profile (fonts, colors, text/subtitle
 * styles, logo, transitions, music) used to render every video for that channel (spec §2.1). */
export const BrandProfileSchema = z.object({
  schema_version: schemaVersion("brand"),
  channel_id: z.string().min(1),
  revision: revisionSchema,
  fonts: z.object({
    regular: z.string().min(1),
    bold: z.string().min(1),
    origin: z.enum(["own", "licensed", "royalty_free"]),
    origin_note: z.string().min(1),
  }).strict(),
  colors: z.object({
    primary: hexColor,
    text: hexColor.default("#FFFFFF"),
    text_outline: hexColor.default("#000000"),
    box: hexColor.default("#000000B3"),
  }).strict(),
  safe_margin_px: z.number().int().min(0).max(600).default(120),
  text: z.object({
    title: textStyle(120, "top_left", true, "slide_up", 4),
    callout: textStyle(160, "center", false, "pop", 3),
    lower_third: textStyle(72, "bottom_left", true, "fade", 5),
  }).strict().default({}),
  subtitles: z.object({
    mode: z.enum(SUBTITLE_MODES).default("burn-in"),
    size_px: z.number().int().min(24).max(300).default(88),
    position: z.enum(["bottom_center", "top_center"]).default("bottom_center"),
    max_chars_per_line: z.number().int().min(16).max(80).default(42),
    max_lines: z.number().int().min(1).max(3).default(2),
    highlight_color: hexColor.default("#F2C94C"),
  }).strict().default({}),
  logo: z.object({
    path: z.string().min(1),
    corner: z.enum(["left", "right"]).default("right"),
    opacity: z.number().min(0).max(1).default(0.8),
    height_px: z.number().int().min(24).max(600).default(140),
  }).strict().optional(),
  transition: z.object({
    kind: z.enum(TRANSITION_KINDS).default("cut"),
    seconds: z.number().min(0.2).max(1).default(0.4),
  }).strict().default({}),
  source_fit: z.enum(["scale_pad", "scale_crop"]).default("scale_pad"),
  music: z.object({
    tracks: z.array(z.string()).default([]),
    gain_db: z.number().min(-40).max(0).default(-18),
    duck_db: z.number().min(-40).max(0).default(-12),
    duck_attack_ms: z.number().int().min(10).max(2000).default(150),
    duck_release_ms: z.number().int().min(10).max(5000).default(600),
  }).strict().default({}),
  /** Keys: "fonts.regular" | "fonts.bold" | "logo" -- written by `library brands set`. */
  checksums: z.record(z.string(), checksumSchema).default({}),
  created_at: timestampSchema.optional(),
  updated_at: timestampSchema.optional(),
}).strict();

/** `<kho>/music/<track_id>/track.json`: a channel-owned background music track (spec §2.2). */
export const MusicTrackSchema = z.object({
  schema_version: schemaVersion("music-track"),
  track_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  display_name: z.string().min(1),
  file: z.string().min(1),
  mood: z.array(z.string().min(1)).min(1),
  duration_seconds: z.number().positive(),
  loop_ok: z.boolean().default(false),
  origin: z.enum(["own", "licensed", "royalty_free"]),
  origin_note: z.string().min(1),
  checksum: checksumSchema,
  active: z.boolean().default(true),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const CaptionCueSchema = z.object({
  index: z.number().int().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  lines: z.array(z.string()).min(1).max(3),
  raise_px: z.number().int().min(0).default(0),
  words: z.array(WordSchema).default([]),
}).strict();

export const TextEventSchema = z.object({
  id: z.string(),
  kind: z.enum(OVERLAY_KINDS),
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  position: z.enum(TEXT_POSITIONS),
  animation: z.enum(TEXT_ANIMATIONS),
}).strict();

/** `composition.json`: the fully-resolved render plan -- picture segments (mirroring `timeline.json.video`
 * exactly), text events, captions, music and transitions -- that `media.render` consumes (spec §3). */
export const CompositionSchema = z.object({
  schema_version: schemaVersion("composition"),
  output: z.object({
    width: z.literal(3840),
    height: z.literal(2160),
    fps: z.number().int(),
    codec: z.enum(["h264", "hevc"]),
  }).strict(),
  voice: z.enum(["none", "tts", "original"]),
  language: z.string(),
  total_seconds: z.number().min(0),
  request_id: idSchema("content_request"),
  brand: z.object({
    channel_id: z.string(),
    revision: revisionSchema,
    dir: z.string(),
    fonts_dir: z.string(),
    checksums: z.record(z.string(), checksumSchema),
  }).strict().nullable(),
  segments: z.array(z.object({
    order: z.number().int().min(0),
    source_id: idSchema("source_item"),
    source_path: z.string(),
    in: z.number(),
    out: z.number(),
    start: z.number(),
    end: z.number(),
    fit: z.enum(["scale_pad", "scale_crop"]),
    has_audio: z.boolean(),
    transition_out: z.object({
      kind: z.enum(TRANSITION_KINDS),
      seconds: z.number(),
      tail_available: z.boolean(),
    }).strict(),
  }).strict()),
  text_events: z.array(TextEventSchema),
  captions: z.object({
    mode: z.enum(SUBTITLE_MODES),
    cues: z.array(CaptionCueSchema),
    reason: z.string().optional(),
  }).strict(),
  music: z.object({
    track_id: z.string(),
    path: z.string(),
    loop: z.boolean(),
    fade_in: z.number(),
    fade_out: z.number(),
    cues: z.array(z.object({ start: z.number(), end: z.number(), gain_db: z.number() }).strict()),
    duck: z.object({
      windows: z.array(z.object({ start: z.number(), end: z.number() }).strict()),
      gain_db: z.number(),
      attack_ms: z.number(),
      release_ms: z.number(),
    }).strict(),
  }).strict().nullable(),
  music_reason: z.string().optional(),
  logo: z.object({
    path: z.string(),
    corner: z.enum(["left", "right"]),
    opacity: z.number(),
    height_px: z.number(),
  }).strict().nullable(),
  narration: z.array(z.object({
    line_id: z.string(),
    wav: z.string(),
    start: z.number(),
    end: z.number(),
  }).strict()),
  transitions: z.object({
    requested: z.number().int(),
    applied: z.number().int(),
    downgraded: z.array(z.object({
      before_order: z.number().int(),
      reason: z.enum(["no_tail", "next_too_short", "too_short"]),
    }).strict()),
  }).strict(),
  text_dropped: z.array(z.object({ id: z.string(), reason: z.string() }).strict()).default([]),
  warnings: z.array(z.string()),
}).strict();

/** `render-report.json`: what `media.render` actually did (spec §4). */
export const RenderReportSchema = z.object({
  schema_version: schemaVersion("render-report"),
  encoder: z.enum(["nvenc", "cpu"]),
  codec: z.enum(["h264", "hevc"]),
  output: z.object({
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number(),
    seconds: z.number(),
    bytes: z.number().int(),
  }).strict(),
  segments: z.object({
    total: z.number().int(),
    rendered: z.number().int(),
    cached: z.number().int(),
    mezz_seconds: z.number(),
  }).strict(),
  transitions: CompositionSchema.shape.transitions,
  captions: z.object({
    mode: z.enum(SUBTITLE_MODES),
    cues: z.number().int(),
    reason: z.string().optional(),
  }).strict(),
  text_events: z.object({
    total: z.number().int(),
    dropped: z.array(z.object({ id: z.string(), reason: z.string() }).strict()),
  }).strict(),
  music: z.object({ track_id: z.string().nullable(), reason: z.string().optional(), loop: z.boolean() }).strict(),
  loudness: z.object({
    integrated_lufs: z.number(),
    true_peak_dbtp: z.number(),
    lra: z.number(),
  }).strict().nullable(),
  brand: z.enum(["present", "absent"]),
  warnings: z.array(z.string()),
  render_seconds: z.number(),
  ffmpeg_version: z.string(),
}).strict();

export type Overlays = z.infer<typeof OverlaysSchema>;
export type BrandProfile = z.infer<typeof BrandProfileSchema>;
export type MusicTrack = z.infer<typeof MusicTrackSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type TextEvent = z.infer<typeof TextEventSchema>;
export type Composition = z.infer<typeof CompositionSchema>;
export type CompositionSegment = Composition["segments"][number];
export type RenderReport = z.infer<typeof RenderReportSchema>;
