import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { MediaProbe, MediaProber } from "@harness/contracts";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
}
interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * spawnSync wrapper with a hard wall-clock timeout so a hung/slow decode can never block the process
 * indefinitely (unlike ScriptExecutor's deadline handling, plain spawnSync has no timeout by default).
 * Exported (not re-exported from index.ts) so tests can exercise the timeout/kill behavior directly
 * without needing real ffmpeg/ffprobe binaries.
 */
export function run(bin: string, args: string[], timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER_BYTES });
}

/** ffprobe reports format_name as a comma-joined alias list (e.g. "mov,mp4,m4a,3gp,3g2,mj2"); only the first token is meaningful for mime mapping. */
const MIME_BY_FIRST_TOKEN: Record<string, string> = {
  mov: "video/mp4",
  matroska: "video/x-matroska",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  png_pipe: "image/png",
  image2: "image/jpeg",
  jpeg_pipe: "image/jpeg",
  mjpeg: "image/jpeg",
};

function mimeFromFormatName(formatName: string): string | null {
  const first = formatName.split(",")[0] ?? formatName;
  return MIME_BY_FIRST_TOKEN[first] ?? null;
}

function parseFps(rFrameRate: string | undefined): number | null {
  if (!rFrameRate) return null;
  const [aStr, bStr] = rFrameRate.split("/");
  const a = Number(aStr);
  const b = Number(bStr);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function parseDuration(duration: string | undefined): number | null {
  if (duration === undefined) return null;
  const n = Number(duration);
  return Number.isFinite(n) ? n : null;
}

/** A killed-by-timeout or otherwise-unspawnable child; both cases should be treated as a probe/measure failure, same as any other. */
function timedOutOrFailed(r: SpawnSyncReturns<string>): boolean {
  return Boolean(r.error) || r.signal !== null;
}

/**
 * Synchronous duration-only probe (spec 3B Task 6): `collectStats`'s `durationOf(pkg)` needs a video's
 * duration to compute `avg_view_pct`, but `CollectDeps.durationOf` is a plain synchronous function -- there is
 * no `await` point between `collectStats` and the channel-package row it is given. `FfprobeMediaProber.probe`
 * is `async` only for interface compliance; the ffprobe call itself already runs through `spawnSync` (see
 * `run` above), so this reuses that same call directly instead of wrapping it in a promise no caller here can
 * await. A missing file, missing ffprobe binary, non-zero exit, timeout, or unparsable JSON all return `null`
 * rather than throwing -- exactly `MediaProber.probe`'s own "unknown" outcome, just duration-only and sync. */
export function probeDurationSync(path: string, opts?: { ffprobe?: string; timeoutMs?: number }): number | null {
  const ffprobe = opts?.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", path], timeoutMs);
  if (timedOutOrFailed(r) || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as FfprobeOutput;
    return parseDuration(parsed.format?.duration);
  } catch {
    return null;
  }
}

export class FfprobeMediaProber implements MediaProber {
  private readonly ffprobeBin: string;
  private readonly ffmpegBin: string;
  private readonly timeoutMs: number;

  constructor(opts?: { ffprobe?: string; ffmpeg?: string; timeoutMs?: number }) {
    this.ffprobeBin = opts?.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe";
    this.ffmpegBin = opts?.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static isAvailable(opts?: { ffprobe?: string }): boolean {
    const ffprobe = opts?.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe";
    const r = run(ffprobe, ["-version"], AVAILABILITY_TIMEOUT_MS);
    return !timedOutOrFailed(r) && r.status === 0;
  }

  async probe(path: string): Promise<MediaProbe | null> {
    const r = run(this.ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], this.timeoutMs);
    if (timedOutOrFailed(r) || r.status !== 0) return null;
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(r.stdout) as FfprobeOutput;
    } catch {
      return null;
    }
    const formatName = parsed.format?.format_name ?? null;
    const mime_type = formatName ? mimeFromFormatName(formatName) : null;
    const duration_seconds = parseDuration(parsed.format?.duration);
    const streams = parsed.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");
    const video = videoStream
      ? { codec: videoStream.codec_name ?? "", width: videoStream.width ?? 0, height: videoStream.height ?? 0, fps: parseFps(videoStream.r_frame_rate) }
      : null;
    const audio = audioStream
      ? { codec: audioStream.codec_name ?? "", channels: audioStream.channels ?? 0, sample_rate: audioStream.sample_rate ? Number(audioStream.sample_rate) : 0 }
      : null;
    const media = video ? { width: video.width, height: video.height, fps: video.fps, has_audio: audio !== null } : null;
    return { media, duration_seconds, mime_type, container: formatName, video, audio };
  }

  async silenceRatio(path: string): Promise<number | null> {
    const probed = await this.probe(path);
    if (!probed || !probed.audio || !probed.duration_seconds) return null;
    const r = run(this.ffmpegBin, ["-nostats", "-hide_banner", "-i", path, "-af", "silencedetect=noise=-50dB:d=0.3", "-f", "null", "-"], this.timeoutMs);
    if (timedOutOrFailed(r)) return null;
    const stderr = r.stderr ?? "";
    let total = 0;
    for (const m of stderr.matchAll(/silence_duration:\s*([\d.]+)/g)) {
      total += Number(m[1]);
    }
    const ratio = total / probed.duration_seconds;
    return Math.min(1, Math.max(0, ratio));
  }
}
