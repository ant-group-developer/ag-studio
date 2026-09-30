/** The two-tier renderer -- sub-project 5B Task 7, spec §5. This is the only module in `media/render/` that
 * touches the filesystem or spawns anything: `encoder.ts`/`mezzanine.ts`/`audio-graph.ts`/`final-graph.ts`
 * decide argv, `cache.ts` owns the cache directory, `loudnorm.ts` parses stderr, and this file sequences
 * them:
 *
 *   1. resolve the encoder (one NVENC probe per run),
 *   2. one mezzanine per segment body (plus a tail per dissolve), served from the content-addressed cache
 *      whenever the key hits and the cached file still probes to the right length,
 *   3. `clip_set`: `cuts/<order>.mp4` hardlinked (or copied) from each body, plus `cuts/manifest.json`,
 *   4. the loudnorm measurement pass (`-f null -`) over the audio graph,
 *   5. the real encode with those measured values,
 *   6. `render-report.json` + an LRU sweep of the cache.
 *
 * Every ffmpeg failure -- non-zero exit, a kill on timeout, a binary that will not start, a mezzanine whose
 * duration comes back wrong -- is an `IO_ERROR`, which `packages/cli/src/commands/media.ts` maps to a
 * `transient` stage failure (so the orchestrator retries). Bad inputs (a segment with no source checksum) are
 * `CONFIG_INVALID`, which maps to `contract` and does not retry.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError, isHarnessError, RenderReportSchema, type Clock, type Composition, type MediaProber, type RenderReport } from "@harness/contracts";
import { childEnvWithoutSecrets } from "../child-env.js";
import { round3 } from "../time.js";
import { cacheCommit, cacheEvict, cacheLookup, type MezzCache } from "./cache.js";
import { NVENC_PROBE_ARGS, resolveEncoder, type EncoderChoice } from "./encoder.js";
import { finalArgs } from "./final-graph.js";
import { parseLoudnorm } from "./loudnorm.js";
import { mezzArgs, mezzCacheKey } from "./mezzanine.js";

export type SpawnFn = typeof nodeSpawn;

export interface RenderDeps {
  /** ffmpeg binary name/path; the composition root passes `process.env.FFMPEG_PATH ?? "ffmpeg"`. */
  ffmpeg: string;
  prober: MediaProber;
  cache: MezzCache;
  /** Resolved once per `renderComposition` call (see `probeNvenc`); the CLI may cache it for 15 minutes. */
  nvencAvailable: () => Promise<boolean>;
  clock: Clock;
  log?: (line: string) => void;
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawn?: SpawnFn;
}

export interface RenderInput {
  composition: Composition;
  /** `overlay.ass` from `media-compose`, or `null` when there is nothing to burn in. */
  assPath: string | null;
  /** Everything this render writes lands here: `full-episode.mp4`, `cuts/`, `render-report.json`, `tmp/`. */
  outDir: string;
  encoderCfg: "auto" | "nvenc" | "cpu";
  /** Wall-clock budget for the whole render; each ffmpeg call gets whatever is left of it. */
  timeoutSeconds: number;
  /** `source_id` -> checksum, folded into every mezzanine cache key (spec §5.1). */
  sourceChecksums: ReadonlyMap<string, string>;
  /** The brand's `safe_margin_px`, which places the logo overlay at `safe_margin_px / 2` from the corner
   * (spec §5.2). `composition.json` does not carry it -- only `brand.dir` -- so the stage resolves it from
   * the loaded brand and passes it here; omitted, `finalArgs` uses the same 120 default the brand schema
   * does. */
  safe_margin_px?: number;
  /** Fonts directory handed to libass (`ass=...:fontsdir=`) instead of `composition.brand.fonts_dir`: a render
   * with no brand (Studio) still needs its font found in a known directory, not in whatever the machine's
   * fontconfig has. */
  fontsDir?: string | null;
  /** Cancels the render: the running ffmpeg is killed and the call rejects with `IO_ERROR` (a farm job that
   * lost its lease or was cancelled must not keep encoding for minutes). */
  signal?: AbortSignal;
  /** Progress over the whole render, 0-100, with a short stage name (`mezzanine`, `loudnorm`, `final_encode`).
   * Called often during encodes; callers throttle. */
  onProgress?: (percent: number, stage: string) => void;
}

