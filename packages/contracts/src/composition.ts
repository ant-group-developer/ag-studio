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
export const TRANSITION_KINDS = [
  "cut", "dissolve", "dip_black",
  // render level 8 (2026-10-27)
  "dip_white", "wipe_left", "wipe_right", "slide_left", "slide_right", "zoom_in", "smooth_left",
] as const;
export type CompositionTransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * The transitions ffmpeg's `xfade` draws, by its name for them: the outgoing clip plays on into a tail of its source
 * (`tail_available`) while the next one comes in over it, as a dissolve always has.
 */
export const XFADE_TRANSITIONS: Partial<Record<CompositionTransitionKind, string>> = {
  dissolve: "fade", wipe_left: "wipeleft", wipe_right: "wiperight", slide_left: "slideleft", slide_right: "slideright",
  zoom_in: "zoomin", smooth_left: "smoothleft",
};

/** The transitions that dip through a flat colour: the outgoing clip fades out to it, the next fades in from it. */
export const DIP_TRANSITIONS: Partial<Record<CompositionTransitionKind, "black" | "white">> = { dip_black: "black", dip_white: "white" };

/** The transitions an older render worker (level < 8) draws. */
export const LEVEL1_TRANSITIONS: readonly CompositionTransitionKind[] = ["cut", "dissolve", "dip_black"];

/** A transition played over a tail of the outgoing clip (`XFADE_TRANSITIONS`). */
export function isTailTransition(kind: CompositionTransitionKind): boolean {
  return XFADE_TRANSITIONS[kind] !== undefined;
}

export const TEXT_POSITIONS = ["top_left", "top_center", "top_right", "center", "bottom_left", "bottom_center", "bottom_right"] as const;
export type TextPosition = (typeof TEXT_POSITIONS)[number];

export const TEXT_ANIMATIONS = ["none", "fade", "slide_up", "pop"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

export const SUBTITLE_MODES = ["burn-in", "karaoke", "none"] as const;
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];

export const OVERLAY_TEXT_MAX: Record<OverlayKind, number> = { title: 48, callout: 24, lower_third: 64 };

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);

/**
 * The fonts a text look may name (feedback-vps §4.2): Arial, which every render machine has installed, and fonts under
 * the SIL Open Font License that the render worker ships in its release (`fonts/` of ag-render-worker). The first six
 * since render level 4, the rest (fonts sheet 2026-10-27, batch 1) since level 8. Words in a script the look's font
 * lacks are drawn in Noto Sans KR / JP or Be Vietnam Pro (`TEXT_FONT_INFO`).
 */
export const TEXT_FONTS = [
  "Arial", "Be Vietnam Pro", "Noto Sans JP", "Noto Sans KR", "Noto Serif", "Playfair Display",
  // Latin
  "Montserrat", "Oswald", "Bebas Neue", "Anton", "Inter", "Roboto", "Poppins", "Lato", "Raleway", "Josefin Sans", "Quicksand",
  "Cormorant Garamond", "DM Serif Display", "Libre Baskerville", "Cinzel", "Great Vibes", "Pacifico", "Caveat",
  // Japanese
  "Noto Serif JP", "M PLUS Rounded 1c", "Zen Maru Gothic", "Zen Kaku Gothic New", "Shippori Mincho", "Dela Gothic One", "Kiwi Maru",
  "Klee One", "RocknRoll One", "BIZ UDPGothic",
  // Korean
  "Noto Serif KR", "Nanum Gothic", "Nanum Myeongjo", "Nanum Pen Script", "Black Han Sans", "Do Hyeon", "Jua", "Gowun Dodum",
  "Gowun Batang", "IBM Plex Sans KR",
] as const;
export type TextFont = (typeof TEXT_FONTS)[number];

/** The scripts a text font draws (besides plain Latin, which all of them do). */
export const TEXT_SCRIPTS = ["vietnamese", "japanese", "korean"] as const;
export type TextScript = (typeof TEXT_SCRIPTS)[number];

const V = "vietnamese";
const J = "japanese";
const K = "korean";
/**
 * Per font: the scripts it has glyphs for (read from the shipped files) and, when it differs from the name, the family
 * name inside the file that libass matches (`face`).
 */
