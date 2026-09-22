import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

/** The harness ships no font (sub-project 5B, binding constraint), so any test that needs a real `.ttf` --
 * a brand profile, burned-in text -- borrows one from the operating system and SKIPS when there is none.
 * `undefined` is the signal to skip, never a reason to fail. */
export function systemFontPath(): string | undefined {
  const candidates = [
    "C:\\Windows\\Fonts\\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
  ];
  return candidates.find((p) => existsSync(p));
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args);
  if (r.status !== 0) {
    const stderr = r.stderr ? r.stderr.toString("utf8") : "";
    throw new Error(`${bin} ${args.join(" ")} failed (status ${String(r.status)}): ${stderr || r.error?.message || "unknown error"}`);
  }
}

/**
 * ffmpeg -y -f lavfi -i testsrc=... [-f lavfi -i sine=...] -c:v libx264 -preset ultrafast -pix_fmt yuv420p [-c:a aac -shortest] <path>
 * With `scene_cut_at` set, produces two solid-color segments (red then blue) concatenated at that second
 * instead of the usual testsrc pattern, so a scene-change detector has an unambiguous cut to find.
 */
export function makeVideo(path: string, o: { seconds: number; audio?: boolean; size?: string; scene_cut_at?: number }): void {
  const { seconds, audio = true, size = "320x180", scene_cut_at } = o;
  if (scene_cut_at !== undefined && scene_cut_at > 0 && scene_cut_at < seconds) {
    const rest = seconds - scene_cut_at;
    const args = [
      "-y",
      "-f", "lavfi", "-i", `color=c=red:s=${size}:d=${scene_cut_at}:r=25`,
      "-f", "lavfi", "-i", `color=c=blue:s=${size}:d=${rest}:r=25`,
    ];
    if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
    args.push("-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]");
    if (audio) args.push("-map", "2:a");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
    if (audio) args.push("-c:a", "aac", "-shortest");
    args.push(path);
    run(ffmpegPath(), args);
    return;
  }
  const args = ["-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=25`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  run(ffmpegPath(), args);
}

/**
 * A multi-scene clip: `colors.length` solid-colour segments concatenated into one `seconds`-long video, so a
 * scene-change detector (`media-index`, sub-project 5A) finds a cut at every boundary. `cuts` places those
 * boundaries explicitly (seconds from the start, ascending, inside `(0, seconds)`); omitted, the colours
 * split the clip evenly.
 *
 * `audio` is a sine tone, `null` for a video-only clip. Its `seconds` may be SHORTER than the video (there is
 * deliberately no `-shortest` here): the tail then carries no audio at all, which is what gives
 * `FakeMediaEngine`'s transcript a real silence for `voice: original` cut-snapping to aim at. It must never
 * be longer, or the muxed file outlasts the picture.
 */
export function makeSceneClip(path: string, o: {
  seconds: number;
  colors: string[];
  cuts?: number[];
  audio?: { seconds?: number; frequency?: number } | null;
  size?: string;
}): void {
  const size = o.size ?? "320x180";
  if (o.colors.length === 0) throw new Error("makeSceneClip: colors must not be empty");
  const cuts = o.cuts ?? o.colors.slice(1).map((_, i) => ((i + 1) * o.seconds) / o.colors.length);
  if (cuts.length !== o.colors.length - 1) throw new Error(`makeSceneClip: ${o.colors.length} colors need ${o.colors.length - 1} cuts, got ${cuts.length}`);
  const bounds = [0, ...cuts, o.seconds];

  const args = ["-y"];
  for (const [i, color] of o.colors.entries()) {
    const d = bounds[i + 1]! - bounds[i]!;
    if (d <= 0) throw new Error(`makeSceneClip: segment ${i} of ${path} has non-positive length ${d}`);
    args.push("-f", "lavfi", "-i", `color=c=${color}:s=${size}:d=${d.toFixed(3)}:r=25`);
  }
  const audio = o.audio === null ? null : { seconds: o.audio?.seconds ?? o.seconds, frequency: o.audio?.frequency ?? 440 };
  if (audio) {
    if (audio.seconds > o.seconds) throw new Error(`makeSceneClip: audio (${audio.seconds}s) outlasts the video (${o.seconds}s)`);
    args.push("-f", "lavfi", "-i", `sine=frequency=${audio.frequency}:duration=${audio.seconds}`);
  }
  args.push("-filter_complex", `${o.colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${o.colors.length}:v=1:a=0[v]`, "-map", "[v]");
  if (audio) args.push("-map", `${o.colors.length}:a`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac");
  args.push(path);
  run(ffmpegPath(), args);
}

/** ffmpeg -y -f lavfi -i anullsrc=... | sine=... -t <seconds> -c:a pcm_s16le <path>. `frequency` (default
 * 440 Hz, so every existing caller is unchanged) picks the tone -- a music track and a voice reference clip
 * generated for the same test should not be the same sine wave. */
export function makeWav(path: string, seconds: number, o?: { silent?: boolean; frequency?: number }): void {
  const silent = o?.silent ?? false;
  const source = silent ? "anullsrc=r=44100:cl=mono" : `sine=frequency=${o?.frequency ?? 440}:sample_rate=44100`;
  run(ffmpegPath(), ["-y", "-f", "lavfi", "-i", source, "-t", String(seconds), "-c:a", "pcm_s16le", path]);
}

/** `format=duration` in seconds, or `null` when ffprobe cannot read the file. */
export function ffprobeDuration(path: string): number | null {
  const r = spawnSync(ffprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Standard deviation of one gray frame's luma, sampled at `t` seconds inside `crop` -- the same measurement
 * `render-valid` makes (`packages/core/src/verification/composition-checkers.ts`), reimplemented here (five
 * lines of arithmetic over one raw frame) so an acceptance test can assert on the pixels itself rather than
 * on the checker's verdict about them. `null` when ffmpeg produced no frame at all.
 */
export function frameStdDev(file: string, t: number, crop: { w: number; h: number; x: number; y: number }): number | null {
  const r = spawnSync(
    ffmpegPath(),
    ["-hide_banner", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  const buf = r.stdout;
  let sum = 0;
  for (const byte of buf) sum += byte;
  const mean = sum / buf.length;
  let variance = 0;
  for (const byte of buf) variance += (byte - mean) ** 2;
  return Math.sqrt(variance / buf.length);
}