/** How much of a failing ffmpeg's stderr is kept for the error details / log line. */
const STDERR_TAIL = 4000;
const NVENC_PROBE_TIMEOUT_SECONDS = 20;
/** A cached or freshly rendered mezzanine whose probed duration drifts further than this from the requested
 * length is treated as corrupt (spec §7: "Cache mezz hỏng (file cụt) -> xoá, render lại"). */
const MEZZ_DURATION_TOLERANCE = 0.05;

interface ProcResult {
  stdout: string;
  stderr: string;
}

/**
 * Adds `-progress pipe:1 -nostats` to an ffmpeg argv and turns its `out_time=` lines into a 0-1 fraction of
 * `seconds`. `-nostats` only drops the stats line from stderr, so the loudnorm json stays parsable.
 */
function withProgress(argv: string[], seconds: number, onFraction: ((f: number) => void) | null): { argv: string[]; onStdoutLine?: (line: string) => void } {
  if (onFraction === null || seconds <= 0) return { argv };
  const [bin, ...rest] = argv;
  return {
    argv: [bin!, "-progress", "pipe:1", "-nostats", ...rest],
    onStdoutLine: (line) => {
      const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(line);
      if (!m) return;
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onFraction(Math.min(1, Math.max(0, t / seconds)));
    },
  };
}

/**
 * Spawns `argv[0]` with the rest as arguments and resolves with its captured output. Asynchronous on
 * purpose: `spawnSync` would block the event loop for the whole encode and stop the worker's lease heartbeat
 * from ticking. Only the last `STDERR_TAIL` characters of stderr are kept, so a chatty ffmpeg cannot grow
 * unbounded in memory over a long render.
 *
 * Two different error codes, on purpose (review round 1, Important 1). A spawn `error` event means the
 * BINARY could not be run at all (`ENOENT`, `EACCES`) -- that is a broken machine/config, not a flaky
 * encode, so it is `CONFIG_INVALID` with the same wording `watch.ts`'s `assertFfmpegSpawned` uses and the
 * stage layer maps it to a `contract` failure that does not retry. An ffmpeg that DID run and then failed
 * (non-zero exit, `null` exit after a kill, our own timeout) stays `IO_ERROR` -> `transient`.
 */
interface RunOptions {
  signal?: AbortSignal | undefined;
  /** Every complete stdout line (used for `-progress pipe:1`); implies piping stdout. */
  onStdoutLine?: ((line: string) => void) | undefined;
}

