import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError, TranscriptSchema, type MediaEngine, type ShotsIndex, type Transcript } from "@harness/contracts";
import type { WatchLogFn } from "./watch.js";

const noopLog: WatchLogFn = () => {};

/** Floor for the engine timeout even when every source is short: whisperx model load alone can take a while. */
const MIN_TIMEOUT_SECONDS = 600;
const TIMEOUT_DURATION_MULTIPLIER = 1.5;

/** `-vn -ac 1 -ar 16000 -c:a pcm_s16le` -- mono 16kHz PCM, what WhisperX (and the fake engine) expect. */
function extractAudio(ffmpeg: string, sourcePath: string, outPath: string): boolean {
  mkdirSync(dirname(outPath), { recursive: true });
  const r = spawnSync(ffmpeg, ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath], { encoding: "utf8" });
  return r.status === 0;
}

type TranscriptSource = Transcript["sources"][number];

/**
 * Runs the transcribe stage's core: extract audio for every shots-index source that has audio and indexed
 * cleanly, hand them to `MediaEngine.transcribe`, and assemble `transcript.json` in `shots.sources` order.
 *
 * A source with `has_audio: false` or an `error` on its `ShotsIndex` entry is skipped -- no audio is
 * extracted, it is never sent to the engine -- but it still gets an entry in the output:
 * `{ segments: [], alignment: "segment", language: <declared language or null> }`. When *no* source has
 * audio, the engine is not called at all.
 *
 * The engine timeout is `min(deadlineSeconds, max(600, sum(duration of eligible sources) * 1.5))`; if that
 * comes out `<= 0` (the stage deadline leaves nothing to spend), this throws `IO_ERROR` before touching
 * ffmpeg or the engine. A `contract` engine outcome becomes `CONFIG_INVALID`; a `transient` one becomes
 * `IO_ERROR`. The assembled object is validated with `TranscriptSchema.parse` before being returned.
 */
export async function transcribeSources(
  d: { engine: MediaEngine; ffmpeg: string; log?: WatchLogFn },
  p: {
    shots: ShotsIndex;
    sources: { source_id: string; path: string; language: string | null }[];
    workDir: string;
    deadlineSeconds: number;
  },
): Promise<Transcript> {
  const log = d.log ?? noopLog;
  const sourceById = new Map(p.sources.map((s) => [s.source_id, s]));

  const eligible = p.shots.sources.filter((s) => s.has_audio && s.error === undefined);
  const totalDuration = eligible.reduce((sum, s) => sum + s.duration_seconds, 0);
  const timeout = Math.min(p.deadlineSeconds, Math.max(MIN_TIMEOUT_SECONDS, totalDuration * TIMEOUT_DURATION_MULTIPLIER));
  if (timeout <= 0) {
    throw new HarnessError("IO_ERROR", "no time left before the stage deadline", { deadlineSeconds: p.deadlineSeconds });
  }

  const audioDir = join(p.workDir, "audio");
  const items: { source_id: string; audio_path: string; language: string | null }[] = [];
  for (const s of eligible) {
    const source = sourceById.get(s.source_id);
    if (!source) {
      log("warn", "transcribeSources: no matching source input, skipping", { source_id: s.source_id });
      continue;
    }
    const audioPath = join(audioDir, `${s.source_id}.wav`);
    if (!extractAudio(d.ffmpeg, source.path, audioPath)) {
      log("warn", "transcribeSources: audio extraction failed, skipping", { source_id: s.source_id });
      continue;
    }
    items.push({ source_id: s.source_id, audio_path: audioPath, language: source.language });
  }

  let engineName = d.engine.name;
  const bySourceId = new Map<string, TranscriptSource>();
  if (items.length > 0) {
    const outcome = await d.engine.transcribe({ items, out_dir: p.workDir }, { timeout_seconds: timeout, log: (l) => log("info", l) });
    if (outcome.kind === "contract") throw new HarnessError("CONFIG_INVALID", outcome.reason, { engine: d.engine.name });
    if (outcome.kind === "transient") throw new HarnessError("IO_ERROR", outcome.reason, { engine: d.engine.name });
    engineName = outcome.result.engine;
    for (const src of outcome.result.sources) bySourceId.set(src.source_id, src);
  }

  const sources: TranscriptSource[] = p.shots.sources.map((s) => {
    const transcribed = bySourceId.get(s.source_id);
    if (transcribed) return transcribed;
    return { source_id: s.source_id, language: sourceById.get(s.source_id)?.language ?? null, alignment: "segment", segments: [] };
  });

  return TranscriptSchema.parse({ schema_version: "harness.transcript/v1", engine: engineName, sources });
}
