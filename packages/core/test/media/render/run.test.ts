import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositionSchema, newId, type Composition, type MediaProbe, type MediaProber } from "@harness/contracts";
import { probeNvenc, renderComposition, type RenderDeps, type RenderInput } from "../../../src/media/render/run.js";
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

describe("probeNvenc", () => {
  it("answers false (never throws) for a binary that cannot run at all", async () => {
    await expect(probeNvenc(join(tempDir("no-ffmpeg-"), "definitely-not-ffmpeg"))).resolves.toBe(false);
  });
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

    // Second run, same cache, fresh output dir: no mezzanine is re-encoded.
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