export const TEXT_FONT_INFO: Record<TextFont, { scripts: readonly TextScript[]; face?: string }> = {
  "Arial": { scripts: [V] },
  "Be Vietnam Pro": { scripts: [V] },
  "Noto Sans JP": { scripts: [V, J] },
  "Noto Sans KR": { scripts: [V, J, K] },
  "Noto Serif": { scripts: [V] },
  "Playfair Display": { scripts: [V] },
  "Montserrat": { scripts: [V] },
  "Oswald": { scripts: [V] },
  "Bebas Neue": { scripts: [] },
  "Anton": { scripts: [V] },
  "Inter": { scripts: [V] },
  "Roboto": { scripts: [V] },
  "Poppins": { scripts: [] },
  "Lato": { scripts: [V] },
  "Raleway": { scripts: [V] },
  "Josefin Sans": { scripts: [V] },
  "Quicksand": { scripts: [V] },
  "Cormorant Garamond": { scripts: [V] },
  "DM Serif Display": { scripts: [] },
  "Libre Baskerville": { scripts: [] },
  "Cinzel": { scripts: [] },
  "Great Vibes": { scripts: [V] },
  "Pacifico": { scripts: [V] },
  "Caveat": { scripts: [] },
  "Noto Serif JP": { scripts: [V, J] },
  "M PLUS Rounded 1c": { scripts: [V, J], face: "Rounded Mplus 1c" },
  "Zen Maru Gothic": { scripts: [J] },
  "Zen Kaku Gothic New": { scripts: [J] },
  "Shippori Mincho": { scripts: [J] },
  "Dela Gothic One": { scripts: [V, J] },
  "Kiwi Maru": { scripts: [J] },
  "Klee One": { scripts: [J] },
  "RocknRoll One": { scripts: [J] },
  "BIZ UDPGothic": { scripts: [J] },
  "Noto Serif KR": { scripts: [V, J, K] },
  "Nanum Gothic": { scripts: [K], face: "NanumGothic" },
  "Nanum Myeongjo": { scripts: [K], face: "NanumMyeongjo" },
  "Nanum Pen Script": { scripts: [K], face: "Nanum Pen" },
  "Black Han Sans": { scripts: [K] },
  "Do Hyeon": { scripts: [K] },
  "Jua": { scripts: [K] },
  "Gowun Dodum": { scripts: [V, K] },
  "Gowun Batang": { scripts: [V, K] },
  "IBM Plex Sans KR": { scripts: [K] },
};

/**
 * The colour of a video's picture (feedback-vps §4.6): a fixed grade applied to every clip when its mezzanine is made.
 * `none` = as filmed; `natural` a little contrast and colour; `vivid` strong colour; `warm` golden; `cinematic` soft
 * contrast, teal shadows, warm highlights.
 */
export const VIDEO_LOOKS = ["none", "natural", "vivid", "warm", "cinematic"] as const;
export type VideoLook = (typeof VIDEO_LOOKS)[number];

export const TEXT_LOOK_SIZES = ["s", "m", "l"] as const;
export type TextLookSize = (typeof TEXT_LOOK_SIZES)[number];
/**
 * A team's look for the words on screen (Studio branding `on_screen_text.look`, frozen into a shot-cut timeline and
 * its composition): text and outline colours, a box behind titles and lower thirds (`null` = none), a size step.
 * A composition that carries one is refused by a render worker that does not know it (the schema is strict).
 */
export const TextLookSchema = z.object({
  text_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "#RRGGBB"),
  outline_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "#RRGGBB"),
  box_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "#RRGGBB").nullable(),
  size: z.enum(TEXT_LOOK_SIZES),
  /** A soft shadow under texts and subtitles (feedback-vps §4.1). Absent = none. Needs render level 3. */
  shadow: z.boolean().optional(),
  /** One of `TEXT_FONTS` (feedback-vps §4.2). Absent = Arial. Needs render level 4 (the first six) or 8. */
  font: z.enum(TEXT_FONTS).optional(),
}).strict();
export type TextLook = z.infer<typeof TextLookSchema>;

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
  /** This text's own size step against its kind's (feedback-vps §4.1). Absent = `m`. Needs render level 3. */
  size: z.enum(TEXT_LOOK_SIZES).optional(),
}).strict();

/** `composition.json`: the fully-resolved render plan -- picture segments (mirroring `timeline.json.video`
 * exactly), text events, captions, music and transitions -- that `media.render` consumes (spec §3). */
