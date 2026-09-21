import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  HarnessError,
  NarrationTimingSchema,
  wordSchema,
  type MediaConfig,
  type MediaEngine,
  type Narration,
  type NarrationTiming,
  type VoiceParams,
  type VoiceProfile,
  type Word,
} from "@harness/contracts";
import { splitSentences } from "./sentences.js";
import type { WatchLogFn } from "./watch.js";

const noopLog: WatchLogFn = () => {};

const MIN_TIMEOUT_SECONDS = 900;
const TIMEOUT_CHARS_MULTIPLIER = 0.6;
/** Single-pass `loudnorm` may fall back to dynamic mode and slightly change duration; only a drift past this
 * many seconds gets a warning (spec resolution: re-measured duration wins, chunk/word ends get clamped to
 * it -- nothing is ever rescaled). */
const LOUDNESS_DURATION_DRIFT_SECONDS = 0.010;

const cacheEntrySchema = z.object({
  duration_seconds: z.number().positive(),
  chunks: z.array(z.object({ text: z.string(), start: z.number().min(0), end: z.number().min(0) }).strict()),
  words: z.array(wordSchema).nullable(),
  alignment: z.enum(["word", "chunk"]),
}).strict();
type CacheEntry = z.infer<typeof cacheEntrySchema>;

/**
 * `sha256(JSON with keys sorted at every level)` of the cache-relevant fields -- deliberately excludes
 * anything that does not change the audio (line_id, edl_order): the same text read by the same voice under
 * the same params/model/language/engine-config always resolves to the same cache entry, whichever narration
 * line it is currently attached to.
 *
 * Review finding (Task 5 fix round 1, Important #1): the cached wav/json are the *post-processing* result --
 * `dtype`/`max_chars`/`pause_seconds`/`loudness_lufs` all shape that output (chunk boundaries, inter-chunk
 * pause, final loudness), so a project.yaml edit to any of them must change the key too, or a stale cache
 * entry would keep being served as a hit forever.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function ttsCacheKey(p: {
  text: string;
  voice_checksum: string;
  params: VoiceParams;
  model: string;
  language: string;
  dtype: string;
  max_chars: number;
  pause_seconds: number;
  loudness_lufs: number;
}): string {
  const payload = {
    text: p.text, voice_checksum: p.voice_checksum, params: p.params, model: p.model, language: p.language,
    dtype: p.dtype, max_chars: p.max_chars, pause_seconds: p.pause_seconds, loudness_lufs: p.loudness_lufs,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** A cache entry with a missing/unreadable/unparsable json, or a missing wav, is not a hit -- the caller
 * treats the line as a miss and overwrites both files once it re-synthesizes. */