function runProcess(spawnFn: SpawnFn, argv: string[], timeoutSeconds: number, label: string, captureStdout: boolean, opts: RunOptions = {}): Promise<ProcResult> {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new HarnessError("CONFIG_INVALID", `${label}: empty ffmpeg argv`, { label });
  if (opts.signal?.aborted) return Promise.reject(new HarnessError("IO_ERROR", `${label}: aborted before start`, { label, aborted: true }));

  return new Promise<ProcResult>((resolve, reject) => {
    const pipeStdout = captureStdout || opts.onStdoutLine !== undefined;
    // `env`: ffmpeg never needs a secret, and the repo rule is absolute -- see `childEnvWithoutSecrets`.
    const child = spawnFn(bin, args, { windowsHide: true, env: childEnvWithoutSecrets(), stdio: ["ignore", pipeStdout ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    let stdout = "";
    let lineBuf = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1, timeoutSeconds) * 1000);

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr?.setEncoding("utf8");
    child.stdout?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdout?.on("data", (chunk: string) => {
      if (captureStdout) stdout = (stdout + chunk).slice(-STDERR_TAIL);
      if (opts.onStdoutLine) {
        lineBuf += chunk;
        let nl = lineBuf.indexOf("\n");
        while (nl >= 0) {
          opts.onStdoutLine(lineBuf.slice(0, nl).trim());
          lineBuf = lineBuf.slice(nl + 1);
          nl = lineBuf.indexOf("\n");
        }
      }
    });

    const settle = (e: HarnessError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    };

    child.on("error", (e) => settle(new HarnessError("CONFIG_INVALID", `ffmpeg not available: cannot run "${bin}": ${e.message}`, { label, ffmpeg: bin })));
    child.on("close", (code) => {
      // `timedOut` first: a killed process also reports a non-zero/null exit, and "timed out" is the useful
      // message of the two.
      if (aborted) {
        settle(new HarnessError("IO_ERROR", `${label}: aborted`, { label, aborted: true }));
        return;
      }
      if (timedOut) {
        settle(new HarnessError("IO_ERROR", `${label}: ffmpeg timed out after ${timeoutSeconds}s and was killed`, { label, timeout_seconds: timeoutSeconds, stderr_tail: stderr }));
        return;
      }
      if (code !== 0) {
        settle(new HarnessError("IO_ERROR", `${label}: ffmpeg exited ${String(code)}`, { label, exit_code: code, stderr_tail: stderr }));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr });
    });
  });
}

/**
 * `true` when this machine can actually encode with NVENC right now (spec §5.4): the one-shot
 * `nullsrc -> h264_nvenc -> null` probe exits 0. Any failure at all -- no such encoder, no driver, no GPU,
 * ffmpeg missing, a 20-second hang -- is `false`, never a throw: the caller's job is to fall back to CPU, not
 * to fail the run.
 */
export async function probeNvenc(ffmpeg: string, spawnFn: SpawnFn = nodeSpawn): Promise<boolean> {
  try {
    await runProcess(spawnFn, [ffmpeg, ...NVENC_PROBE_ARGS], NVENC_PROBE_TIMEOUT_SECONDS, "nvenc probe", false);
    return true;
  } catch {
    return false;
  }
}

/** First line of `ffmpeg -version` ("ffmpeg version 8.1 Copyright ...") reduced to its version token;
 * `"unknown"` when ffmpeg cannot be run or printed something unexpected. */
