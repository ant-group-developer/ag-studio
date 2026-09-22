import { z } from "zod";
import { checksumSchema, revisionSchema, schemaVersion, timestampSchema } from "./common.js";
import { idSchema } from "./ids.js";

const durationTuple = z.tuple([z.number().min(0), z.number().min(0)]);

export const wordSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().min(0).max(1).optional(),
}).strict();
/** Sub-project 5B: same schema as `wordSchema`, exported under the PascalCase name `composition.ts` (and
 * other 5B modules) import. Both names stay live -- `wordSchema` is still used by `packages/core/src/media/tts.ts`
 * and `packages/adapters/media-python/src/python-media-engine.ts`. */
export const WordSchema = wordSchema;

/** `shots.json` a multi-source index stage produces: per-source shot boundaries (spec §1.2). */
export const ShotsIndexSchema = z.object({
  schema_version: schemaVersion("shots", 2),
  sources: z.array(z.object({
    source_id: idSchema("source_item"),
    index: z.number().int().min(0),
    file_name: z.string(),
    duration_seconds: z.number().min(0),
    has_audio: z.boolean(),
    error: z.string().optional(),
    /** Why this source has no `<proxy_dir>/<source_id>.mp4` (sub-project 5A final review, Important 3). A
     * failed proxy encode used to be logged and swallowed, so `media watch --mode source` silently extracted
     * no frames for it and the survey agent scored footage it had never seen, with every stage green. */
    proxy_error: z.string().optional(),
    shots: z.array(z.object({
      shot_id: z.string().regex(/^s\d{3}-\d{3}$/),
      in: z.number().min(0),
      out: z.number().positive(),
    }).strict()),
  }).strict()).min(1),
}).strict();

/** `transcript.json`: per-source speech transcript produced by the transcribe stage. */
export const TranscriptSchema = z.object({
  schema_version: schemaVersion("transcript"),
  engine: z.string().min(1),
  sources: z.array(z.object({
    source_id: idSchema("source_item"),
    language: z.string().nullable(),
    alignment: z.enum(["word", "segment"]),
    segments: z.array(z.object({
      start: z.number().min(0),
      end: z.number().min(0),
      text: z.string(),
      words: z.array(wordSchema).default([]),
    }).strict()),
  }).strict()),
}).strict();

/** `narration.json`: the narration script lines an editor/agent drafts for `voice: tts`. */
export const NarrationSchema = z.object({
  schema_version: schemaVersion("narration"),
  language: z.string().min(1),
  lines: z.array(z.object({
    line_id: z.string().regex(/^L\d{3}$/),
    edl_order: z.number().int().min(0),
    text: z.string().min(1).max(1200),
  }).strict()),
}).strict();

/** `narration-timing.json`: per-line synthesized audio, chunked and (optionally) word-aligned. */
export const NarrationTimingSchema = z.object({
  schema_version: schemaVersion("narration-timing"),
  voice_id: idSchema("voice_profile").nullable(),
  voice_revision: revisionSchema.nullable(),
  total_seconds: z.number().min(0),
  lines: z.array(z.object({
    line_id: z.string(),
    edl_order: z.number().int().min(0),
    text: z.string(),
    wav: z.string(),
    duration_seconds: z.number().positive(),
    chunks: z.array(z.object({ text: z.string(), start: z.number().min(0), end: z.number().min(0) }).strict()),
    words: z.array(wordSchema).default([]),
    alignment: z.enum(["word", "chunk"]),
    cached: z.boolean(),
  }).strict()),
}).strict();

export const FIT_ACTIONS = ["kept", "trimmed", "extended", "appended", "reused", "snapped", "dropped"] as const;

/** `fit-report.json`: how `fit-edl` reshaped the picture EDL to match the narration/transcript timing. */
export const FitReportSchema = z.object({
  schema_version: schemaVersion("fit-report"),
  voice: z.enum(["none", "tts", "original"]),
  entries: z.array(z.object({
    order: z.number().int().min(0),
    source_id: idSchema("source_item"),
    before: z.object({ in: z.number(), out: z.number() }).strict().nullable(),
    after: z.object({ in: z.number(), out: z.number() }).strict(),
    action: z.enum(FIT_ACTIONS),
  }).strict()),
  /** One row per narration line group that fresh footage could not cover. `missing_seconds` is the whole
   * uncovered need (`reused_seconds + uncovered_seconds`), split into the part that was papered over by
   * showing footage a second time and the part that nothing covers at all -- so a consumer summing
   * `missing_seconds` across rows never double-counts a group. */
  shortfalls: z.array(z.object({
    line_ids: z.array(z.string()),
    missing_seconds: z.number().positive(),
    reused_seconds: z.number().min(0).default(0),
    uncovered_seconds: z.number().min(0).default(0),
  }).strict()),
  reused_seconds: z.number().min(0),
  warnings: z.array(z.string()),
  total_seconds: z.number().min(0),
  target_duration_seconds: durationTuple.optional(),
  within_target: z.boolean(),
}).strict();

