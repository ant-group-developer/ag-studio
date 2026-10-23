import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CompositionSchema, newId, type Composition, type MediaProbe, type MediaProber } from "@harness/contracts";
import { filterGraphFileOption, probeNvenc, renderComposition, stderrSummary, type RenderDeps, type RenderInput, type SpawnFn } from "../../../src/media/render/run.js";
import { hasFfmpeg } from "../../../../../tests/media.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
const SRC_B = "src_01JBBBBBBBBBBBBBBBBBBBBBBB";

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

/** Every `mkdtemp` directory this file made (sources, mezzanine caches, output dirs -- 4K episodes among
 * them), deleted once the file is done instead of being left in the OS temp directory. */
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a file still held open must not fail the suite.
    }
  }
});

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

/** The tail of the real ffmpeg 7.1.5 final encode that failed with exit 234 on a dissolve (2026-10-08). */
const XFADE_EINVAL_STDERR = [
  "  Stream #93:0 (pcm_s16le) -> adelay:default",
  "  format:default -> Stream #0:0 (libx264)",
  "  loudnorm:default -> Stream #0:1 (aac)",
  "Press [q] to stop, [?] for help",
  "[Parsed_ass_36 @ 0x75e424ba1580] libass API version: 0x1703000",
  "[Parsed_ass_36 @ 0x75e424ba1580] Added subtitle file: '/work/j/overlay.ass' (6 styles, 37 events)",
  "[Parsed_xfade_15 @ 0x75e424b89c00] The inputs needs to be a constant frame rate; current rate of 1/0 is invalid",
  "[Parsed_xfade_15 @ 0x75e424b89c00] Failed to configure output pad on Parsed_xfade_15",
  "[fc#0 @ 0x5c39baae9940] Error reinitializing filters!",
  "[fc#0 @ 0x5c39baae9940] Task finished with error code: -22 (Invalid argument)",
  "[fc#0 @ 0x5c39baae9940] Terminating thread with return code -22 (Invalid argument)",
  "[aost#0:1/aac @ 0x5c39bab56000] Could not open encoder before EOF",
  "[aost#0:1/aac @ 0x5c39bab56000] Task finished with error code: -22 (Invalid argument)",
  "[vost#0:0/libx264 @ 0x5c39bab86740] Could not open encoder before EOF",
  "[out#0/mp4 @ 0x5c39bab5d9c0] Nothing was written into output file, because at least one of its streams received no packets.",
  "frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A    ",
  "Conversion failed!",
  "",
].join("\n");

interface FakePlan {
  /** Exit code the child reports; `null` stands for "killed by a signal". Defaults to 0. */
  exit?: number | null;
  /** Never exit and never emit anything, so `runProcess`'s own timer has to kill it. */
  hang?: boolean;
  /** stderr this call streams instead of the canned `LOUDNORM_STDERR`. */
  stderr?: string;
  /** stdout this call streams (e.g. `-progress pipe:1` lines); none by default. */
  stdout?: string;
  /** How long the call runs before it streams its output and exits, in ms (default 0). */
  delayMs?: number;
}

/**
 * A `SpawnFn` that behaves enough like ffmpeg for `renderComposition`: it streams a canned loudnorm block on
 * stderr and, for any successful encode (an argv carrying `-y` and a real output path), writes a few bytes
 * to that path so the runner's `statSync`/link/commit steps have a file to work with. `plan` decides per
 * call what happens, by argv and by call index.
 */
