/** Per-segment mezzanine ffmpeg argv and cache key -- sub-project 5B Task 6, spec §5.1. Pure: no I/O, no
 * clock, no randomness. Task 7 owns the cache directory, sidecar JSON, LRU sweep and the actual ffmpeg spawn;
 * this module only decides the argv and the key that names the cache entry. */
import { createHash } from "node:crypto";
import { canonicalJson } from "../../artifacts/checksum.js";
import { videoEncoderArgs, type EncoderChoice } from "./encoder.js";

/** Bumped whenever the mezzanine filter chain changes, so old cache entries stop being hits without a
 * filesystem sweep -- folded into `mezzCacheKey` alongside the render parameters themselves. */
export const MEZZ_VERSION = 1;

/**
 * `sha256` hex of the canonicalized (key-sorted) render parameters plus `MEZZ_VERSION` -- stable across
 * property insertion order, changes whenever any parameter (including the version) changes. Callers append
 * `-tail` to this key for the dissolve-tail cache entry, keyed by its own `tail_seconds`.
 */
export function mezzCacheKey(p: {
  source_checksum: string;
  in: number;
  out: number;
  fit: "scale_pad" | "scale_crop";
  w: number;
  h: number;
  fps: number;
  has_audio: boolean;
  encoder: EncoderChoice;
  codec: "h264" | "hevc";
  tail_seconds?: number;
}): string {
  return createHash("sha256").update(canonicalJson({ ...p, mezz_version: MEZZ_VERSION })).digest("hex");
}

/** `scale`+`pad`/`crop` filter (lanczos) to bring a source up to the fixed output frame -- spec §5.1.
 * `scale_pad` letterboxes to preserve the whole frame; `scale_crop` fills the frame and crops the overflow.
 * Both end with `setsar=1`: an anamorphic source (non-1:1 SAR) would otherwise carry its original SAR through
 * `scale`, and a mezzanine with SAR != 1:1 makes the final render's `concat`/`xfade` abort with "parameters
 * do not match" against every other (SAR 1:1) mezzanine (fix round 1, Critical 1). */
export function scaleFilter(fit: "scale_pad" | "scale_crop", w: number, h: number): string {
  if (fit === "scale_pad") {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`;
}

/**
 * ffmpeg argv for one mezzanine render (a segment body or its dissolve tail -- the caller picks `in`/`out`
 * for either). Trims with `-ss`/`-to` before `-i` (input seeking); a source with no audio track gets a
 * silent `anullsrc` second input instead, trimmed to the same duration, so every mezzanine has audio
 * (PCM `pcm_s16le`, 48 kHz stereo). The trailing `-t` re-clamps duration in case `-ss`/`-to` input-seek lands
 * a frame off from the requested `out - in`.
 */
export function mezzArgs(p: {
  ffmpeg: string;
  source: string;
  in: number;
  out: number;
  fit: "scale_pad" | "scale_crop";
  w: number;
  h: number;
  fps: number;
  has_audio: boolean;
  encoder: EncoderChoice;
  codec: "h264" | "hevc";
  out_path: string;
}): string[] {
  const { ffmpeg, source, in: inSec, out, fit, w, h, fps, has_audio, encoder, codec, out_path } = p;
  const duration = out - inSec;

  const args: string[] = [ffmpeg, "-hide_banner", "-y", "-ss", String(inSec), "-to", String(out), "-i", source];
  if (!has_audio) args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=48000:cl=stereo");

  const videoChain = `[0:v]${scaleFilter(fit, w, h)},fps=${fps},format=yuv420p[v]`;
  const audioChain = has_audio ? "[0:a]aresample=48000,aformat=channel_layouts=stereo[a]" : "[1:a]anull[a]";
  args.push("-filter_complex", `${videoChain};${audioChain}`, "-map", "[v]", "-map", "[a]");
  args.push(...videoEncoderArgs({ choice: encoder, codec, tier: "mezz", fps }));
  args.push("-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-t", String(duration), "-movflags", "+faststart", out_path);
  return args;
}
