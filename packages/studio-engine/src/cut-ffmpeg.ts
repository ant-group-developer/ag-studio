/**
 * ffmpeg / ffprobe for the shot-cut stages, run ASYNCHRONOUSLY: the Studio worker runs many loops (Claude, farm, chat)
 * in one process, so a `spawnSync` scene detection over a five-minute video would freeze every one of them and their
 * lease heartbeats. The harness media functions that spawn (`indexSources`, `watchVideos`, `transcribeSources`) are
 * synchronous by design — each harness stage was its own process — so Studio calls only their pure parts
 * (`buildShots`, `shotId`, `fitEdl`, …) and does the I/O here (ADR-0001 item 153).
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { childEnvWithoutSecrets } from "@harness/core";

export interface ToolResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Runs `bin args` without blocking; throws only when the program cannot be started. Output is kept whole. */
export function runTool(bin: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal }): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnvWithoutSecrets(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`cannot run ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const PROBE_TIMEOUT_MS = 60_000;
/** A full decode of a long 720p proxy (scene detection) or the audio track. */
const DECODE_TIMEOUT_MS = 30 * 60_000;
const FRAME_TIMEOUT_MS = 60_000;

function check(r: ToolResult, what: string): void {
  if (r.timedOut) throw new Error(`${what}: timed out`);
  if (r.code !== 0) throw new Error(`${what}: exit ${String(r.code)}: ${r.stderr.slice(-300)}`);
}

export interface MediaFacts { duration_s: number | null; width: number | null; height: number | null; fps: number | null; has_audio: boolean }

function rate(v: string | undefined): number | null {
  if (!v) return null;
  const [n, d] = v.split("/").map(Number);
  const r = d ? n! / d : n!;
  return Number.isFinite(r) && r > 0 ? Math.round(r * 1000) / 1000 : null;
}

/** ffprobe of one file; `null` when it cannot be read. */
export async function probeMedia(ffprobe: string, path: string): Promise<MediaFacts | null> {
  const r = await runTool(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.timedOut || r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const duration = Number(j.format?.duration);
    return {
      duration_s: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
      has_audio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

/** Scene-change times (seconds, ascending, 0.1 s grid) — the same filter and parse as harness `detectSceneChanges`. */
export async function detectCuts(ffmpeg: string, path: string, threshold: number, signal?: AbortSignal): Promise<number[]> {
  const vf = `select='gt(scene\\,${threshold})',showinfo`;
  const r = await runTool(ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-vf", vf, "-an", "-f", "null", "-"], { timeoutMs: DECODE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  check(r, `scene detection of ${path}`);
  const times = new Set<number>();
  for (const m of r.stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.add(Math.round(t * 10) / 10);
  }
  return [...times].sort((a, b) => a - b);
}

/** The sound of `src` as 16 kHz mono PCM WAV (what WhisperX reads); `false` when the file has no sound. */
export async function extractAudio16k(ffmpeg: string, src: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await runTool(ffmpeg, ["-y", "-hide_banner", "-nostats", "-i", src, "-vn", "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest],
    { timeoutMs: DECODE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (r.code !== 0 && /does not contain any stream|Output file .* does not contain|matches no streams/i.test(r.stderr)) return false;
  check(r, `audio of ${src}`);
  return true;
}

/** One frame at `t` seconds, `width` pixels wide (height kept in proportion, even), PNG or JPEG by extension. */
export async function grabFrame(ffmpeg: string, src: string, t: number, dest: string, width: number): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const r = await runTool(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, dest],
    { timeoutMs: FRAME_TIMEOUT_MS });
  check(r, `frame at ${t}s of ${src}`);
}

/**
 * Frames (same size) tiled left to right, top to bottom, `cols` across, into one image: the frames are copied as a
 * numbered sequence and fed to the `tile` filter (as harness `watchVideos` does), the last row padded with black.
 */
export async function tileSheet(ffmpeg: string, frames: string[], cols: number, dest: string): Promise<void> {
  if (frames.length === 0) throw new Error("tileSheet: no frames");
  mkdirSync(dirname(dest), { recursive: true });
  const seq = mkdtempSync(join(tmpdir(), "studio-sheet-"));
  try {
    frames.forEach((f, i) => copyFileSync(f, join(seq, `${String(i + 1).padStart(3, "0")}${extname(f)}`)));
    const rows = Math.ceil(frames.length / cols);
    const pattern = join(seq, `%03d${extname(frames[0]!)}`);
    const r = await runTool(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "1", "-i", pattern, "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", dest],
      { timeoutMs: FRAME_TIMEOUT_MS });
    check(r, `contact sheet ${dest}`);
  } finally {
    rmSync(seq, { recursive: true, force: true });
  }
}