function fakeSpawn(plan: (argv: string[], index: number) => FakePlan = () => ({})): { spawn: SpawnFn; calls: string[][]; options: Record<string, unknown>[]; graphs: (string | null)[]; kills: () => number; maxRunning: () => number } {
  const calls: string[][] = [];
  const options: Record<string, unknown>[] = [];
  /** Per call, the filtergraph it read from a file (the file is gone once the render is over). */
  const graphs: (string | null)[] = [];
  let kills = 0;
  /** Children spawned and not closed yet, and the most there ever were at once. */
  let running = 0;
  let maxRunning = 0;

  const spawn = ((bin: string, args: readonly string[], opts: Record<string, unknown>) => {
    const argv = [bin, ...args];
    const index = calls.length;
    calls.push(argv);
    options.push(opts);
    const at = argv.findIndex((a) => a === "-/filter_complex" || a === "-filter_complex_script");
    graphs.push(at >= 0 ? readFileSync(argv[at + 1]!, "utf8") : null);
    const p = plan(argv, index);
    const exit = p.exit === undefined ? 0 : p.exit;
    running++;
    maxRunning = Math.max(maxRunning, running);

    const child = new EventEmitter() as EventEmitter & { stderr: Readable; stdout: Readable | null; kill: () => boolean };
    const err = new Readable({ read() {} });
    child.stderr = err;
    const out = p.stdout !== undefined ? new Readable({ read() {} }) : null;
    child.stdout = out;
    if (out !== null) {
      setTimeout(() => {
        out.push(p.stdout);
        out.push(null);
      }, 0);
    }
    let closed = false;
    const close = (code: number | null): void => {
      if (closed) return;
      closed = true;
      running--;
      child.emit("close", code);
    };
    child.kill = () => {
      kills++;
      close(null);
      return true;
    };

    if (!p.hang) {
      // `close` only after stderr has fully drained, so the runner has really seen the loudnorm block by the
      // time it inspects it (a bare setTimeout races the stream).
      err.on("end", () => {
        const out = argv[argv.length - 1]!;
        if (closed) return;
        // the file says which call made it (`-ss <in>` names a mezzanine's segment), padded to a few KB
        if (exit === 0 && argv.includes("-y") && out !== "-") writeFileSync(out, Buffer.concat([Buffer.from(argv.join(" ")), Buffer.alloc(4096, 1)]));
        close(exit);
      });
      setTimeout(() => {
        err.push(p.stderr ?? LOUDNORM_STDERR);
        err.push(null);
      }, p.delayMs ?? 0);
    }
    return child as unknown as ReturnType<SpawnFn>;
  }) as unknown as SpawnFn;

  return { spawn, calls, options, graphs, kills: () => kills, maxRunning: () => maxRunning };
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

describe("stderrSummary", () => {
  it("picks the cause, not ffmpeg's -22 cascade after it, and drops the per-run filter addresses", () => {
    expect(stderrSummary(XFADE_EINVAL_STDERR)).toBe(
      "[Parsed_xfade_15] The inputs needs to be a constant frame rate; current rate of 1/0 is invalid | [Parsed_xfade_15] Failed to configure output pad on Parsed_xfade_15",
    );
  });

  it("names a stream the filtergraph maps but the source lacks (a video-only clip marked has_audio), as ffmpeg 6.1 on Windows prints it", () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'asset_x.mp4':",
      "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1920x1080, 25 fps",
      `[fc#0 @ 000001b9a48f0dc0] Stream specifier ':a' in filtergraph description [0:v]scale=1920:1080,${"eq=contrast=1.1,".repeat(30)}fps=25,format=yuv420p[v];[0:a]aresample=48000,aformat=channel_layouts=stereo[a] matches no streams.`,
      "Error initializing complex filters: Invalid argument",
    ].join("\r\n");
    expect(stderrSummary(stderr)).toBe("[fc#0] Stream specifier ':a' in the filtergraph matches no streams. | Error initializing complex filters: Invalid argument");
  });

  it("falls back to the last meaningful line when nothing looks like an error", () => {
    expect(stderrSummary("Input #0, mov,mp4\n  Duration: 00:00:02.00\nsomething odd happened\nConversion failed!\n")).toBe("something odd happened");
  });

  it("is empty for an empty stderr and capped for a huge line", () => {
    expect(stderrSummary("")).toBe("");
    const s = stderrSummary(`error: ${"x".repeat(5000)}`);
    expect(s.length).toBe(600);
    expect(s.endsWith("...")).toBe(true);
  });
});

describe("probeNvenc", () => {
  it("answers false (never throws) for a binary that cannot run at all", async () => {
    await expect(probeNvenc(join(tempDir("no-ffmpeg-"), "definitely-not-ffmpeg"))).resolves.toBe(false);
  });
});

