import { spawnSync } from "node:child_process";

/** Shared by the ffprobe adapter test and any future media-adapter test: generate small real media files with ffmpeg. */

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

export function hasFfmpeg(): boolean {
  const ffmpeg = spawnSync(ffmpegPath(), ["-version"]);
  const ffprobe = spawnSync(ffprobePath(), ["-version"]);
  return ffmpeg.status === 0 && ffprobe.status === 0;
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args);
  if (r.status !== 0) {
    const stderr = r.stderr ? r.stderr.toString("utf8") : "";
    throw new Error(`${bin} ${args.join(" ")} failed (status ${String(r.status)}): ${stderr || r.error?.message || "unknown error"}`);
  }
}

/** ffmpeg -y -f lavfi -i testsrc=... [-f lavfi -i sine=...] -c:v libx264 -preset ultrafast -pix_fmt yuv420p [-c:a aac -shortest] <path> */
export function makeVideo(path: string, o: { seconds: number; audio?: boolean; size?: string }): void {
  const { seconds, audio = true, size = "320x180" } = o;
  const args = ["-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=25`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  run(ffmpegPath(), args);
}

/** ffmpeg -y -f lavfi -i anullsrc=... | sine=... -t <seconds> -c:a pcm_s16le <path> */
export function makeWav(path: string, seconds: number, o?: { silent?: boolean }): void {
  const silent = o?.silent ?? false;
  const source = silent ? "anullsrc=r=44100:cl=mono" : "sine=frequency=440:sample_rate=44100";
  run(ffmpegPath(), ["-y", "-f", "lavfi", "-i", source, "-t", String(seconds), "-c:a", "pcm_s16le", path]);
}
