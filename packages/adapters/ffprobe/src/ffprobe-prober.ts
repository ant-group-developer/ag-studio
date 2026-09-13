import { spawnSync } from "node:child_process";
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

export class FfprobeMediaProber implements MediaProber {
  private readonly ffprobeBin: string;
  private readonly ffmpegBin: string;

  constructor(opts?: { ffprobe?: string; ffmpeg?: string }) {
    this.ffprobeBin = opts?.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe";
    this.ffmpegBin = opts?.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  }

  static isAvailable(opts?: { ffprobe?: string }): boolean {
    const ffprobe = opts?.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe";
    const r = spawnSync(ffprobe, ["-version"]);
    return r.status === 0;
  }

  async probe(path: string): Promise<MediaProbe | null> {
    const r = spawnSync(this.ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
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
    const r = spawnSync(this.ffmpegBin, ["-nostats", "-hide_banner", "-i", path, "-af", "silencedetect=noise=-50dB:d=0.3", "-f", "null", "-"], { encoding: "utf8" });
    const stderr = r.stderr ?? "";
    let total = 0;
    for (const m of stderr.matchAll(/silence_duration:\s*([\d.]+)/g)) {
      total += Number(m[1]);
    }
    const ratio = total / probed.duration_seconds;
    return Math.min(1, Math.max(0, ratio));
  }
}