describe("renderComposition progress and cancel", () => {
  it("reports progress through mezzanine, loudnorm and the final encode up to 100", async () => {
    const { spawn, calls } = fakeSpawn((argv) => (argv.includes("-progress") ? { stdout: "frame=10\nout_time=00:00:01.000000\nout_time=00:00:04.000000\nprogress=end\n" } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const seen: [number, string][] = [];
    const { timings } = await renderComposition(d, input({ composition: fakeComposition(), outDir, sourceChecksums: CHECKSUMS, onProgress: (pct, stage) => seen.push([pct, stage]) }));
    expect(Object.keys(timings).sort()).toEqual(["even_s", "final_encode_s", "final_slices", "loudnorm_s", "mezz_s", "source_wait_s"]);
    expect(timings.final_slices).toBe(1);
    expect(Object.values(timings).every((s) => s >= 0)).toBe(true);

    const stages = [...new Set(seen.map(([, st]) => st))];
    expect(stages).toEqual(["mezzanine", "loudnorm", "final_encode"]);
    const pcts = seen.map(([pct]) => pct);
    expect(pcts.every((v, i) => i === 0 || v >= pcts[i - 1]!)).toBe(true);
    expect(pcts[pcts.length - 1]).toBe(100);
    // Every encode asked ffmpeg for progress; the loudnorm measure pass did not.
    expect(calls.filter((c) => c.includes("-progress")).length).toBe(3);
  });

  it("a cancelled render kills the running ffmpeg and does not fall back to cpu", async () => {
    const { spawn, calls, kills } = fakeSpawn(() => ({ hang: true }));
    const { d, outDir } = fakeWorld({ spawn, nvenc: true });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS, signal: ctrl.signal })))
      .rejects.toMatchObject({ code: "IO_ERROR", message: expect.stringContaining("aborted") });
    expect(kills()).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

/** `n` 2-second segments off one source, back to back; `inPoints` overrides where each one starts in it. */
function segmentsComposition(n: number, inPoints: number[] = Array.from({ length: n }, (_, k) => 2 * k)): Composition {
  return composition({
    total_seconds: 2 * n,
    segments: inPoints.map((at, k) => segment({ order: k, source_id: SRC_A, source_path: "/abs/a.mp4", in: at, out: at + 2, start: 2 * k, end: 2 * k + 2, has_audio: true })),
  });
}

const isMezz = (argv: string[]): boolean => argv.includes("-ss");

describe("renderComposition mezzanines in parallel", () => {
  it("never runs more than mezzConcurrency at once, and the clip set keeps the timeline order", async () => {
    // later segments finish first: the order must come from the timeline, not from who is done
    const { spawn, calls, maxRunning } = fakeSpawn((argv) => (isMezz(argv) ? { delayMs: 60 - 8 * Number(argv[argv.indexOf("-ss") + 1]) / 2 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const { report } = await renderComposition(d, input({ composition: segmentsComposition(6), outDir, sourceChecksums: CHECKSUMS, mezzConcurrency: 3 }));

    expect(calls.filter(isMezz)).toHaveLength(6);
    expect(maxRunning()).toBe(3);
    expect(report.segments).toMatchObject({ total: 6, rendered: 6, cached: 0 });
    for (let k = 0; k < 6; k++) {
      expect(readFileSync(join(outDir, "cuts", `00${k}.mp4`)).subarray(0, 600).toString()).toContain(`-ss ${2 * k} -to ${2 * k + 2} `);
    }
  });

  it("the same shot used twice is encoded once, and the second use counts as cached", async () => {
    const { spawn, calls } = fakeSpawn((argv) => (isMezz(argv) ? { delayMs: 30 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const { report } = await renderComposition(d, input({ composition: segmentsComposition(3, [0, 0, 4]), outDir, sourceChecksums: CHECKSUMS, mezzConcurrency: 3 }));

    expect(calls.filter(isMezz).map((c) => c[c.indexOf("-ss") + 1])).toEqual(["0", "4"]);
    expect(report.segments).toMatchObject({ total: 3, rendered: 2, cached: 1 });
  });

  it("a failing mezzanine stops the others: nothing new starts, the running ones are killed, its error is thrown", async () => {
    const { spawn, calls, kills } = fakeSpawn((argv) => {
      if (!isMezz(argv)) return {};
      return argv[argv.indexOf("-ss") + 1] === "2" ? { exit: 1, stderr: "/abs/a.mp4: Invalid data found when processing input" } : { delayMs: 500 };
    });
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    await expect(renderComposition(d, input({ composition: segmentsComposition(6), outDir, sourceChecksums: CHECKSUMS, mezzConcurrency: 3 })))
      .rejects.toMatchObject({ code: "IO_ERROR", message: expect.stringContaining("mezzanine 1: ffmpeg exited 1: /abs/a.mp4: Invalid data") });
    expect(calls.filter(isMezz)).toHaveLength(3);
    expect(kills()).toBe(2);
  });

  it("nvenc failing on every running mezzanine: each retries on cpu, the run warns once and ends on cpu", async () => {
    const { spawn, calls } = fakeSpawn((argv) => (isMezz(argv) && argv.includes("h264_nvenc") ? { exit: 1, delayMs: 20 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: true });
    const { report } = await renderComposition(d, input({ composition: segmentsComposition(3), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS, mezzConcurrency: 3 }));

    expect(calls.filter((c) => isMezz(c) && c.includes("h264_nvenc"))).toHaveLength(3);
    expect(calls.filter((c) => isMezz(c) && c.includes("libx264"))).toHaveLength(3);
    expect(report.warnings.filter((w) => w.startsWith("nvenc_segment_fallback"))).toHaveLength(1);
    expect(report.encoder).toBe("cpu");
  });
});

/** A prober for the fake ffmpeg's files: a mezzanine is as long as the `-ss`/`-to` it was made with, anything else 2 s. */
function argvProber(): MediaProber {
  return {
    async probe(path: string): Promise<MediaProbe | null> {
      const head = existsSync(path) ? readFileSync(path).subarray(0, 600).toString() : "";
      const m = / -ss (\S+) -to (\S+) /.exec(head);
      return {
        media: null, duration_seconds: m ? Number(m[2]) - Number(m[1]) : 2, mime_type: null, container: "mp4",
        video: { codec: "h264", width: 3840, height: 2160, fps: 25 }, audio: { codec: "aac", channels: 2, sample_rate: 48000 },
      };
    },
  };
}

describe("renderComposition with sourceFor (sources still downloading)", () => {
  it("each segment starts once its own source is ready, on the file, checksum and out the hook answers", async () => {
    const events: string[] = [];
    const { spawn, calls } = fakeSpawn((argv) => {
      if (isMezz(argv)) events.push(`mezz:${argv[argv.indexOf("-ss") + 1]}`);
      return {};
    });
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    d.prober = argvProber();
    const sourceFor = async (seg: Composition["segments"][number]) => {
      await new Promise((r) => setTimeout(r, 60 * seg.order));
      events.push(`ready:${seg.order}`);
      // the last source turned out shorter than the timeline thought: its out is cut to 5.5
      return { path: `/dl/a-${seg.order}.mp4`, checksum: "sha256:" + String(seg.order).repeat(64), out: seg.order === 2 ? 5.5 : seg.out };
    };
    const { report, timings, clipSetDir } = await renderComposition(d, input({
      composition: segmentsComposition(3), outDir, sourceChecksums: new Map(), mezzConcurrency: 3, sourceFor,
    }));

    expect(events).toEqual(["ready:0", "mezz:0", "ready:1", "mezz:2", "ready:2", "mezz:4"]);
    const mezz = calls.filter(isMezz);
    expect(mezz.map((c) => c[c.indexOf("-i") + 1])).toEqual(["/dl/a-0.mp4", "/dl/a-1.mp4", "/dl/a-2.mp4"]);
    expect(mezz[2]!.slice(mezz[2]!.indexOf("-ss"), mezz[2]!.indexOf("-ss") + 4)).toEqual(["-ss", "4", "-to", "5.5"]);
    expect(JSON.parse(readFileSync(join(clipSetDir, "manifest.json"), "utf8")).map((m: { seconds: number }) => m.seconds)).toEqual([2, 2, 1.5]);
    expect(report.segments).toMatchObject({ total: 3, rendered: 3 });
    expect(timings.source_wait_s).toBeGreaterThan(0.1);
  });

  it("a source file with no audio stream is built silent, whatever the composition says", async () => {
    const { spawn, calls } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const sourceFor = async (seg: Composition["segments"][number]) =>
      ({ path: `/dl/a-${seg.order}.mp4`, checksum: "sha256:" + String(seg.order).repeat(64), out: seg.out, ...(seg.order === 0 ? { has_audio: false } : {}) });
    await renderComposition(d, input({ composition: segmentsComposition(2), outDir, sourceChecksums: new Map(), sourceFor }));

    const [silent, sounding] = calls.filter(isMezz);
    expect(silent!.join(" ")).toContain("anullsrc");
    expect(silent!.join(" ")).not.toContain("[0:a]");
    expect(sounding!.join(" ")).toContain("[0:a]aresample");
  });

  it("a source that fails stops the run at once, without waiting for the others still downloading", async () => {
    const { spawn, calls } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const sourceFor = (seg: Composition["segments"][number]) =>
      seg.order === 1
        ? new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fetch failed")), 20))
        : seg.order === 0 ? Promise.resolve({ path: "/dl/a.mp4", checksum: "sha256:" + "a".repeat(64), out: seg.out }) : new Promise<never>(() => {});
    const started = Date.now();
    await expect(renderComposition(d, input({ composition: segmentsComposition(3), outDir, sourceChecksums: new Map(), mezzConcurrency: 3, sourceFor })))
      .rejects.toThrow("fetch failed");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls.filter(isMezz).map((c) => c[c.indexOf("-ss") + 1])).toEqual(["0"]);
  });
});

describe("renderComposition final encode in slices (fake ffmpeg)", () => {
  /** Six 40-second cuts: long enough for three slices of 80 s. */
  const longComposition = (): Composition =>
    composition({
      total_seconds: 240,
      segments: Array.from({ length: 6 }, (_, k) =>
        segment({ order: k, source_id: SRC_A, source_path: "/abs/a.mp4", in: k * 40, out: (k + 1) * 40, start: k * 40, end: (k + 1) * 40, has_audio: true })),
    });
  /** Answers a fake mezzanine's own `-t` (the fake writes its argv into the file), 2 s for anything else. */
  const lengthProber = (): MediaProber => ({
    async probe(path: string): Promise<MediaProbe | null> {
      const m = / -t (\d+(?:\.\d+)?) /.exec(readFileSync(path, "utf8"));
      return {
        media: null, duration_seconds: m ? Number(m[1]) : 2, mime_type: null, container: "mp4",
        video: { codec: "h264", width: 3840, height: 2160, fps: 25 }, audio: { codec: "aac", channels: 2, sample_rate: 48000 },
      };
    },
  });
  const isSlice = (argv: string[]): boolean => argv.includes("-an");
  const isSound = (argv: string[]): boolean => argv[argv.length - 1]!.endsWith("sound.m4a");

  it("every slice's picture and the sound run at once, then are joined; loudness comes from the sound pass", async () => {
    // only the sound pass prints a loudnorm block: the report's loudness can only have come from it
    const { spawn, calls, maxRunning } = fakeSpawn((argv) => (isSlice(argv) ? { stderr: "", delayMs: 20 } : isSound(argv) ? { delayMs: 20 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    d.prober = lengthProber();
    const seen: number[] = [];

    const { report, timings, episodePath } = await renderComposition(d, input({ composition: longComposition(), outDir, sourceChecksums: CHECKSUMS, finalSliceInputs: 2, decodeThreads: 8, onProgress: (pct) => seen.push(pct) }));

    expect(timings.final_slices).toBe(3);
    const slices = calls.filter(isSlice);
    expect(slices).toHaveLength(3);
    // two mezzanines a slice, each decoder held to 8 threads
    for (const s of slices) expect(s.filter((a, i) => a === "-threads" && s[i + 1] === "8" && s[i + 2] === "-i")).toHaveLength(2);
    expect(calls.filter(isSound)).toHaveLength(1);
    expect(maxRunning()).toBe(4);
    const join = calls.find((c) => c.includes("concat") && c.includes("-safe"))!;
    expect(join[join.length - 1]).toMatch(/full-episode.mp4$/);
    expect(join).toContain("sound.m4a");
    expect(calls.indexOf(join)).toBeGreaterThan(Math.max(...slices.map((s) => calls.indexOf(s))));
    expect(existsSync(episodePath)).toBe(true);
    expect(report.loudness).toEqual({ integrated_lufs: -14.03, true_peak_dbtp: -1.49, lra: 6.6 });
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("a slice failing on nvenc stops the others, and the whole final encode retries on cpu", async () => {
    let failed = false;
    const { spawn, calls, kills } = fakeSpawn((argv) => {
      if (!isSlice(argv) && !isSound(argv)) return {};
      if (!failed && argv.includes("h264_nvenc")) {
        failed = true;
        return { exit: 1, delayMs: 5 };
      }
      return { delayMs: 500 };
    });
    const { d, outDir } = fakeWorld({ spawn, nvenc: true });
    d.prober = lengthProber();

    const { report } = await renderComposition(d, input({ composition: longComposition(), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS, finalSliceInputs: 2 }));

    expect(report.warnings).toContain("nvenc_final_fallback");
    expect(report.encoder).toBe("cpu");
    // the two other nvenc slices and the first sound pass were killed, not left running
    expect(kills()).toBe(3);
    expect(calls.filter((c) => isSlice(c) && c.includes("libx264"))).toHaveLength(3);
    expect(calls.filter((c) => c.includes("concat") && c.includes("-safe"))).toHaveLength(1);
  });

  it("no more than finalConcurrency slices at once, taken in timeline order", async () => {
    const { spawn, calls, maxRunning } = fakeSpawn((argv) => (isSlice(argv) || isSound(argv) ? { delayMs: 15 } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    d.prober = lengthProber();

    const { timings } = await renderComposition(d, input({ composition: longComposition(), outDir, sourceChecksums: CHECKSUMS, finalSliceInputs: 1, finalConcurrency: 2 }));

    expect(timings.final_slices).toBe(6);
    // two slices and the sound pass, never more
    expect(maxRunning()).toBe(3);
    const slices = calls.filter(isSlice).map((c) => c[c.length - 1]!.split(/[\\/]/).pop());
    expect(slices).toEqual(["slice-0.mp4", "slice-1.mp4", "slice-2.mp4", "slice-3.mp4", "slice-4.mp4", "slice-5.mp4"]);
  });

  it("an episode too short to split stays one pass, whatever finalSliceInputs asks", async () => {
    const { spawn, calls } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { timings } = await renderComposition(d, input({ composition: fakeComposition(), outDir, sourceChecksums: CHECKSUMS, finalSliceInputs: 1 }));

    expect(timings.final_slices).toBe(1);
    expect(calls.filter(isSlice)).toHaveLength(0);
    expect(calls.filter((c) => c.includes("[vout]"))).toHaveLength(1);
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

  it("a peak over the linear budget: measured again through an alimiter, and the final pass limits the same way", async () => {
    // the canned block measures -23.47 LUFS / -4.61 dBTP: +9.5 dB of gain would put the peak at +4.9 dBTP
    const { spawn, calls, graphs } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));
    const graph = (argv: string[]) => graphs[calls.indexOf(argv)] ?? "";
    const measures = calls.filter((c) => c.includes("-vn"));
    expect(measures).toHaveLength(2);
    expect(graph(measures[0]!)).not.toContain("alimiter");
    // ceiling -23.47 + 13 - 1 = -11.47 dBFS
    expect(graph(measures[1]!)).toContain("alimiter=limit=0.267:attack=5:release=50:level=false[limited];[limited]loudnorm=I=-14:TP=-1:LRA=11:print_format=json");
    expect(graph(calls.find((c) => c.includes("[vout]"))!)).toContain("alimiter=limit=0.267:");
  });

  // 73 clips overran Windows' 32,767-character command line (`spawn ENAMETOOLONG`): every `-i <cache>/<64 hex>.mp4`
  // plus the whole filtergraph went on it.
  it("a 400-segment episode: the final passes' command lines stay under 8,000 characters", async () => {
    const { spawn, calls, options, graphs } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });
    const segments = Array.from({ length: 400 }, (_, k) => segment({ order: k, source_id: SRC_A, source_path: "/abs/a.mp4", in: 0, out: 2, start: 2 * k, end: 2 * k + 2, has_audio: true }));
    await renderComposition(d, input({ composition: composition({ total_seconds: 800, segments }), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));
    const passes = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.includes("-vn") || c.includes("[vout]"));
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const { c, i } of passes) {
      expect(c.join(" ").length).toBeLessThan(8000);
      expect(c).not.toContain("-filter_complex");
      expect(graphs[i]).toContain("concat=n=");
      // the mezzanines by short names, in the directory the pass runs in
      expect(c[c.indexOf("-i") + 1]).toBe("0.mp4");
      expect(existsSync(String(options[i]!.cwd))).toBe(false); // tmp/ is swept once the render is over
    }
  });

  it("the filtergraph file option follows the ffmpeg version", () => {
    expect(filterGraphFileOption("7.1.2-0+deb13u1")).toBe("-filter_complex_script");
    expect(filterGraphFileOption("n7.0.2")).toBe("-filter_complex_script");
    expect(filterGraphFileOption("8.1")).toBe("-/filter_complex");
    expect(filterGraphFileOption("9.0.1-essentials_build-www.gyan.dev")).toBe("-/filter_complex");
    expect(filterGraphFileOption("N-118912-g2c4f3e1d2b")).toBe("-/filter_complex");
    expect(filterGraphFileOption("unknown")).toBe("-/filter_complex");
  });

  it("does not warn loudnorm_not_linear when the final pass really normalized linearly", async () => {
    const { spawn } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).not.toContain("loudnorm_not_linear");
  });

  it("a preview tier lightens only the final encode: the mezzanines (and their cache) are those of a final render", async () => {
    const runOnce = async (tier?: "preview" | "final") => {
      const { spawn, calls } = fakeSpawn();
      const { d, outDir } = fakeWorld({ spawn, nvenc: true });
      await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "auto", sourceChecksums: CHECKSUMS, ...(tier ? { tier } : {}) }));
      const finals = calls.filter((c) => c.includes("[vout]"));
      expect(finals).toHaveLength(1);
      // drop the per-run temp paths: what is compared is how each pass encodes
      return { mezz: calls.filter((c) => !c.includes("[vout]") && c.includes("-c:v")).map((c) => c.slice(c.indexOf("-c:v"), -1)), final: finals[0]! };
    };
    const final = await runOnce();
    const preview = await runOnce("preview");
    expect(final.final.join(" ")).toContain("-preset p6 -tune hq -rc vbr -cq 19");
    expect(preview.final.join(" ")).toContain("-preset p4 -rc vbr -cq 25 -b:v 0 -maxrate 6M -bufsize 12M");
    expect(preview.final).not.toContain("p6");
    expect(preview.mezz).toHaveLength(2);
    expect(preview.mezz).toEqual(final.mezz);
  });

  it('encoderCfg "nvenc" on a machine without NVENC warns and never emits an nvenc argv', async () => {
    const { spawn, calls } = fakeSpawn();
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const { report } = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "nvenc", sourceChecksums: CHECKSUMS }));

    expect(report.warnings).toContain("nvenc_unavailable_cpu_fallback");
    expect(report.encoder).toBe("cpu");
    expect(calls.some((c) => c.some((a) => a.includes("nvenc")))).toBe(false);
  });

  // Review fix wave, I3: "child processes never receive HARNESS_SECRET_*" (AGENTS.md) had been enforced for
  // the media engine and the Playwright/agent children, but every ffmpeg this renderer spawned inherited the
  // worker's whole environment, secrets included.
  it("no ffmpeg child gets a HARNESS_SECRET_* variable, while an ordinary env still comes through", async () => {
    const previous = { upper: process.env.HARNESS_SECRET_X_Y, lower: process.env.harness_secret_a_b };
    process.env.HARNESS_SECRET_X_Y = "s3cret";
    process.env.harness_secret_a_b = "s3cret";
    try {
      const { spawn, options } = fakeSpawn();
      const { d, outDir } = fakeWorld({ spawn, nvenc: false });

      await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS }));

      expect(options.length, "no ffmpeg was spawned at all -- the assertions below would be vacuous").toBeGreaterThan(0);
      for (const opts of options) {
        const env = opts.env as Record<string, string> | undefined;
        expect(env, "spawn was called without an explicit env").toBeDefined();
        expect(Object.keys(env!).filter((k) => k.toLowerCase().startsWith("harness_secret_")), JSON.stringify(Object.keys(env!))).toEqual([]);
        expect(Object.values(env!)).not.toContain("s3cret");
        // ...and it is not passing on an empty env: ffmpeg still needs a normal user environment.
        expect(env!.PATH ?? env!.Path).toBe(process.env.PATH ?? process.env.Path);
      }
    } finally {
      if (previous.upper === undefined) delete process.env.HARNESS_SECRET_X_Y;
      else process.env.HARNESS_SECRET_X_Y = previous.upper;
      if (previous.lower === undefined) delete process.env.harness_secret_a_b;
      else process.env.harness_secret_a_b = previous.lower;
    }
  });

  it("a failing ffmpeg's cause reaches the error message; the full tail stays in the details", async () => {
    const { spawn } = fakeSpawn((_argv, i) => (i === 0 ? { exit: 234, stderr: XFADE_EINVAL_STDERR } : {}));
    const { d, outDir } = fakeWorld({ spawn, nvenc: false });

    const err = await renderComposition(d, input({ composition: fakeComposition(), outDir, encoderCfg: "cpu", sourceChecksums: CHECKSUMS })).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "IO_ERROR",
      message: "mezzanine 0: ffmpeg exited 234: [Parsed_xfade_15] The inputs needs to be a constant frame rate; current rate of 1/0 is invalid | [Parsed_xfade_15] Failed to configure output pad on Parsed_xfade_15",
      details: { exit_code: 234, stderr_tail: XFADE_EINVAL_STDERR },
    });
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

  it("a dissolve between two segments keeps the total duration and is counted as applied (both segments encoded at once)", async () => {
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
    const res = await renderComposition(d, input({ composition: comp, outDir: join(tempDir("render-out-x-"), "out"), sourceChecksums: checksums, mezzConcurrency: 2 }));

    expect(Math.abs(((await d.prober.probe(res.episodePath))?.duration_seconds ?? 0) - 4)).toBeLessThanOrEqual(0.1);
    expect(res.report.transitions.applied).toBe(1);
    expect(res.report.segments.total).toBe(2);
    // The clip_set keeps the BODY length (2s), not body+tail.
    expect(Math.abs(((await d.prober.probe(join(res.clipSetDir, "000.mp4")))?.duration_seconds ?? 0) - 2)).toBeLessThanOrEqual(0.05);
  }, 240_000);

  it("an episode in three slices (a dissolve inside one, a dip_black between two) keeps every frame, its length and its sound", async () => {
    const srcDir = tempDir("render-src-sl-");
    const files = [0, 1, 2, 3].map((k) => join(srcDir, `${k}.mp4`));
    for (const f of files) makeClip(f, 33, true);
    const ids = ["src_01JAAAAAAAAAAAAAAAAAAAAAAA", "src_01JBBBBBBBBBBBBBBBBBBBBBBB", "src_01JCCCCCCCCCCCCCCCCCCCCCCC", "src_01JDDDDDDDDDDDDDDDDDDDDDDD"];
    const kinds: Composition["segments"][number]["transition_out"][] = [
      { kind: "dissolve", seconds: 0.4, tail_available: true },
      { kind: "cut", seconds: 0.4, tail_available: false },
      { kind: "dip_black", seconds: 1, tail_available: false },
      { kind: "cut", seconds: 0.4, tail_available: false },
    ];
    const comp = composition({
      output: { width: 640, height: 360, fps: 25, codec: "h264" },
      total_seconds: 128,
      segments: files.map((f, k) => segment({ order: k, source_id: ids[k]!, source_path: f, in: 0, out: 32, start: k * 32, end: (k + 1) * 32, has_audio: true, transition_out: kinds[k]! })),
      transitions: { requested: 2, applied: 2, downgraded: [] },
    });
    const checksums = new Map(ids.map((id, k) => [id, "sha256:" + String(k).repeat(64)]));
    const d = deps(join(tempDir("render-cache-sl-"), "mezz"));
    const res = await renderComposition(d, input({ composition: comp, outDir: join(tempDir("render-out-sl-"), "out"), sourceChecksums: checksums, tier: "preview", mezzConcurrency: 4, finalSliceInputs: 1, decodeThreads: 4 }));

    expect(res.timings.final_slices).toBe(3);
    const probe = (entries: string, stream: string): string =>
      spawnSync(ffprobePath(), ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", res.episodePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
    // 4 x 32 s at 25 fps, the dissolve's tail overlapping its own length: 3200 frames, one every 40 ms, none twice
    const pts = probe("packet=pts_time", "v:0").trim().split(/\r?\n/).map(Number).sort((a, b) => a - b);
    expect(pts).toHaveLength(3200);
    const steps = pts.slice(1).map((t, i) => Math.round((t - pts[i]!) * 1000) / 1000);
    expect(Math.min(...steps)).toBe(0.04);
    expect(Math.max(...steps)).toBe(0.04);
    expect(Math.abs(Number(probe("stream=duration", "a:0").trim()) - 128)).toBeLessThanOrEqual(0.1);
    expect(res.report.loudness).not.toBeNull();
  }, 240_000);

  // The Kiyomizu preview (17:30) ended at 13:23, on its last dissolve: the render worker clamps `segment.out` to a
  // source file shorter than the timeline's asset but keeps `start`/`end`, so the body came out shorter than its
  // segment and the xfade offset (a sum of segment lengths) passed the end of the left stream.
  it("a body shorter than its segment (clamped out) still lands every stream on total_seconds across a dissolve", async () => {
    const srcDir = tempDir("render-src-c-");
    const a = join(srcDir, "a.mp4");
    const b = join(srcDir, "b.mp4");
    makeClip(a, 3, true);
    makeClip(b, 3, true);

    const comp = composition({
      output: { width: 640, height: 360, fps: 25, codec: "h264" },
      total_seconds: 4,
      segments: [
        // the segment is 2 s long, its body only 1.5 s
        segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 1.5, start: 0, end: 2, has_audio: true, transition_out: { kind: "dissolve", seconds: 0.4, tail_available: true } }),
        segment({ order: 1, source_id: SRC_B, source_path: b, in: 0, out: 2, start: 2, end: 4, has_audio: true }),
      ],
      transitions: { requested: 1, applied: 1, downgraded: [] },
    });
    const checksums = new Map([[SRC_A, "sha256:" + "e".repeat(64)], [SRC_B, "sha256:" + "f".repeat(64)]]);
    const d = deps(join(tempDir("render-cache-c-"), "mezz"));
    const res = await renderComposition(d, input({ composition: comp, outDir: join(tempDir("render-out-c-"), "out"), sourceChecksums: checksums }));

    const streams = spawnSync(ffprobePath(), ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", res.episodePath], { encoding: "utf8" });
    const parsed = JSON.parse(streams.stdout) as { streams: { codec_type: string; duration: string }[] };
    const seconds = (type: string) => Number(parsed.streams.find((s) => s.codec_type === type)?.duration);
    expect(Math.abs(seconds("video") - 4)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(seconds("audio") - 4)).toBeLessThanOrEqual(0.1);
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

  it("feedback-vps §4.3: even source sound brings a quiet clip up to a loud one, measured once and kept in the cache", async () => {
    const srcDir = tempDir("render-src-ev-");
    const loud = join(srcDir, "loud.mp4");
    const quiet = join(srcDir, "quiet.mp4");
    for (const [path, db] of [[loud, 0], [quiet, -20]] as const) {
      run(ffmpegPath(), ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2", "-af", `volume=${db}dB`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
    }
    const comp = (even: boolean, gain?: number) => composition({
      output: { width: 320, height: 180, fps: 25, codec: "h264" },
      total_seconds: 4,
      voice: "original",
      segments: [
        segment({ order: 0, source_id: SRC_A, source_path: loud, in: 0, out: 2, start: 0, end: 2, has_audio: true }),
        { ...segment({ order: 1, source_id: SRC_B, source_path: quiet, in: 0, out: 2, start: 2, end: 4, has_audio: true }), ...(gain !== undefined ? { gain_db: gain } : {}) },
      ],
      ...(even ? { source_even: true } : {}),
    });
    const checksums = new Map([[SRC_A, "sha256:" + "1".repeat(64)], [SRC_B, "sha256:" + "2".repeat(64)]]);
    const cacheDir = join(tempDir("render-cache-ev-"), "mezz");
    const gap = async (c: Composition) => {
      const res = await renderComposition(deps(cacheDir), input({ composition: c, outDir: join(tempDir("render-out-ev-"), "out"), sourceChecksums: checksums }));
      return maxVolumeDb(res.episodePath, 0.5, 1)! - maxVolumeDb(res.episodePath, 2.5, 1)!;
    };
    expect(await gap(comp(false))).toBeGreaterThan(15);
    expect(Math.abs(await gap(comp(true)))).toBeLessThan(2);
    // the clip's own gain on top of the even level
    expect(await gap(comp(true, -6))).toBeGreaterThan(4);
    const sidecars = readdirSync(cacheDir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(cacheDir, n), "utf8")) as { lufs?: number | null });
    expect(sidecars.filter((s) => typeof s.lufs === "number")).toHaveLength(2);
  }, 240_000);

  it("a video-only source marked has_audio renders once sourceFor says it has no audio, with even sound on", async () => {
    const srcDir = tempDir("render-src-mute-");
    const silent = join(srcDir, "silent.mp4");
    const sounding = join(srcDir, "sounding.mp4");
    makeClip(silent, 2, false);
    makeClip(sounding, 2, true);
    const comp = composition({
      output: { width: 320, height: 180, fps: 25, codec: "h264" }, total_seconds: 4, voice: "original", source_even: true,
      segments: [
        segment({ order: 0, source_id: SRC_A, source_path: silent, in: 0, out: 2, start: 0, end: 2, has_audio: true }),
        segment({ order: 1, source_id: SRC_B, source_path: sounding, in: 0, out: 2, start: 2, end: 4, has_audio: true }),
      ],
    });
    const sourceFor = async (seg: Composition["segments"][number]) =>
      ({ path: seg.source_path, checksum: "sha256:" + String(seg.order + 4).repeat(64), out: seg.out, has_audio: seg.source_path !== silent });
    const res = await renderComposition(deps(join(tempDir("render-cache-mute-"), "mezz")), input({ composition: comp, outDir: join(tempDir("render-out-mute-"), "out"), sourceChecksums: new Map(), sourceFor }));
    expect(maxVolumeDb(res.episodePath, 2.5, 1)!).toBeGreaterThan(-60);
  }, 240_000);

  it("feedback-vps §4.3: the music follows its volume line", async () => {
    const srcDir = tempDir("render-src-env-");
    const a = join(srcDir, "a.mp4");
    makeClip(a, 4, false);
    const music = join(srcDir, "music.wav");
    makeTone(music, 6, 220);
    const comp = composition({
      output: { width: 320, height: 180, fps: 25, codec: "h264" },
      total_seconds: 6,
      voice: "none",
      segments: [segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 4, start: 0, end: 4, has_audio: false }),
        segment({ order: 1, source_id: SRC_A, source_path: a, in: 0, out: 2, start: 4, end: 6, has_audio: false })],
      music: {
        track_id: "trk", path: music, loop: true, fade_in: 0.1, fade_out: 0.1,
        cues: [{ start: 0, end: 6, gain_db: -18 }],
        envelope: [{ at: 0, gain_db: -40 }, { at: 2.5, gain_db: -40 }, { at: 3, gain_db: -10 }],
        duck: { enabled: false, windows: [], gain_db: -12, attack_ms: 150, release_ms: 600 },
      },
    });
    const res = await renderComposition(deps(join(tempDir("render-cache-env-"), "mezz")), input({ composition: comp, outDir: join(tempDir("render-out-env-"), "out"), sourceChecksums: new Map([[SRC_A, "sha256:" + "3".repeat(64)]]) }));
    expect(maxVolumeDb(res.episodePath, 4, 1)! - maxVolumeDb(res.episodePath, 1, 1)!).toBeGreaterThan(25);
  }, 240_000);

  it("feedback-vps §4.6: every look renders with this ffmpeg and changes the picture", async () => {
    const srcDir = tempDir("render-src-look-");
    const a = join(srcDir, "a.mp4");
    makeClip(a, 4, true);
    const frameMean = (file: string) => {
      const r = spawnSync(ffmpegPath(), ["-v", "error", "-ss", "1.5", "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      expect(r.stdout).toHaveLength(3);
      return [...r.stdout].join(",");
    };
    const cacheDir = join(tempDir("render-cache-look-"), "mezz");
    const colours = new Set<string>();
    for (const look of [undefined, "natural", "vivid", "warm", "cinematic"] as const) {
      const comp = composition({
        output: { width: 320, height: 180, fps: 25, codec: "h264" }, total_seconds: 3,
        segments: [segment({ order: 0, source_id: SRC_A, source_path: a, in: 0, out: 3, start: 0, end: 3, has_audio: true })],
        ...(look ? { look } : {}),
      });
      const res = await renderComposition(deps(cacheDir), input({ composition: comp, outDir: join(tempDir("render-out-look-"), "out"), sourceChecksums: new Map([[SRC_A, "sha256:" + "4".repeat(64)]]) }));
      colours.add(frameMean(res.episodePath));
    }
    expect(colours.size).toBe(5);
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
