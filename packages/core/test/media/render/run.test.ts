import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CompositionSchema, newId, type Composition, type MediaProbe, type MediaProber } from "@harness/contracts";
import { probeNvenc, renderComposition, type RenderDeps, type RenderInput, type SpawnFn } from "../../../src/media/render/run.js";
import { hasFfmpeg } from "../../../../../tests/media.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
const SRC_B = "src_01JBBBBBBBBBBBBBBBBBBBBBBB";

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Minimal local `MediaProber` -- `@harness/core` never imports `@harness/adapter-ffprobe`, so the test
 * supplies its own (same approach as `packages/core/test/library/voices.test.ts`). */
function prober(): MediaProber {
  return {
    async probe(path: string): Promise<MediaProbe | null> {
      const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) return null;
      let parsed: { format?: { duration?: string; format_name?: string }; streams?: Record<string, unknown>[] };
      try {
        parsed = JSON.parse(r.stdout) as typeof parsed;
      } catch {
        return null;
      }
      const streams = parsed.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video");
      const a = streams.find((s) => s.codec_type === "audio");
      const rate = (s: Record<string, unknown>): number | null => {
        const [num, den] = String(s.avg_frame_rate ?? "0/0").split("/").map(Number);
        return num && den ? num / den : null;
      };
      const duration = Number(parsed.format?.duration);
      return {
        media: null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        mime_type: null,
        container: parsed.format?.format_name ?? null,
        video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: rate(v) } : null,
        audio: a ? { codec: String(a.codec_name), channels: Number(a.channels), sample_rate: Number(a.sample_rate) } : null,
      };
    },
  };
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed: ${r.stderr?.toString("utf8") ?? ""}`);
}

/** A small `testsrc2` clip (640x360, 25 fps), optionally with a sine tone. */
function makeClip(path: string, seconds: number, audio: boolean): void {
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25`];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  run(ffmpegPath(), args);
}