async function ffmpegVersion(spawnFn: SpawnFn, ffmpeg: string): Promise<string> {
  try {
    const { stdout, stderr } = await runProcess(spawnFn, [ffmpeg, "-hide_banner", "-version"], 20, "ffmpeg -version", true);
    const m = /ffmpeg version (\S+)/.exec(stdout) ?? /ffmpeg version (\S+)/.exec(stderr);
    return m?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function secondsBetween(clock: Clock, startedAt: string): number {
  const a = Date.parse(startedAt);
  const b = Date.parse(clock.now());
  return Number.isFinite(a) && Number.isFinite(b) ? round3(Math.max(0, (b - a) / 1000)) : 0;
}

interface MezzRef {
  order: number;
  body: string;
  tail: string | null;
}

/**
 * Renders one episode from a resolved `composition.json`. Returns the report (also written next to the
 * episode as `render-report.json`, so the stage can declare it as an output verbatim), the episode path and
 * the `cuts/` directory that carries the `clip_set` contract `thumbnail-candidates` and 5A's
 * `clip-set-complete` checker still depend on.
 */
export async function renderComposition(d: RenderDeps, p: RenderInput): Promise<{ report: RenderReport; episodePath: string; clipSetDir: string }> {
  try {
    return await renderCompositionInner(d, p);
  } finally {
    // `tmp/` holds the mezzanine each ffmpeg call writes BEFORE it is probed and committed to the cache --
    // at 4K those are the largest files this stage ever makes. On the happy path the last committed one is
    // all that is left; on a failure (a dead NVENC, a timeout, a mezzanine that came out the wrong length)
    // the partial file would otherwise sit in the attempt workspace until the whole workspace is swept, and
    // a retry would write its own alongside it. Cleaning up here covers both (review fix wave, m7).
    rmSync(join(p.outDir, "tmp"), { recursive: true, force: true });
  }
}

async function renderCompositionInner(d: RenderDeps, p: RenderInput): Promise<{ report: RenderReport; episodePath: string; clipSetDir: string }> {
  const { composition } = p;
  const spawnFn = d.spawn ?? nodeSpawn;
  const log = d.log ?? (() => {});
  const startedAt = d.clock.now();
  const deadlineMs = Date.now() + p.timeoutSeconds * 1000;
  /** Whatever is left of the run's budget, for the next ffmpeg call. */
  const remaining = (): number => Math.max(1, (deadlineMs - Date.now()) / 1000);

  /** Share of the 0-100 progress each phase covers. */
  const MEZZ_SHARE = 70;
  const MEASURE_AT = 72;
  const FINAL_FROM = 75;
  const reportProgress = (percent: number, stage: string): void => {
    p.onProgress?.(Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10, stage);
  };
  const signal = p.signal;

  const outDir = p.outDir;
  const tmpDir = join(outDir, "tmp");
  const clipSetDir = join(outDir, "cuts");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(clipSetDir, { recursive: true });

  const warnings: string[] = [];
  const nvenc = await d.nvencAvailable();
  /** The encoder this run has settled on. It starts at whatever `resolveEncoder` picked and can only ever
   * step DOWN to `cpu`, the first time NVENC actually fails on a segment (review round 1, Important 4): a
   * driver that just died will fail on every remaining segment too, so re-trying it N times would cost N
   * wasted encodes and emit N identical warnings. */
  let encoder = resolveEncoder(p.encoderCfg, nvenc);
  if (p.encoderCfg === "nvenc" && !nvenc) warnings.push("nvenc_unavailable_cpu_fallback");

  const segs = [...composition.segments].sort((a, b) => a.order - b.order);
  if (segs.length === 0) throw new HarnessError("CONFIG_INVALID", "renderComposition: composition has no segments", { request_id: composition.request_id });

  const { width, height, fps, codec } = composition.output;

  // ---- 2) mezzanine per segment body (+ tail per dissolve) ----
  /**
   * One mezzanine file: `cached` when the key hit and the file still probed to the right length, otherwise
   * encoded here. `keyFor` rather than a fixed key because the encoder is part of the cache key: an NVENC
   * segment that falls back to CPU must be looked up, written and committed under the CPU key, or the cache
   * would hold a CPU-encoded file under a name that promises NVENC.
   */
  const renderMezz = async (o: { keyFor: (e: EncoderChoice) => string; source: string; in: number; out: number; fit: "scale_pad" | "scale_crop"; has_audio: boolean; label: string; onFraction?: (f: number) => void }): Promise<{ path: string; seconds: number; cached: boolean }> => {
    const expected = o.out - o.in;
    let key = o.keyFor(encoder);

    const hit = cacheLookup(d.cache, key, "mp4", d.clock.now());
    if (hit !== null) {
      const probed = await d.prober.probe(hit);
      const duration = probed?.duration_seconds ?? null;
      if (duration !== null && Math.abs(duration - expected) <= MEZZ_DURATION_TOLERANCE) {
        return { path: hit, seconds: expected, cached: true };
      }
      // Spec §7: a truncated cache entry is deleted and re-rendered rather than handed to the final graph.
      log(`mezz cache entry ${key} is corrupt (duration ${String(duration)} vs ${expected}); re-rendering`);
      rmSync(hit, { force: true });
      rmSync(join(d.cache.dir, `${key}.json`), { force: true });
    }

    const encodeTo = async (choice: EncoderChoice, k: string, label: string): Promise<string> => {
      const tmpPath = join(tmpDir, `${k}.mp4`);
      const args = mezzArgs({
        ffmpeg: d.ffmpeg, source: o.source, in: o.in, out: o.out, fit: o.fit, w: width, h: height, fps,
        has_audio: o.has_audio, encoder: choice, codec, out_path: tmpPath,
      });
      const prog = withProgress(args, expected, o.onFraction ?? null);
      await runProcess(spawnFn, prog.argv, remaining(), label, false, { signal, onStdoutLine: prog.onStdoutLine });
      return tmpPath;
    };

    let tmpPath: string;
    try {
      tmpPath = await encodeTo(encoder, key, `mezzanine ${o.label}`);
    } catch (e) {
      // Spec §7: an NVENC failure on one segment gets exactly one CPU retry; a CPU failure is the stage's.
      // `CONFIG_INVALID` (the ffmpeg binary itself cannot be run) is never worth retrying on either encoder.
      if (signal?.aborted || encoder !== "nvenc" || !isHarnessError(e, "IO_ERROR")) throw e;
      warnings.push(`nvenc_segment_fallback:${o.label}`);
      log(`nvenc failed for mezzanine ${o.label}; this run falls back to cpu`);
      rmSync(join(tmpDir, `${key}.mp4`), { force: true });
      encoder = "cpu";
      key = o.keyFor("cpu");
      tmpPath = await encodeTo("cpu", key, `mezzanine ${o.label} (cpu retry)`);
    }

    const probed = await d.prober.probe(tmpPath);
    const duration = probed?.duration_seconds ?? null;
    if (duration === null || Math.abs(duration - expected) > MEZZ_DURATION_TOLERANCE) {
      throw new HarnessError("IO_ERROR", `mezzanine ${o.label} came out ${String(duration)}s, expected ${expected}s`, { label: o.label, expected, actual: duration, path: tmpPath });
    }

    const bytes = statSync(tmpPath).size;
    const path = cacheCommit(d.cache, key, tmpPath, { seconds: expected, bytes, now: d.clock.now() });
    return { path, seconds: expected, cached: false };
  };

  const mezz: MezzRef[] = [];
  let rendered = 0;
  let cached = 0;
  /** Total mezzanine footage this episode is built from -- every body plus every dissolve tail, whether it
   * was encoded now or served from the cache. It describes the render PLAN's size, not the work done this
   * run; `rendered`/`cached` next to it are what say how much of it had to be encoded (review round 1, m6). */
  let mezzSeconds = 0;
  /** Seconds of mezzanine the plan needs (bodies + dissolve tails), to weight the mezzanine phase. */
  const planSeconds = segs.reduce((sum, s) => sum + (s.out - s.in) + (s.transition_out.kind === "dissolve" && s.transition_out.tail_available ? s.transition_out.seconds : 0), 0);
  const mezzProgress = (doneSeconds: number): void => reportProgress(planSeconds > 0 ? (MEZZ_SHARE * doneSeconds) / planSeconds : 0, "mezzanine");
  reportProgress(0, "mezzanine");

  for (const seg of segs) {
    const checksum = p.sourceChecksums.get(seg.source_id);
    if (checksum === undefined) {
      throw new HarnessError("CONFIG_INVALID", `no source checksum for segment ${seg.order} (source ${seg.source_id})`, { order: seg.order, source_id: seg.source_id });
    }
    const common = { source_checksum: checksum, fit: seg.fit, w: width, h: height, fps, has_audio: seg.has_audio, codec };

    const bodyStart = mezzSeconds;
    const body = await renderMezz({
      keyFor: (e) => mezzCacheKey({ ...common, encoder: e, in: seg.in, out: seg.out }),
      source: seg.source_path, in: seg.in, out: seg.out, fit: seg.fit, has_audio: seg.has_audio, label: String(seg.order),
      onFraction: (f) => mezzProgress(bodyStart + f * (seg.out - seg.in)),
    });
    mezzSeconds += body.seconds;
    mezzProgress(mezzSeconds);

    let tail: { path: string; seconds: number; cached: boolean } | null = null;
    if (seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available) {
      const tailSeconds = seg.transition_out.seconds;
      // The tail carries `tail_seconds` in its own key, so changing the transition length (or the transition
      // kind) never invalidates the body it belongs to.
      tail = await renderMezz({
        keyFor: (e) => mezzCacheKey({ ...common, encoder: e, in: seg.out, out: seg.out + tailSeconds, tail_seconds: tailSeconds }),
        source: seg.source_path, in: seg.out, out: seg.out + tailSeconds, fit: seg.fit, has_audio: seg.has_audio, label: `${seg.order}-tail`,
      });
      mezzSeconds += tail.seconds;
      mezzProgress(mezzSeconds);
    }

    // Counted per SEGMENT (not per file) so `rendered + cached === total` always holds: a segment counts as
    // cached only when every mezzanine it needs was a hit.
    if (body.cached && (tail === null || tail.cached)) cached++;
    else rendered++;

    mezz.push({ order: seg.order, body: body.path, tail: tail?.path ?? null });
  }

  // ---- 3) clip_set: cuts/<order>.mp4 + manifest.json (the 5A `clip-set-complete` contract) ----
  const manifest: { order: number; source_id: string; seconds: number }[] = [];
  for (const seg of segs) {
    const ref = mezz.find((m) => m.order === seg.order)!;
    const dest = join(clipSetDir, `${String(seg.order).padStart(3, "0")}.mp4`);
    rmSync(dest, { force: true });
    try {
      linkSync(ref.body, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "ENOSYS") {
        throw new HarnessError("IO_ERROR", `clip_set link failed for segment ${seg.order}: ${(e as Error).message}`, { order: seg.order, source: ref.body, dest });
      }
      // Different volume (cache on D:, workspace on E:) or a filesystem with no hardlinks: a copy is the
      // documented fallback (spec §5.5).
      copyFileSync(ref.body, dest);
    }
    manifest.push({ order: seg.order, source_id: seg.source_id, seconds: round3(seg.out - seg.in) });
  }
  writeFileSync(join(clipSetDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // ---- 4) loudnorm measurement pass ----
  const episodePath = join(outDir, "full-episode.mp4");
  const finalInput = {
    ffmpeg: d.ffmpeg, composition, mezz, assPath: p.assPath,
    fontsDir: p.fontsDir !== undefined ? p.fontsDir : (composition.brand?.fonts_dir ?? null),
    out_path: episodePath,
    ...(p.safe_margin_px !== undefined ? { safe_margin_px: p.safe_margin_px } : {}),
  };

  // The measurement pass is audio-only (`-vn -f null -`), so `encoder` never reaches its argv; it is passed
  // for the shape of `FinalGraphInput` alone.
  reportProgress(MEASURE_AT, "loudnorm");
  const measure = await runProcess(spawnFn, finalArgs({ ...finalInput, encoder, loudnorm: null, measureOnly: true }).argv, remaining(), "loudnorm measure", false, { signal });
  const measured = parseLoudnorm(measure.stderr);
  if (measured === null) {
    throw new HarnessError("IO_ERROR", "loudnorm measure failed: ffmpeg printed no parsable loudnorm json", { stderr_tail: measure.stderr });
  }

  // ---- 5) the real encode ----
  // Starts from whatever the mezzanine tier settled on: if NVENC already died on a segment, there is no
  // point asking it for a 4K final encode first.
  let finalEncoder = encoder;
  let render: ProcResult;
  const episodeSeconds = segs.reduce((end, s) => Math.max(end, s.end), 0);
  const finalEncode = (choice: EncoderChoice, label: string): Promise<ProcResult> => {
    reportProgress(FINAL_FROM, "final_encode");
    const prog = withProgress(finalArgs({ ...finalInput, encoder: choice, loudnorm: measured.measured, measureOnly: false }).argv, episodeSeconds, (f) => reportProgress(FINAL_FROM + (100 - FINAL_FROM) * f, "final_encode"));
    return runProcess(spawnFn, prog.argv, remaining(), label, false, { signal, onStdoutLine: prog.onStdoutLine });
  };
  try {
    render = await finalEncode(finalEncoder, "final encode");
  } catch (e) {
    if (signal?.aborted || finalEncoder !== "nvenc" || !isHarnessError(e, "IO_ERROR")) throw e;
    warnings.push("nvenc_final_fallback");
    log("nvenc failed on the final encode; retrying once on cpu");
    rmSync(episodePath, { force: true });
    finalEncoder = "cpu";
    render = await finalEncode(finalEncoder, "final encode (cpu retry)");
  }

  const renderPass = parseLoudnorm(render.stderr);
  let loudness: RenderReport["loudness"] = null;
  if (renderPass === null) {
    // `render-valid` fails on a null `loudness`, which is the intended outcome: an episode whose delivered
    // loudness nobody measured is not one we ship.
    warnings.push("loudnorm_output_unparsed");
  } else {
    loudness = {
      integrated_lufs: round3(renderPass.output.output_i),
      true_peak_dbtp: round3(renderPass.output.output_tp),
      lra: round3(renderPass.output.output_lra),
    };
    // The second pass asks for `linear=true`; ffmpeg drops back to `dynamic` without failing whenever the
    // linear gain would breach `TP=-1` (mix crest factor > 13 dB). Its limiter then pins the true peak at
    // -1 dBTP and leaves the programme short of -14 LUFS, so `render-valid` fails on a band it could never
    // have hit. Record WHY, so the report says more than "integrated loudness out of range" (Task 11's real
    // 4K run, `docs/runbooks/studio-composition.md` mục 6).
    if (renderPass.output.normalization_type !== null && renderPass.output.normalization_type !== "linear") {
      warnings.push("loudnorm_not_linear");
      log(
        `loudnorm fell back from linear to ${renderPass.output.normalization_type} normalization ` +
          `(measured ${measured.measured.input_i} LUFS / ${measured.measured.input_tp} dBTP, crest ` +
          `${round3(measured.measured.input_tp - measured.measured.input_i)} dB > 13 dB); the delivered ` +
          `loudness may sit below the -14 LUFS target`,
      );
    }
  }

  // ---- 6) probe the episode, write the report, sweep the cache ----
  if (!existsSync(episodePath)) {
    throw new HarnessError("IO_ERROR", "final encode produced no file", { path: episodePath });
  }
  const probed = await d.prober.probe(episodePath);
  const report = RenderReportSchema.parse({
    schema_version: "harness.render-report/v1",
    encoder: finalEncoder,
    codec,
    output: {
      width: probed?.video?.width ?? width,
      height: probed?.video?.height ?? height,
      fps: probed?.video?.fps ?? fps,
      seconds: round3(probed?.duration_seconds ?? composition.total_seconds),
      bytes: statSync(episodePath).size,
    },
    segments: { total: segs.length, rendered, cached, mezz_seconds: round3(mezzSeconds) },
    transitions: composition.transitions,
    captions: {
      mode: composition.captions.mode,
      cues: composition.captions.cues.length,
      ...(composition.captions.reason !== undefined ? { reason: composition.captions.reason } : {}),
    },
    text_events: { total: composition.text_events.length, dropped: composition.text_dropped },
    music: {
      track_id: composition.music?.track_id ?? null,
      loop: composition.music?.loop ?? false,
      ...(composition.music_reason !== undefined ? { reason: composition.music_reason } : {}),
    },
    loudness,
    brand: composition.brand !== null ? "present" : "absent",
    warnings,
    render_seconds: secondsBetween(d.clock, startedAt),
    ffmpeg_version: await ffmpegVersion(spawnFn, d.ffmpeg),
  });

  writeFileSync(join(outDir, "render-report.json"), JSON.stringify(report, null, 2));
  const evicted = cacheEvict(d.cache);
  if (evicted.removed > 0) log(`mezz cache swept: ${evicted.removed} entries, ${evicted.bytes} bytes`);

  return { report, episodePath, clipSetDir };
}