/** `timeline.json`: the final programme timeline (video/narration/speech tracks) after `fit-edl`. */
export const TimelineSchema = z.object({
  schema_version: schemaVersion("timeline"),
  voice: z.enum(["none", "tts", "original"]),
  language: z.string(),
  total_seconds: z.number().min(0),
  video: z.array(z.object({
    order: z.number().int().min(0),
    source_id: idSchema("source_item"),
    in: z.number(),
    out: z.number(),
    start: z.number(),
    end: z.number(),
  }).strict()),
  narration: z.array(z.object({
    line_id: z.string(),
    wav: z.string(),
    start: z.number(),
    end: z.number(),
    words: z.array(wordSchema).default([]),
  }).strict()),
  speech: z.array(z.object({
    source_id: idSchema("source_item"),
    start: z.number(),
    end: z.number(),
    text: z.string(),
    words: z.array(wordSchema).default([]),
  }).strict()),
}).strict();

export const voiceParamsSchema = z.object({
  speed: z.number().min(0.5).max(2).default(1),
  num_step: z.number().int().min(4).max(128).default(32),
}).strict();

/** `<kho>/voices/<voice_id>/voice.json`: a channel-owned TTS voice profile (spec §1.5). */
export const VoiceProfileSchema = z.object({
  schema_version: schemaVersion("voice"),
  voice_id: idSchema("voice_profile"),
  display_name: z.string().min(1),
  language: z.string().min(1),
  origin: z.enum(["synthetic", "own", "licensed"]),
  origin_note: z.string().default(""),
  ref_audio: z.object({ path: z.literal("ref.wav"), checksum: checksumSchema, duration_seconds: z.number().min(3).max(30) }).strict(),
  ref_text: z.string().min(1),
  params: voiceParamsSchema.default({}),
  revision: revisionSchema,
  status: z.enum(["active", "retired"]),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export type Word = z.infer<typeof wordSchema>;
export type ShotsIndex = z.infer<typeof ShotsIndexSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type Narration = z.infer<typeof NarrationSchema>;
export type NarrationTiming = z.infer<typeof NarrationTimingSchema>;
export type FitReport = z.infer<typeof FitReportSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type VoiceParams = z.infer<typeof voiceParamsSchema>;
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

// ---- MediaEngine port (spec §1.2) — TS interfaces, not Zod: core depends on this, never on a concrete
// engine; the composition root picks PythonMediaEngine or FakeMediaEngine (sub-project 5A task 2). ----

export interface TranscribeJob {
  items: { source_id: string; audio_path: string; language: string | null }[];
  out_dir: string;
}

export interface TtsJob {
  /** One entry per narration line (`line_id` unique, `chunks` non-empty) -- `chunks` is the already
   * sentence-split text for that line (spec: core's `splitSentences`, sub-project 5A Task 5); `pause_seconds`
   * overrides the engine's configured `tts.pause_seconds` for this line only when set. */
  lines: { line_id: string; chunks: string[]; out_path: string; pause_seconds?: number }[];
  language: string;
  voice: { ref_audio: string; ref_text: string; params: VoiceParams };
  align: boolean;
}

/** One line of raw TTS engine output, before core chunks/caches/normalizes it into `narration-timing.json`. */
export interface TtsRaw {
  lines: {
    line_id: string;
    wav_path: string;
    duration_seconds: number;
    chunks: { text: string; start: number; end: number }[];
    words: Word[] | null;
    alignment: "word" | "chunk";
  }[];
}

export type EngineOutcome<T> =
  | { kind: "ok"; result: T }
  | { kind: "contract"; reason: string }
  | { kind: "transient"; reason: string };

export interface MediaEngineProbe {
  python: string | null;
  packages: Record<string, string | null>;
  cuda: boolean;
  gpu?: string;
  vram_free_mb?: number;
  models_cached: Record<string, boolean>;
}

export interface MediaEngine {
  readonly name: string;
  transcribe(job: TranscribeJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<Transcript>>;
  synthesize(job: TtsJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<TtsRaw>>;
  probe(): Promise<MediaEngineProbe>;
}
