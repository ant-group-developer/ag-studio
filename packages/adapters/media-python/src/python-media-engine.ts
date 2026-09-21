import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  TranscriptSchema,
  wordSchema,
  type EngineOutcome,
  type MediaConfig,
  type MediaEngine,
  type MediaEngineProbe,
  type TranscribeJob,
  type Transcript,
  type TtsJob,
  type TtsRaw,
} from "@harness/contracts";
import { mediaChildEnv } from "./child-env.js";

/** Kept in one place: `run()`'s stderr accumulator truncates to this many trailing chars (spec: Global
 * constraints, "stderr tail kept = 2000 chars"). */
const STDERR_TAIL_CHARS = 2000;
const PROBE_TIMEOUT_MS = 30_000;

export interface PythonMediaEngineOptions {
  /** Python executable used when a stage has no more specific override. */
  python: string;
  /** Overrides `python` for `transcribe()` only. */
  transcribePython?: string;
  /** Overrides `python` for `synthesize()` only. */
  ttsPython?: string;
  /** `<harnessRoot>/engines/python` -- where `transcribe.py`/`tts.py` live. */
  enginesDir: string;
  device: string;
  transcribe: MediaConfig["transcribe"];
  tts: MediaConfig["tts"];
  redact?: (s: string) => string;
  /** Test-only: appends `--dry-run` to every spawned script. */
  dryRun?: boolean;
}

const ttsResultLineSchema = z
  .object({
    line_id: z.string(),
    wav_path: z.string(),
    duration_seconds: z.number(),
    chunks: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() }).strict()),
    words: z.array(wordSchema).nullable(),
    alignment: z.enum(["word", "chunk"]),
  })
  .strict();
const ttsResultSchema = z.object({ lines: z.array(ttsResultLineSchema) }).strict();

type RawOutcome = { kind: "ok"; raw: Record<string, unknown> } | { kind: "contract" | "transient"; reason: string };