function readCacheEntry(wavPath: string, jsonPath: string): CacheEntry | null {
  if (!existsSync(wavPath) || !existsSync(jsonPath)) return null;
  try {
    const parsed = cacheEntrySchema.safeParse(JSON.parse(readFileSync(jsonPath, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** tmp-write + rename for both files, only ever called after the line has already passed duration validation. */
function writeCacheEntryAtomic(cacheDir: string, key: string, srcWav: string, entry: CacheEntry): void {
  const finalWav = join(cacheDir, `${key}.wav`);
  const finalJson = join(cacheDir, `${key}.json`);
  const tmpWav = join(cacheDir, `.tmp-${key}-${randomUUID()}.wav`);
  const tmpJson = join(cacheDir, `.tmp-${key}-${randomUUID()}.json`);
  copyFileSync(srcWav, tmpWav);
  writeFileSync(tmpJson, JSON.stringify(entry));
  renameSync(tmpWav, finalWav);
  renameSync(tmpJson, finalJson);
}

/** `loudnorm=I=<lufs>:TP=-1.5:LRA=11:linear=true`, resampled to mono 24kHz -- linear mode so a normal clip's
 * duration does not move; a clip where loudnorm silently falls back to dynamic mode still gets its duration
 * re-measured by the caller afterwards rather than trusted from the engine. */
function normalizeLoudness(ffmpeg: string, srcPath: string, destPath: string, lufs: number): void {
  mkdirSync(dirname(destPath), { recursive: true });
  const filter = `loudnorm=I=${lufs}:TP=-1.5:LRA=11:linear=true`;
  const r = spawnSync(ffmpeg, ["-y", "-i", srcPath, "-af", filter, "-ar", "24000", "-ac", "1", destPath], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(destPath)) {
    const reason = (r.stderr || r.error?.message || "unknown error").toString().trim();
    throw new HarnessError("IO_ERROR", `ffmpeg loudnorm failed: ${reason}`, { path: srcPath });
  }
}

export interface TtsDeps {
  engine: MediaEngine;
  ffmpeg: string;
  probeDuration: (p: string) => number | null;
  cacheDir: string;
  log?: WatchLogFn;
}

type TimingLine = NarrationTiming["lines"][number];

/**
 * Cache lookup for every narration line -> one `MediaEngine.synthesize` call for the misses (each line sent
 * once, `chunks` from `splitSentences`) -> loudness normalization -> `narration-timing.json`.
 *
 * `voiceMode !== "tts"` or an empty `narration.lines` short-circuits to an empty timing (`voice_id: null`,
 * no engine call) -- `outDir` is still created either way. A cache hit costs only a file copy (the cached
 * json already holds post-normalization duration/chunks/words); a miss is sent to the engine, normalized into
 * `outDir/<line_id>.wav`, re-measured, and only then written to the cache atomically. `outDir/.raw/` (the
 * engine's raw output) is always removed in `finally`, even on error.
 */
export async function synthesizeNarration(
  d: TtsDeps,
  p: {
    narration: Narration;
    voiceMode: "none" | "tts" | "original";
    voice?: { profile: VoiceProfile; ref_audio_path: string };
    cfg: MediaConfig["tts"];
    outDir: string;
    deadlineSeconds: number;
  },
): Promise<NarrationTiming> {
  const log = d.log ?? noopLog;
  mkdirSync(p.outDir, { recursive: true });

  if (p.voiceMode !== "tts" || p.narration.lines.length === 0) {
    return NarrationTimingSchema.parse({
      schema_version: "harness.narration-timing/v1",
      voice_id: null,
      voice_revision: null,
      total_seconds: 0,
      lines: [],
    });
  }
  if (!p.voice) {
    throw new HarnessError("CONFIG_INVALID", 'synthesizeNarration: voice is required when voiceMode is "tts"', {});
  }
  const { profile, ref_audio_path } = p.voice;
  mkdirSync(d.cacheDir, { recursive: true });

  const resolved = new Map<string, TimingLine>();
  const keyByLineId = new Map<string, string>();
  const missLines: Narration["lines"] = [];

  for (const line of p.narration.lines) {
    const key = ttsCacheKey({
      text: line.text, voice_checksum: profile.ref_audio.checksum, params: profile.params, model: p.cfg.model, language: p.narration.language,
      dtype: p.cfg.dtype, max_chars: p.cfg.max_chars, pause_seconds: p.cfg.pause_seconds, loudness_lufs: p.cfg.loudness_lufs,
    });
    keyByLineId.set(line.line_id, key);
    const cached = readCacheEntry(join(d.cacheDir, `${key}.wav`), join(d.cacheDir, `${key}.json`));
    if (!cached) {
      missLines.push(line);
      continue;
    }
    const destWav = join(p.outDir, `${line.line_id}.wav`);
    copyFileSync(join(d.cacheDir, `${key}.wav`), destWav);
    resolved.set(line.line_id, {
      line_id: line.line_id, edl_order: line.edl_order, text: line.text, wav: `voice/${line.line_id}.wav`,
      duration_seconds: cached.duration_seconds, chunks: cached.chunks, words: cached.words ?? [], alignment: cached.alignment, cached: true,
    });
  }

  if (missLines.length > 0) {
    const totalChars = missLines.reduce((sum, l) => sum + l.text.length, 0);
    const timeout = Math.min(p.deadlineSeconds, Math.max(MIN_TIMEOUT_SECONDS, totalChars * TIMEOUT_CHARS_MULTIPLIER));
    if (timeout <= 0) {
      throw new HarnessError("IO_ERROR", "no time left before the stage deadline", { deadlineSeconds: p.deadlineSeconds });
    }

    const rawDir = join(p.outDir, ".raw");
    try {
      mkdirSync(rawDir, { recursive: true });
      const jobLines = missLines.map((l) => {
        const chunks = splitSentences(l.text, p.narration.language, p.cfg.max_chars);
        if (chunks.length === 0) {
          throw new HarnessError("CONFIG_INVALID", `narration line ${l.line_id} has no speakable text after normalization`, { line_id: l.line_id });
        }
        return { line_id: l.line_id, chunks, out_path: join(rawDir, `${l.line_id}.wav`), pause_seconds: p.cfg.pause_seconds };
      });

      const outcome = await d.engine.synthesize(
        { lines: jobLines, language: p.narration.language, voice: { ref_audio: ref_audio_path, ref_text: profile.ref_text, params: profile.params }, align: true },
        { timeout_seconds: timeout, log: (l) => log("info", l) },
      );
      if (outcome.kind === "contract") throw new HarnessError("CONFIG_INVALID", outcome.reason, { engine: d.engine.name });
      if (outcome.kind === "transient") throw new HarnessError("IO_ERROR", outcome.reason, { engine: d.engine.name });

      const byLineId = new Map(outcome.result.lines.map((l) => [l.line_id, l]));
      for (const line of missLines) {
        const raw = byLineId.get(line.line_id);
        if (!raw) throw new HarnessError("CONFIG_INVALID", `tts engine did not return line ${line.line_id}`, { line_id: line.line_id });

        const destWav = join(p.outDir, `${line.line_id}.wav`);
        normalizeLoudness(d.ffmpeg, raw.wav_path, destWav, p.cfg.loudness_lufs);

        const duration = d.probeDuration(destWav);
        if (duration === null || duration <= 0) {
          throw new HarnessError("IO_ERROR", `could not measure duration of normalized narration wav for line ${line.line_id}`, { line_id: line.line_id });
        }

        let chunks = raw.chunks;
        let words: Word[] = raw.words ?? [];
        if (Math.abs(duration - raw.duration_seconds) > LOUDNESS_DURATION_DRIFT_SECONDS) {
          log("warn", "synthesizeNarration: loudnorm shifted duration beyond 10ms; trusting the re-measured duration", {
            line_id: line.line_id, engine_duration_seconds: raw.duration_seconds, measured_duration_seconds: duration,
          });
          chunks = chunks.map((c) => ({ ...c, end: Math.min(c.end, duration) }));
          words = words.map((w) => ({ ...w, end: Math.min(w.end, duration) }));
        }

        const entry: CacheEntry = { duration_seconds: duration, chunks, words, alignment: raw.alignment };
        writeCacheEntryAtomic(d.cacheDir, keyByLineId.get(line.line_id)!, destWav, entry);

        resolved.set(line.line_id, {
          line_id: line.line_id, edl_order: line.edl_order, text: line.text, wav: `voice/${line.line_id}.wav`,
          duration_seconds: duration, chunks, words, alignment: raw.alignment, cached: false,
        });
      }
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  }

  const lines = p.narration.lines.map((l) => resolved.get(l.line_id)!);
  const total_seconds = lines.reduce((sum, l) => sum + l.duration_seconds, 0);

  return NarrationTimingSchema.parse({
    schema_version: "harness.narration-timing/v1",
    voice_id: profile.voice_id,
    voice_revision: profile.revision,
    total_seconds,
    lines,
  });
}
