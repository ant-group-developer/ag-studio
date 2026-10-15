#!/usr/bin/env node
/**
 * Renders a Studio video's timeline from a workspace export against fake sources, to check that the rendered
 * file is as long as the timeline says (plan 2026-10-15 feedback-vps, task 1.1).
 *
 *   node scripts/repro-render.mjs <video dir> [--out <dir>] [--src-fps <rate>] [--shorten <s>] [--clamp] [--keep]
 *
 * `<video dir>` holds `timeline.json` (a saved revision `{revision, timeline}` or a bare timeline) and
 * `sources/index.json`. Every asset becomes a `testsrc2` + `sine` file at `--src-fps` (default 30; cameras often
 * record 30000/1001) exactly `duration_s` long (minus
 * `--shorten` seconds, to play a source file shorter than ag-go said); `--clamp` then applies the render worker's
 * clamp of `segment.out` to the probed file length before rendering. The composition comes from
 * `timelineToComposition` and is rendered by `renderComposition` at 640x360 (preview tier, cpu), text off.
 * Prints the length of the video and audio streams (and how far the mezzanines' own video streams fall short of
 * their segments) and exits 1 when either stream is more than 0.1 s off `total_seconds`. Windows: keep `--out`
 * short (`E:\rr\x`) while ffmpeg's argv still carries every path.
 *
 * Needs ffmpeg/ffprobe (`FFMPEG_PATH`/`FFPROBE_PATH` or on PATH) and built packages (`pnpm build`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { renderComposition, timelineToComposition } from "@harness/core";

const TOLERANCE_S = 0.1;
const W = 640;
const H = 360;

function parseArgs(argv) {
  const opts = { dir: null, out: null, srcFps: "30", shorten: 0, clamp: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--src-fps") opts.srcFps = argv[++i];
    else if (a === "--shorten") opts.shorten = Number(argv[++i]);
    else if (a === "--clamp") opts.clamp = true;
    else if (a === "--keep") opts.keep = true;
    else if (!a.startsWith("--") && opts.dir === null) opts.dir = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.dir === null) throw new Error("usage: node scripts/repro-render.mjs <video dir> [--out <dir>] [--src-fps <rate>] [--shorten <s>] [--clamp] [--keep]");
  return opts;
}

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`${bin} ${args.slice(0, 6).join(" ")} … exited ${r.status}: ${(r.stderr ?? "").slice(-800)}`);
  return r.stdout;
}

/** A fake source: moving test pattern plus a tone, `seconds` long, small and fast to encode. */
function fakeSource(path, seconds, fps) {
  if (existsSync(path)) return;
  const d = seconds.toFixed(3);
  run(ffmpeg, [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=320x180:r=${fps}:d=${d}`,
    "-f", "lavfi", "-i", `sine=f=440:sample_rate=48000:d=${d}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-bf", "2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest", path,
  ]);
}

function fakeAudio(path, seconds, freq) {
  if (existsSync(path)) return;
  run(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", `sine=f=${freq}:sample_rate=48000:d=${seconds.toFixed(3)}`, "-ac", "2", path]);
}

/** Per-stream lengths of a media file, in seconds (`null` when the stream is missing). */
function streamSeconds(path) {
  const out = JSON.parse(run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]));
  const pick = (type) => {
    const s = (out.streams ?? []).find((x) => x.codec_type === type);
    return s?.duration !== undefined ? Number(s.duration) : null;
  };
  return { format: Number(out.format?.duration ?? NaN), video: pick("video"), audio: pick("audio") };
}

