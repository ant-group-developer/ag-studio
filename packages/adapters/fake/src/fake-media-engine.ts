import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EngineOutcome, MediaEngine, MediaEngineProbe, TranscribeJob, Transcript, TtsJob, TtsRaw, Word } from "@harness/contracts";

export interface FakeMediaEngineOptions {
  /** ffmpeg binary; default "ffmpeg" on PATH (same resolution as `packages/core/src/media/watch.ts`). */
  ffmpeg?: string;
  /** Used to size the fake synthesized wav: `max(0.4, totalChars / charsPerSecond)` seconds. Default 15. */
  charsPerSecond?: number;
}

const DEFAULT_CHARS_PER_SECOND = 15;
const SEGMENT_SECONDS = 2;
const MIN_LINE_SECONDS = 0.4;
const SAMPLE_RATE = 24000;

function run(bin: string, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr ?? "" };
}

/**
 * `ffmpeg -i <path>` with no output writes nothing and always exits non-zero, but it prints
 * `Duration: HH:MM:SS.xx` to stderr while probing the input -- used here instead of spawning a second
 * `ffprobe` binary, since `FakeMediaEngineOptions` exposes only one binary knob (`ffmpeg`).
 */
function probeDurationSeconds(ffmpeg: string, path: string): number {
  const { stderr } = run(ffmpeg, ["-i", path]);
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  return hh * 3600 + mm * 60 + ss;
}

/** Splits `text` on whitespace and divides `[start, end)` evenly across the resulting words. */
function evenWords(text: string, start: number, end: number): Word[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const step = (end - start) / words.length;
  return words.map((w, i) => ({ word: w, start: start + i * step, end: start + (i + 1) * step }));
}

function synthWav(ffmpeg: string, outPath: string, seconds: number): void {
  mkdirSync(dirname(outPath), { recursive: true });
  run(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${SAMPLE_RATE}`, "-t", seconds.toFixed(3), "-c:a", "pcm_s16le", outPath]);
}

/** Every `line_id` unique, every `chunks` non-empty -- same check `PythonMediaEngine.synthesize` makes before
 * spawning anything, kept here too so a test (or a caller) sees identical `contract` behavior regardless of
 * which `MediaEngine` implementation is wired up. */
function validateTtsJob(lines: TtsJob["lines"]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.chunks.length === 0) return `tts job line ${line.line_id} has no chunks`;
    if (seen.has(line.line_id)) return `tts job has a duplicate line_id: ${line.line_id}`;
    seen.add(line.line_id);
  }
  return null;
}

/**
 * In-process stand-in for `PythonMediaEngine`: no torch/whisperx/omnivoice, no GPU -- every CI test that
 * exercises transcribe/synthesize runs against this instead (spec: sub-project 5A Task 2).
 *
 * `transcribe`: per source, a 2s-wide segment across `[0, duration)` (duration measured via `ffmpeg -i`,
 * see `probeDurationSeconds`), fixed text `"w1 w2 w3"`, words divided evenly, `alignment: "word"`,
 * `language: item.language ?? "en"`.
 *
 * `synthesize`: per line, a sine-wave wav at 24 kHz lasting `max(0.4, totalChars / charsPerSecond)` seconds
 * (`totalChars` = sum of every chunk's character count); each chunk gets a time span proportional to its
 * share of the line's total characters, its words divided evenly by whitespace within that span,
 * `alignment: "word"`. A line with a duplicate `line_id` or empty `chunks` fails `contract` before any wav
 * is written.
 */
export class FakeMediaEngine implements MediaEngine {
  readonly name = "fake";
  calls: { kind: "transcribe" | "synthesize"; n: number }[] = [];
  /** The most recent `synthesize` job as received, kept next to `calls` so a test can assert exactly what
   * core sent (chunks, pause_seconds, align) without re-deriving it (review finding, Task 5 fix round 1). */
  lastTtsJob?: TtsJob;
  private readonly ffmpeg: string;
  private readonly charsPerSecond: number;

  constructor(o?: FakeMediaEngineOptions) {
    this.ffmpeg = o?.ffmpeg ?? "ffmpeg";
    this.charsPerSecond = o?.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
  }

  async transcribe(job: TranscribeJob): Promise<EngineOutcome<Transcript>> {
    this.calls.push({ kind: "transcribe", n: job.items.length });
    const sources = job.items.map((item) => {
      const duration = probeDurationSeconds(this.ffmpeg, item.audio_path);
      const segments: Transcript["sources"][number]["segments"] = [];
      for (let start = 0; start < duration; start += SEGMENT_SECONDS) {
        const end = Math.min(start + SEGMENT_SECONDS, duration);
        segments.push({ start, end, text: "w1 w2 w3", words: evenWords("w1 w2 w3", start, end) });
      }
      return { source_id: item.source_id, language: item.language ?? "en", alignment: "word" as const, segments };
    });
    return { kind: "ok", result: { schema_version: "harness.transcript/v1" as const, engine: "fake", sources } };
  }

  async synthesize(job: TtsJob): Promise<EngineOutcome<TtsRaw>> {
    const invalid = validateTtsJob(job.lines);
    if (invalid) return { kind: "contract", reason: invalid };

    this.calls.push({ kind: "synthesize", n: job.lines.length });
    this.lastTtsJob = job;
    const lines = job.lines.map((line) => {
      const charCounts = line.chunks.map((t) => t.length);
      const totalChars = charCounts.reduce((a, b) => a + b, 0);
      const duration = Math.max(MIN_LINE_SECONDS, totalChars / this.charsPerSecond);
      synthWav(this.ffmpeg, line.out_path, duration);

      const chunks: TtsRaw["lines"][number]["chunks"] = [];
      const words: Word[] = [];
      let cursor = 0;
      for (let i = 0; i < line.chunks.length; i++) {
        const text = line.chunks[i]!;
        const frac = totalChars > 0 ? charCounts[i]! / totalChars : 1 / line.chunks.length;
        const isLast = i === line.chunks.length - 1;
        const start = cursor;
        const end = isLast ? duration : cursor + duration * frac;
        chunks.push({ text, start, end });
        words.push(...evenWords(text, start, end));
        cursor = end;
      }
      return { line_id: line.line_id, wav_path: line.out_path, duration_seconds: duration, chunks, words, alignment: "word" as const };
    });
    return { kind: "ok", result: { lines } };
  }

  /** No python/GPU to probe: reports the same "nothing installed" shape `PythonMediaEngine.probe()` reports
   * when python itself is missing. */
  async probe(): Promise<MediaEngineProbe> {
    return { python: null, packages: { torch: null, omnivoice: null, whisperx: null }, cuda: false, models_cached: { omnivoice: false, whisperx: false } };
  }
}