export const CompositionSchema = z.object({
  schema_version: schemaVersion("composition"),
  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
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
    /** Feedback-vps §4.3: this segment's own sound louder or quieter, dB. Absent = 0. Needs render level 5. */
    gain_db: z.number().optional(),
    transition_out: z.object({
      kind: z.enum(TRANSITION_KINDS),
      seconds: z.number(),
      tail_available: z.boolean(),
    }).strict(),
  }).strict()),
  text_events: z.array(TextEventSchema),
  /** The team's look for the texts and subtitles (cut 1.1.0); absent = the Studio default look. */
  text_style: TextLookSchema.optional(),
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
    /** Feedback-vps §4.3: the music's gain along the episode, linear between points (absent = `cues[0].gain_db`). Level 5. */
    envelope: z.array(z.object({ at: z.number(), gain_db: z.number() }).strict()).optional(),
    duck: z.object({
      /** `false`: the music plays at its own gain, never pushed down under the voice. Absent = `true` (every
       * composition before it had this key ducked); Studio writes the key only when ducking is off, so a render
       * worker that predates it still takes every ducked composition (`RENDER_FEATURE_LEVEL`). */
      enabled: z.boolean().optional(),
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
  /**
   * Feedback-vps §4.3: the render worker measures each segment's own sound (ebur128 of its mezzanine, cached with it) and
   * brings it to the median of them, by at most ±12 dB, before `gain_db`. Absent = as recorded. Needs render level 5.
   */
  source_even: z.boolean().optional(),
  /** Feedback-vps §4.6: the colour grade of every segment (`VIDEO_LOOKS`, never `none`). Absent = as filmed. Level 6. */
  look: z.enum(VIDEO_LOOKS).optional(),
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

const inspectSpanSchema = z.object({ start: z.number(), end: z.number() });

/** What the inspection of a finished render can find (`inspectionIssues` in `@harness/core`). */
export const RENDER_INSPECT_ISSUE_CODES = ["duration", "freeze", "black", "silence", "clip_loudness", "repeated_onset"] as const;
export type RenderInspectIssueCode = (typeof RENDER_INSPECT_ISSUE_CODES)[number];

export const RenderInspectIssueSchema = z.object({
  /** One of `RENDER_INSPECT_ISSUE_CODES`; a reader skips a code it does not know (a newer render worker). */
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  /** Seconds on the episode. */
  start: z.number().optional(),
  end: z.number().optional(),
  /** The composition segment it is in (`segments[].order`). */
  order: z.number().int().optional(),
  /** `duration`: the composition's length and the stream furthest from it. */
  expected_s: z.number().optional(),
  actual_s: z.number().optional(),
  /** `clip_loudness`: the segment against the median of the segments, in dB. */
  delta_db: z.number().optional(),
  /** `freeze`: the picture never moves again. */
  to_end: z.boolean().optional(),
  /** `repeated_onset`: narration lines that open with the same sound (a voice sample leaking into the TTS), of the
   * lines measured; `start` is the first such line's. */
  lines: z.number().int().optional(),
  of_lines: z.number().int().optional(),
});
export type RenderInspectIssue = z.infer<typeof RenderInspectIssueSchema>;

/**
 * `inspect.json`: the render worker's check of a file it rendered (plan 2026-10-15 feedback-vps §2.1) -- one ffmpeg pass
 * of `freezedetect`, `blackdetect`, `silencedetect` and `ebur128`, read per composition segment, and contact sheets
 * of the picture. Not strict: Studio reads what a newer worker wrote.
 */
export const RenderInspectionSchema = z.object({
  schema_version: schemaVersion("render-inspect"),
  /** The composition's `total_seconds`, and each stream of the file as measured. */
  expected_seconds: z.number(),
  video_seconds: z.number().nullable(),
  audio_seconds: z.number().nullable(),
  freezes: z.array(inspectSpanSchema),
  blacks: z.array(inspectSpanSchema),
  silences: z.array(inspectSpanSchema),
  /** Momentary loudness gated at -70 LUFS over each segment's window; null: silent or no audio. */
  segments: z.array(z.object({ order: z.number().int(), start: z.number(), end: z.number(), lufs: z.number().nullable() })),
  loudness_median_lufs: z.number().nullable(),
  /** With narration: how many lines open with a sound alike to many other lines', of the lines measured. */
  narration_onsets: z.object({ alike: z.number().int(), lines: z.number().int(), start: z.number().nullable() }).optional(),
  /** `sheet-NN.jpg`: `frames` tiles from `from_s`, one every `every_s` seconds, `columns` x `rows`, row by row. */
  sheets: z.array(z.object({
    file: z.string(),
    from_s: z.number(),
    every_s: z.number(),
    columns: z.number().int(),
    rows: z.number().int(),
    frames: z.number().int(),
    tile_width: z.number().int(),
  })),
  issues: z.array(RenderInspectIssueSchema),
  inspect_seconds: z.number(),
});
export type RenderInspection = z.infer<typeof RenderInspectionSchema>;

export type Overlays =z.infer<typeof OverlaysSchema>;
export type BrandProfile = z.infer<typeof BrandProfileSchema>;
export type MusicTrack = z.infer<typeof MusicTrackSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type TextEvent = z.infer<typeof TextEventSchema>;
export type Composition = z.infer<typeof CompositionSchema>;
export type CompositionSegment = Composition["segments"][number];
export type RenderReport = z.infer<typeof RenderReportSchema>;