/** The last moment the picture still changes (freezedetect over the last 60 s), or `null` when it never froze. */
function freezeStart(path, total) {
  const from = Math.max(0, total - 60);
  const r = spawnSync(ffmpeg, ["-hide_banner", "-ss", String(from), "-i", path, "-vf", "freezedetect=n=0.001:d=2", "-an", "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
  const starts = [...(r.stderr ?? "").matchAll(/freeze_start: ([\d.]+)/g)].map((m) => from + Number(m[1]));
  return starts.length > 0 ? starts[starts.length - 1] : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = resolve(opts.dir);
  const saved = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
  const timeline = saved.timeline ?? saved;
  const index = JSON.parse(readFileSync(join(dir, "sources", "index.json"), "utf8"));
  const durations = new Map(index.sources.map((s) => [s.asset_id, s.duration_s]));

  const out = resolve(opts.out ?? join(tmpdir(), "ag-repro-render", timeline.episode_id ?? "video"));
  const srcDir = join(out, "sources");
  mkdirSync(srcDir, { recursive: true });

  const composition = timelineToComposition(timeline);
  composition.output = { ...composition.output, width: W, height: H };

  // ---- fake inputs ----
  const local = new Map();
  for (const seg of composition.segments) {
    const assetId = seg.source_path.replace(/^asset:/, "");
    if (local.has(seg.source_path)) continue;
    const full = durations.get(assetId);
    if (full === undefined) throw new Error(`asset ${assetId} is not in sources/index.json`);
    const seconds = Math.max(0.5, full - opts.shorten);
    const path = join(srcDir, `${assetId}-${seconds.toFixed(3)}-${opts.srcFps.replace(/\W/g, "_")}.mp4`);
    fakeSource(path, seconds, opts.srcFps);
    local.set(seg.source_path, path);
  }
  const prober = {
    async probe(path) {
      try {
        const s = streamSeconds(path);
        return { media: null, mime_type: null, container: null, duration_seconds: s.format, video: null, audio: null };
      } catch {
        return null;
      }
    },
  };

  const clamped = [];
  for (const seg of composition.segments) {
    const path = local.get(seg.source_path);
    if (opts.clamp) {
      // ag-render-worker render-handler.ts: `seg.out` is clamped to the probed file, `start`/`end` are not.
      const probed = (await prober.probe(path))?.duration_seconds ?? null;
      if (probed !== null && seg.out > probed) {
        clamped.push({ order: seg.order, out: seg.out, probed });
        seg.out = Math.max(seg.in, probed);
      }
    }
    seg.source_path = path;
  }
  for (const n of composition.narration) {
    const path = join(srcDir, `voice-${n.line_id}.wav`);
    fakeAudio(path, Math.max(0.1, n.end - n.start), 660);
    n.wav = path;
  }
  if (composition.music !== null) {
    const path = join(srcDir, "music.wav");
    fakeAudio(path, 180, 220);
    composition.music.path = path;
  }

  const sourceChecksums = new Map(composition.segments.map((s) => [s.source_id, `fake:${basename(s.source_path)}`]));
  const renderDir = join(out, "render");
  rmSync(renderDir, { recursive: true, force: true });
  let lastStage = "";
  const t0 = Date.now();
  const { report, episodePath } = await renderComposition(
    {
      ffmpeg,
      prober,
      cache: { dir: join(out, "mezz-cache"), maxBytes: 20 * 1024 ** 3 },
      nvencAvailable: async () => false,
      clock: { now: () => new Date().toISOString() },
      log: (line) => console.error(`  · ${line}`),
    },
    {
      composition,
      assPath: null,
      fontsDir: null,
      outDir: renderDir,
      encoderCfg: "cpu",
      tier: "preview",
      timeoutSeconds: 3 * 3600,
      sourceChecksums,
      onProgress: (_p, stage) => {
        if (stage !== lastStage) console.error(`  ${stage}…`);
        lastStage = stage;
      },
    },
  );

  // each body's own video stream against its segment: the final graph places every xfade by segment lengths
  let mezzShort = 0;
  for (const seg of composition.segments) {
    const body = join(renderDir, "cuts", `${String(seg.order).padStart(3, "0")}.mp4`);
    if (!existsSync(body)) continue;
    const v = streamSeconds(body).video;
    if (v !== null) mezzShort += seg.end - seg.start - v;
  }
  const expected = composition.total_seconds;
  const got = streamSeconds(episodePath);
  const freeze = got.video !== null ? freezeStart(episodePath, got.video) : null;
  const dissolves = composition.segments.filter((s) => s.transition_out.kind === "dissolve" && s.transition_out.tail_available).length;
  const result = {
    video: timeline.episode_id,
    segments: composition.segments.length,
    dissolves,
    voice: composition.voice,
    music: composition.music !== null,
    src_fps: opts.srcFps,
    clamped: clamped.length,
    mezz_video_short_s: Math.round(mezzShort * 1000) / 1000,
    total_seconds: expected,
    format_seconds: got.format,
    video_seconds: got.video,
    audio_seconds: got.audio,
    freeze_from: freeze,
    warnings: report.warnings,
    render_seconds: Math.round((Date.now() - t0) / 1000),
    file: episodePath,
  };
  writeFileSync(join(out, "result.json"), JSON.stringify({ ...result, clamped_segments: clamped }, null, 2));
  console.log(JSON.stringify(result, null, 2));

  const off = (v) => v === null || Math.abs(v - expected) > TOLERANCE_S;
  if (!opts.keep) rmSync(join(out, "mezz-cache"), { recursive: true, force: true });
  if (off(got.video) || off(got.audio)) {
    console.error(`MISMATCH: video ${got.video} s, audio ${got.audio} s, timeline ${expected} s`);
    process.exit(1);
  }
  console.error(`OK: both streams within ${TOLERANCE_S} s of ${expected} s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(2);
});