function makeTone(path: string, seconds: number, frequency: number): void {
  run(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`, "-t", String(seconds), "-c:a", "pcm_s16le", path]);
}

/** `max_volume` (dBFS) of a window of `file`; `null` when ffmpeg printed no volumedetect line. */
function maxVolumeDb(file: string, ss: number, t: number): number | null {
  const r = spawnSync(ffmpegPath(), ["-hide_banner", "-ss", String(ss), "-t", String(t), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(r.stderr ?? "");
  return m ? Number(m[1]) : null;
}

function segment(o: {
  order: number;
  source_id: string;
  source_path: string;
  in: number;
  out: number;
  start: number;
  end: number;
  has_audio: boolean;
  transition_out?: Composition["segments"][number]["transition_out"];
}): Composition["segments"][number] {
  return {
    order: o.order,
    source_id: o.source_id,
    source_path: o.source_path,
    in: o.in,
    out: o.out,
    start: o.start,
    end: o.end,
    fit: "scale_pad",
    has_audio: o.has_audio,
    transition_out: o.transition_out ?? { kind: "cut", seconds: 0.4, tail_available: false },
  };
}

function composition(overrides: Partial<Composition>): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 25, codec: "h264" },
    voice: "none",
    language: "en",
    total_seconds: 0,
    request_id: newId("content_request"),
    brand: null,
    segments: [],
    text_events: [],
    captions: { mode: "none", cues: [] },
    music: null,
    logo: null,
    narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
    ...overrides,
  });
}

function deps(cacheDir: string): RenderDeps {
  return {
    ffmpeg: ffmpegPath(),
    prober: prober(),
    cache: { dir: cacheDir, maxBytes: 4 * 1024 * 1024 * 1024 },
    nvencAvailable: async () => false,
    clock: { now: () => new Date().toISOString() },
  };
}

function input(o: Partial<RenderInput> & { composition: Composition; outDir: string; sourceChecksums: ReadonlyMap<string, string> }): RenderInput {
  return { assPath: null, encoderCfg: "cpu", timeoutSeconds: 600, ...o };
}

// ---- fake ffmpeg, for the encoder-fallback and process-failure paths (no GPU, no ffmpeg needed) ----

/** One real `loudnorm` json block, so the measurement and render passes both parse. */
const LOUDNORM_STDERR = [
  "[Parsed_loudnorm_5 @ 0x1]",
  "{",
  '\t"input_i" : "-23.47",',
  '\t"input_tp" : "-4.61",',
  '\t"input_lra" : "6.70",',
  '\t"input_thresh" : "-33.86",',
  '\t"output_i" : "-14.03",',
  '\t"output_tp" : "-1.49",',
  '\t"output_lra" : "6.60",',
  '\t"output_thresh" : "-24.40",',
  '\t"normalization_type" : "linear",',
  '\t"target_offset" : "0.03"',
  "}",
].join("\n");

/** `LOUDNORM_STDERR` with a different `normalization_type` -- ffmpeg's answer when it could not honour
 * `linear=true` (Task 11: mix crest factor above the 13 dB the -14 LUFS / -1 dBTP pair allows). */
const loudnormStderr = (normalizationType: string): string =>
  LOUDNORM_STDERR.replace('"normalization_type" : "linear"', `"normalization_type" : "${normalizationType}"`);

interface FakePlan {
  /** Exit code the child reports; `null` stands for "killed by a signal". Defaults to 0. */
  exit?: number | null;
  /** Never exit and never emit anything, so `runProcess`'s own timer has to kill it. */
  hang?: boolean;
  /** stderr this call streams instead of the canned `LOUDNORM_STDERR`. */
  stderr?: string;
}

/**
 * A `SpawnFn` that behaves enough like ffmpeg for `renderComposition`: it streams a canned loudnorm block on
 * stderr and, for any successful encode (an argv carrying `-y` and a real output path), writes a few bytes
 * to that path so the runner's `statSync`/link/commit steps have a file to work with. `plan` decides per
 * call what happens, by argv and by call index.
 */
function fakeSpawn(plan: (argv: string[], index: number) => FakePlan = () => ({})): { spawn: SpawnFn; calls: string[][]; kills: () => number } {
  const calls: string[][] = [];
  let kills = 0;

  const spawn = ((bin: string, args: readonly string[]) => {
    const argv = [bin, ...args];
    const index = calls.length;
    calls.push(argv);
    const p = plan(argv, index);
    const exit = p.exit === undefined ? 0 : p.exit;

    const child = new EventEmitter() as EventEmitter & { stderr: Readable; stdout: Readable | null; kill: () => boolean };
    const err = new Readable({ read() {} });
    child.stderr = err;
    child.stdout = null;
    child.kill = () => {
      kills++;
      child.emit("close", null);
      return true;
    };

    if (!p.hang) {
      // `close` only after stderr has fully drained, so the runner has really seen the loudnorm block by the
      // time it inspects it (a bare setTimeout races the stream).
      err.on("end", () => {
        const out = argv[argv.length - 1]!;
        if (exit === 0 && argv.includes("-y") && out !== "-") writeFileSync(out, Buffer.alloc(4096, 1));
        child.emit("close", exit);
      });
      setTimeout(() => {
        err.push(p.stderr ?? LOUDNORM_STDERR);
        err.push(null);
      }, 0);
    }
    return child as unknown as ReturnType<SpawnFn>;
  }) as unknown as SpawnFn;

  return { spawn, calls, kills: () => kills };
}

/** Answers every probe with the same 2-second 4K/48 kHz stereo shape the fake compositions below expect. */
function fakeProber(): MediaProber {
  return {
    async probe(): Promise<MediaProbe | null> {
      return {
        media: null, duration_seconds: 2, mime_type: null, container: "mp4",
        video: { codec: "h264", width: 3840, height: 2160, fps: 25 },
        audio: { codec: "aac", channels: 2, sample_rate: 48000 },
      };
    },
  };
}

/** Two 2-second segments off one (never-read) source path. */
function fakeComposition(): Composition {
  return composition({
    total_seconds: 4,
    segments: [
      segment({ order: 0, source_id: SRC_A, source_path: "/abs/a.mp4", in: 0, out: 2, start: 0, end: 2, has_audio: true }),
      segment({ order: 1, source_id: SRC_A, source_path: "/abs/a.mp4", in: 2, out: 4, start: 2, end: 4, has_audio: true }),
    ],
  });
}

function fakeWorld(o: { spawn: SpawnFn; nvenc: boolean }): { d: RenderDeps; outDir: string } {
  return {
    d: {
      ffmpeg: "ffmpeg",
      prober: fakeProber(),
      cache: { dir: join(tempDir("fake-cache-"), "mezz"), maxBytes: 1024 * 1024 * 1024 },
      nvencAvailable: async () => o.nvenc,
      clock: { now: () => new Date().toISOString() },
      spawn: o.spawn,
    },
    outDir: join(tempDir("fake-out-"), "out"),
  };
}

const CHECKSUMS = new Map([[SRC_A, "sha256:" + "f".repeat(64)]]);

describe("probeNvenc", () => {
  it("answers false (never throws) for a binary that cannot run at all", async () => {
    await expect(probeNvenc(join(tempDir("no-ffmpeg-"), "definitely-not-ffmpeg"))).resolves.toBe(false);
  });
});

describe("renderComposition (fake ffmpeg)", () => {
  it("an ffmpeg binary that cannot be spawned at all is CONFIG_INVALID, not a transient IO_ERROR", async () => {
    const outDir = join(tempDir("missing-ffmpeg-out-"), "out");
    const d: RenderDeps = {
      ffmpeg: join(tempDir("missing-ffmpeg-"), "definitely-not-ffmpeg"),
      prober: fakeProber(),
      cache: { dir: join(tempDir("missing-ffmpeg-cache-"), "mezz"), maxBytes: 1024 * 1024 },
      nvencAvailable: async () => false,
      clock: { now: () => new Date().toISOString() },
    };
    await expect(renderComposition(d, input({ composition: fakeComposition(), outDir, sourceChecksums: CHECKSUMS })))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("ffmpeg not available") });
  });

  it("nvenc failing on one segment falls the WHOLE run back to cpu, with a single warning", async () => {
    // Call 0 is the first mezzanine, on nvenc; everything after it succeeds.
    const { spawn, calls } = fakeSpawn((_argv, i) => (i === 0 ? { exit: 1 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: true });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS }));

    expect(report.warnings.filter((w) => w.startsWith("nvenc_segment_fallback"))).toEqual(["nvenc_segment_fallback:0"]);
    expect(report.encoder).toBe("cpu");
    expect(report.segments).toMatchObject({ total: 2, rendered: 2, cached: 0 });
    // Only the one attempt ever asked for NVENC: segment 1 and the final encode went straight to cpu.
    expect(calls.filter((c) => c.includes("h264_nvenc"))).toHaveLength(1);
  });

  it("nvenc failing on the final encode retries once on cpu, leaving the mezzanines alone", async () => {
    let finalAttempts = 0;
    const { spawn, calls } = fakeSpawn((argv) => {
      if (!argv.includes("[vout]")) return {};
      finalAttempts++;
      return finalAttempts === 1 ? { exit: 1 } : {};
    });
    const { d, outDir } = fakeWorld({ spawn, nvenc: true });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).toContain("nvenc_final_fallback");
    expect(report.warnings.some((w) => w.startsWith("nvenc_segment_fallback"))).toBe(false);
    expect(report.encoder).toBe("cpu");
    // Both mezzanines plus the failed final attempt used NVENC; the retry did not.
    expect(calls.filter((c) => c.includes("h264_nvenc"))).toHaveLength(3);
    expect(finalAttempts).toBe(2);
  });

  // Task 11 (the real 4K run): a mix whose true peak sits 17.9 dB above its integrated loudness cannot be
  // lifted to -14 LUFS without breaching TP=-1, so ffmpeg answers `linear=true` with `dynamic` normalization,
  // pins the peak at -1 dBTP and delivers ~-16 LUFS -- which `render-valid` then rejects with nothing but
  // "integrated loudness out of range" to go on. The report has to say that the fallback happened.
  it("warns loudnorm_not_linear when the final pass reports dynamic normalization", async () => {
    // Only the FINAL encode (the pass carrying the video output label) answers `dynamic`; the measurement
    // pass legitimately always runs dynamic and must not raise the warning on its own.
    const { spawn } = fakeSpawn((argv) => (argv.includes("[vout]") ? { stderr: loudnormStderr("dynamic") } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).toContain("loudnorm_not_linear");
    // The measured numbers still go into the report: the episode is delivered, `render-valid` judges it.
    expect(report.loudness).toMatchObject({ integrated_lufs: -14.03, true_peak_dbtp: -1.49 });
  });

  it("does not warn loudnorm_not_linear when the final pass really normalized linearly", async () => {
    const { spawn } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).not.toContain("loudnorm_not_linear");
  });

  it('encoderCfg "nvenc" on a machine without NVENC warns and never emits an nvenc argv', async () => {
    const { spawn, calls } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "nvenc", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).toContain("nvenc_unavailable_cpu_fallback");
    expect(report.encoder).toBe("cpu");
    expect(calls.some((c) => c.some((a) => a.includes("nvenc")))).toBe(false);
  });

  it("an ffmpeg killed by a signal (exit code null) is an IO_ERROR", async () => {
    const { spawn } = fakeSpawn((_argv, i) => (i === 0 ? { exit: null } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    await expect(renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS })))
      .rejects.toMatchObject({ code: "IO_ERROR", message: expect.stringContaining("exited null") });
  });

  it("an ffmpeg that never exits is killed on the timeout and reported as an IO_ERROR", async () => {
    const { spawn, kills } = fakeSpawn((_argv, i) => (i === 0 ? { hang: true } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    await expect(renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", timeoutSeconds: 1, sourceChecksums: CHECKSUMS })))
      .rejects.toMatchObject({ code: "IO_ERROR", message: expect.stringContaining("timed out") });
    expect(kills()).toBe(1);
  }, 20_000);
});

describe.skipIf(!hasFfmpeg())("renderComposition (needs ffmpeg)", () => {
  it("renders a two-segment episode at 3840x2160 with a clip_set, and the same cache serves a second run", async () => {
    const srcDir = tempDir("render-src-");
    const a = join(srcDir, "a.mp4");
    const b = join(srcDir, "b.mp4");
    makeClip(a, 3, true);
    makeClip(b, 3, false);

    // Deliberately NOT frame-aligned at 25 fps: 1.37s and 2.11s both land mid-frame, which is exactly where
    // per-segment duration drift would show up in the concatenated total.
    const comp = composition({
      total_seconds: 3.48,
      segments: [
        segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 1.37, start: 0, end: 1.37, has_audio: true }),
        segment({ order: 1, source_id: SRC_B, source_path: b, in: 0, out: 2.11, start: 1.37, end: 3.48, has_audio: false }),
      ],
    });
    const checksums = new Map([[SRC_A, "sha256:" + "a".repeat(64)], [SRC_B, "sha256:" + "b".repeat(64)]]);
    const cacheDir = join(tempDir("render-cache-"), "mezz");
    const d = deps(cacheDir);

    const outDir = join(tempDir("render-out-"), "out");
    const first = await renderComposition(d, input({ composition: comp, outDir, sourceChecksums: checksums }));

    expect(existsSync(first.episodePath)).toBe(true);
    const probed = await d.prober.probe(first.episodePath);
    expect(probed?.video).not.toBeNull();
    expect(probed?.video?.width).toBe(3840);
    expect(probed?.video?.height).toBe(2160);
    expect(probed?.audio?.sample_rate).toBe(48000);
    expect(probed?.audio?.channels).toBe(2);
    expect(Math.abs((probed?.duration_seconds ?? 0) - 3.48)).toBeLessThanOrEqual(0.1);

    const cut0 = join(first.clipSetDir, "000.mp4");
    const cut1 = join(first.clipSetDir, "001.mp4");
    expect(existsSync(cut0)).toBe(true);
    expect(existsSync(cut1)).toBe(true);
    expect(Math.abs(((await d.prober.probe(cut0))?.duration_seconds ?? 0) - 1.37)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(((await d.prober.probe(cut1))?.duration_seconds ?? 0) - 2.11)).toBeLessThanOrEqual(0.05);
    expect(JSON.parse(readFileSync(join(first.clipSetDir, "manifest.json"), "utf8"))).toEqual([
      { order: 0, source_id: SRC_A, seconds: 1.37 },
      { order: 1, source_id: SRC_B, seconds: 2.11 },
    ]);

    expect(first.report.segments).toMatchObject({ total: 2, rendered: 2, cached: 0 });
    expect(first.report.encoder).toBe("cpu");
    expect(first.report.codec).toBe("h264");
    expect(first.report.brand).toBe("absent");
    expect(first.report.output.width).toBe(3840);
    expect(first.report.output.height).toBe(2160);
    expect(first.report.output.bytes).toBeGreaterThan(0);
    expect(first.report.ffmpeg_version).not.toBe("unknown");
    expect(first.report.loudness).not.toBeNull();
    expect(first.report.loudness!.integrated_lufs).toBeGreaterThanOrEqual(-16);
    expect(first.report.loudness!.integrated_lufs).toBeLessThanOrEqual(-12);
    // `render-report.json` lands next to the episode so the stage can declare it as an output verbatim.
    expect(existsSync(join(outDir, "render-report.json"))).toBe(true);

    // Truncate one of the two cached mezzanines, leaving its sidecar intact: the key still hits, but the
    // file no longer probes to the right length, so spec §7 says delete it and render that segment again.
    const cachedFiles = readdirSync(cacheDir).filter((n) => n.endsWith(".mp4")).sort();
    expect(cachedFiles).toHaveLength(2);
    writeFileSync(join(cacheDir, cachedFiles[0]!), Buffer.alloc(1024, 0));

    const outDirCorrupt = join(tempDir("render-out-c-"), "out");
    const afterCorrupt = await renderComposition(d, input({ composition: comp, outDir: outDirCorrupt, sourceChecksums: checksums }));
    expect(afterCorrupt.report.segments).toMatchObject({ total: 2, rendered: 1, cached: 1 });

    // Third run, same (now healthy) cache, fresh output dir: no mezzanine is re-encoded.
    const outDir2 = join(tempDir("render-out2-"), "out");
    const second = await renderComposition(d, input({ composition: comp, outDir: outDir2, sourceChecksums: checksums }));
    expect(second.report.segments).toMatchObject({ total: 2, rendered: 0, cached: 2 });
    expect(Math.abs(((await d.prober.probe(second.episodePath))?.duration_seconds ?? 0) - 3.48)).toBeLessThanOrEqual(0.1);
  }, 240_000);

  it("a dissolve between two segments keeps the total duration and is counted as applied", async () => {
    const srcDir = tempDir("render-src-x-");
    const a = join(srcDir, "a.mp4");
    const b = join(srcDir, "b.mp4");
    makeClip(a, 3, true);
    makeClip(b, 3, true);

    const comp = composition({
      total_seconds: 4,
      segments: [
        segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 2, start: 0, end: 2, has_audio: true, transition_out: { kind: "dissolve", seconds: 0.4, tail_available: true } }),
        segment({ order: 1, source_id: SRC_B, source_path: b, in: 0, out: 2, start: 2, end: 4, has_audio: true }),
      ],
      transitions: { requested: 1, applied: 1, downgraded: [] },
    });
    const checksums = new Map([[SRC_A, "sha256:" + "c".repeat(64)], [SRC_B, "sha256:" + "d".repeat(64)]]);
    const d = deps(join(tempDir("render-cache-x-"), "mezz"));
    const res = await renderComposition(d, input({ composition: comp, outDir: join(tempDir("render-out-x-"), "out"), sourceChecksums: checksums }));

    expect(Math.abs(((await d.prober.probe(res.episodePath))?.duration_seconds ?? 0) - 4)).toBeLessThanOrEqual(0.1);
    expect(res.report.transitions.applied).toBe(1);
    expect(res.report.segments.total).toBe(2);
    // The clip_set keeps the BODY length (2s), not body+tail.
    expect(Math.abs(((await d.prober.probe(join(res.clipSetDir, "000.mp4")))?.duration_seconds ?? 0) - 2)).toBeLessThanOrEqual(0.05);
  }, 240_000);

  it("tts narration and looped music both reach the mix", async () => {
    const srcDir = tempDir("render-src-m-");
    const a = join(srcDir, "a.mp4");
    makeClip(a, 3, false);
    const wav = join(srcDir, "line.wav");
    makeTone(wav, 1, 440);
    const music = join(srcDir, "music.wav");
    makeTone(music, 3, 220);

    const comp = composition({
      total_seconds: 4,
      voice: "tts",
      segments: [
        segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 2, start: 0, end: 2, has_audio: false }),
        segment({ order: 1, source_id: SRC_A, source_path: a, in: 0, out: 2, start: 2, end: 4, has_audio: false }),
      ],
      narration: [{ line_id: "l1", wav, start: 0.5, end: 1.5 }],
      music: {
        track_id: "trk", path: music, loop: true, fade_in: 1, fade_out: 3,
        cues: [{ start: 0, end: 4, gain_db: -18 }],
        duck: { windows: [{ start: 0.5, end: 1.5 }], gain_db: -12, attack_ms: 150, release_ms: 600 },
      },
    });
    const checksums = new Map([[SRC_A, "sha256:" + "e".repeat(64)]]);
    const d = deps(join(tempDir("render-cache-m-"), "mezz"));
    const res = await renderComposition(d, input({ composition: comp, outDir: join(tempDir("render-out-m-"), "out"), sourceChecksums: checksums }));

    expect(Math.abs(((await d.prober.probe(res.episodePath))?.duration_seconds ?? 0) - 4)).toBeLessThanOrEqual(0.1);
    // Narration is audible at t=1 (mid-line) ...
    const voiceDb = maxVolumeDb(res.episodePath, 0.9, 0.2);
    expect(voiceDb).not.toBeNull();
    expect(voiceDb!).toBeGreaterThan(-60);
    // ... and the 3s music track, looped, is still audible at 3.5s (past its own length).
    const musicDb = maxVolumeDb(res.episodePath, 3.4, 0.2);
    expect(musicDb).not.toBeNull();
    expect(musicDb!).toBeGreaterThan(-60);
    expect(res.report.music).toMatchObject({ track_id: "trk", loop: true });
  }, 240_000);

  it("a segment whose source_id has no checksum is a CONFIG_INVALID, before any ffmpeg runs", async () => {
    const srcDir = tempDir("render-src-e-");
    const a = join(srcDir, "a.mp4");
    makeClip(a, 2, true);
    const comp = composition({
      total_seconds: 1,
      segments: [segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 1, start: 0, end: 1, has_audio: true })],
    });
    const outDir = join(tempDir("render-out-e-"), "out");
    mkdirSync(outDir, { recursive: true });
    const d = deps(join(tempDir("render-cache-e-"), "mezz"));
    await expect(renderComposition(d, input({ composition: comp, outDir, sourceChecksums: new Map() }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  }, 60_000);
});