function identity(s: string): string {
  return s;
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

function hfCacheHubDir(): string {
  const home = process.env.HF_HOME;
  return home ? join(home, "hub") : join(homedir(), ".cache", "huggingface", "hub");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Checks the local Hugging Face hub cache directly (no python involved) for `models--k2-fsa--OmniVoice` and a
 * whisper model directory matching `transcribe.model` (e.g. `large-v3` -> any cached dir containing both
 * "whisper" and "large-v3"). A missing/unreadable cache dir reads as "nothing cached", never throws.
 */
function probeModelsCached(transcribeModel: string): Record<string, boolean> {
  let entries: string[] = [];
  try {
    entries = readdirSync(hfCacheHubDir());
  } catch {
    entries = [];
  }
  const lower = entries.map((e) => e.toLowerCase());
  const omnivoice = lower.includes("models--k2-fsa--omnivoice");
  const modelToken = slug(transcribeModel);
  const whisperx = lower.some((e) => e.includes("whisper") && (modelToken === "" || e.includes(modelToken)));
  return { omnivoice, whisperx };
}

const PROBE_SCRIPT = [
  "import json, sys",
  'info = {"version": sys.version.split()[0], "packages": {}, "cuda": False}',
  "try:",
  "    import torch",
  '    info["packages"]["torch"] = torch.__version__',
  '    info["cuda"] = bool(torch.cuda.is_available())',
  '    if info["cuda"]:',
  "        try:",
  '            info["gpu"] = torch.cuda.get_device_name(0)',
  "            free, _total = torch.cuda.mem_get_info(0)",
  '            info["vram_free_mb"] = int(free // (1024 * 1024))',
  "        except Exception:",
  "            pass",
  "except Exception:",
  '    info["packages"]["torch"] = None',
  "try:",
  "    import omnivoice",
  '    info["packages"]["omnivoice"] = getattr(omnivoice, "__version__", "unknown")',
  "except Exception:",
  '    info["packages"]["omnivoice"] = None',
  "try:",
  "    import whisperx",
  '    info["packages"]["whisperx"] = getattr(whisperx, "__version__", "unknown")',
  "except Exception:",
  '    info["packages"]["whisperx"] = None',
  "print(json.dumps(info))",
].join("\n");

/** Every `line_id` unique, every `chunks` non-empty -- checked before spawning anything, since a job shaped
 * wrong is never going to become right by retrying it against the python process. */
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
 * The engine side of `MediaEngine` (spec §1.2, sub-project 5A Task 2): spawns `engines/python/transcribe.py`
 * / `tts.py` as short-lived child processes exchanging job/result JSON files, never talks to torch/whisperx/
 * omnivoice directly. Uses async `spawn` (never `spawnSync`) so a multi-minute GPU stage can keep heart-
 * beating its caller instead of blocking the event loop.
 *
 * Protocol per call: write `<dir>/engine-job-<uuid>.json`, spawn
 * `python <script> --job <job.json> --result <result.json> [--dry-run]`, wait for the child to exit.
 * - exit code != 0, or the child times out, or it exits 0 but never wrote a parseable result file -> `transient`
 *   (with up to 2000 trailing chars of redacted stderr appended).
 * - exit 0 with a `{ ok: false, kind, reason }` result -> that `kind`/`reason` verbatim.
 * - exit 0 with a `{ ok: true, ... }` result that fails the TS schema (`TranscriptSchema` for transcribe, a
 *   local Zod shape for tts) -> `transient` (the engine's own contract was met, but the payload it produced
 *   was not shaped as promised, which is exactly the kind of thing a retry might paper over if the script had
 *   a transient bug -- an actually-wrong script shape is caught by `python-scripts.test.ts`'s schema checks
 *   long before this ever runs against it for real).
 * Both temp files are removed after the child settles, whichever branch runs.
 */
export class PythonMediaEngine implements MediaEngine {
  readonly name = "python";
  private readonly redact: (s: string) => string;

  constructor(private readonly opts: PythonMediaEngineOptions) {
    this.redact = opts.redact ?? identity;
  }

  async transcribe(job: TranscribeJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<Transcript>> {
    const python = this.opts.transcribePython ?? this.opts.python;
    const script = join(this.opts.enginesDir, "transcribe.py");
    const payload = {
      device: this.opts.device,
      model: this.opts.transcribe.model,
      compute_type: this.opts.transcribe.compute_type,
      batch_size: this.opts.transcribe.batch_size,
      items: job.items,
    };
    mkdirSync(job.out_dir, { recursive: true });
    const raw = await this.run(python, script, payload, job.out_dir, o);
    if (raw.kind !== "ok") return raw;
    const candidate = { schema_version: "harness.transcript/v1" as const, engine: raw.raw.engine, sources: raw.raw.sources };
    const parsed = TranscriptSchema.safeParse(candidate);
    if (!parsed.success) return { kind: "transient", reason: `python engine wrote a transcript result that failed schema validation: ${parsed.error.message}` };
    return { kind: "ok", result: parsed.data };
  }

  async synthesize(job: TtsJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<TtsRaw>> {
    const invalid = validateTtsJob(job.lines);
    if (invalid) return { kind: "contract", reason: invalid };

    const python = this.opts.ttsPython ?? this.opts.python;
    const script = join(this.opts.enginesDir, "tts.py");
    const pythonLines = job.lines.map((l) => ({
      line_id: l.line_id, chunks: l.chunks, out_path: l.out_path, pause_seconds: l.pause_seconds ?? this.opts.tts.pause_seconds,
    }));
    const outDir = job.lines.length > 0 ? dirname(job.lines[0]!.out_path) : process.cwd();
    const payload = {
      device: this.opts.device,
      model: this.opts.tts.model,
      dtype: this.opts.tts.dtype,
      num_step: job.voice.params.num_step,
      speed: job.voice.params.speed,
      language: job.language,
      ref_audio: job.voice.ref_audio,
      ref_text: job.voice.ref_text,
      align: job.align,
      lines: pythonLines,
    };
    mkdirSync(outDir, { recursive: true });
    const raw = await this.run(python, script, payload, outDir, o);
    if (raw.kind !== "ok") return raw;
    const parsed = ttsResultSchema.safeParse({ lines: raw.raw.lines });
    if (!parsed.success) return { kind: "transient", reason: `python engine wrote a tts result that failed schema validation: ${parsed.error.message}` };
    return { kind: "ok", result: parsed.data };
  }

  async probe(): Promise<MediaEngineProbe> {
    const empty: MediaEngineProbe = {
      python: null,
      packages: { torch: null, omnivoice: null, whisperx: null },
      cuda: false,
      models_cached: { omnivoice: false, whisperx: false },
    };

    let stdout = "";
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.opts.python, ["-c", PROBE_SCRIPT], { env: mediaChildEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, PROBE_TIMEOUT_MS);
      const settle = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      child.stdout?.on("data", (d) => {
        stdout += String(d);
      });
      child.on("error", () => settle(false));
      child.on("close", (code) => settle(code === 0));
    });
    if (!ok) return empty;

    let parsed: { version?: string; packages?: Record<string, string | null>; cuda?: boolean; gpu?: string; vram_free_mb?: number };
    try {
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}";
      parsed = JSON.parse(lastLine) as typeof parsed;
    } catch {
      return empty;
    }

    const packages = {
      torch: parsed.packages?.torch ?? null,
      omnivoice: parsed.packages?.omnivoice ?? null,
      whisperx: parsed.packages?.whisperx ?? null,
    };
    return {
      python: this.opts.python,
      packages,
      cuda: Boolean(parsed.cuda),
      ...(parsed.gpu ? { gpu: parsed.gpu } : {}),
      ...(parsed.vram_free_mb !== undefined ? { vram_free_mb: parsed.vram_free_mb } : {}),
      models_cached: probeModelsCached(this.opts.transcribe.model),
    };
  }

  private async run(
    python: string,
    script: string,
    job: unknown,
    dir: string,
    o: { timeout_seconds: number; log?: (l: string) => void },
  ): Promise<RawOutcome> {
    const id = randomUUID();
    const jobPath = join(dir, `engine-job-${id}.json`);
    const resultPath = join(dir, `engine-result-${id}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(jobPath, JSON.stringify(job));
    const args = [script, "--job", jobPath, "--result", resultPath];
    if (this.opts.dryRun) args.push("--dry-run");

    let stderrTail = "";
    const outcome = await new Promise<{ code: number | null; timedOut: boolean; spawnError: Error | null }>((resolve) => {
      let settled = false;
      const child = spawn(python, args, { env: mediaChildEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, o.timeout_seconds * 1000);
      const settle = (r: { code: number | null; timedOut: boolean; spawnError: Error | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      // Results travel via the file, not stdout; still drain it so a chatty script never backs up its pipe.
      child.stdout.on("data", () => {});
      child.stderr.on("data", (d) => {
        const s = this.redact(String(d));
        stderrTail = tail(stderrTail + s, STDERR_TAIL_CHARS);
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) o.log?.(line);
        }
      });
      // Without this handler an ENOENT (missing python binary) throws an unhandled "error" event and
      // crashes the whole process instead of resolving to a transient outcome.
      child.on("error", (e) => settle({ code: null, timedOut, spawnError: e }));
      child.on("close", (code) => settle({ code, timedOut, spawnError: null }));
    });

    const cleanup = () => {
      try {
        rmSync(jobPath, { force: true });
      } catch {
        /* best effort */
      }
      try {
        rmSync(resultPath, { force: true });
      } catch {
        /* best effort */
      }
    };

    if (outcome.spawnError) {
      cleanup();
      return { kind: "transient", reason: `failed to start python engine: ${outcome.spawnError.message}` };
    }
    if (outcome.timedOut) {
      cleanup();
      return { kind: "transient", reason: `python engine timed out after ${o.timeout_seconds}s${stderrTail ? `: ${stderrTail}` : ""}` };
    }
    if (outcome.code !== 0) {
      cleanup();
      return { kind: "transient", reason: `python engine exited with code ${String(outcome.code)}${stderrTail ? `: ${stderrTail}` : ""}` };
    }
    if (!existsSync(resultPath)) {
      cleanup();
      return { kind: "transient", reason: `python engine exited 0 without writing a result file${stderrTail ? `: ${stderrTail}` : ""}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (e) {
      cleanup();
      return { kind: "transient", reason: `python engine wrote invalid JSON result: ${e instanceof Error ? e.message : String(e)}` };
    }
    cleanup();

    const obj = parsed as Record<string, unknown>;
    if (obj.ok === false) {
      const kind = obj.kind === "contract" ? "contract" : "transient";
      const reason = typeof obj.reason === "string" ? obj.reason : "python engine reported failure with no reason";
      return { kind, reason };
    }
    if (obj.ok !== true) {
      return { kind: "transient", reason: "python engine result missing 'ok' flag" };
    }
    return { kind: "ok", raw: obj };
  }
}
