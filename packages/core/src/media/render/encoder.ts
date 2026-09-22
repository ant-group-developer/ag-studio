/** Video encoder argv, NVENC-vs-CPU resolution -- sub-project 5B Task 6, spec §5.4. Pure: no I/O, no clock,
 * no randomness. `resolveEncoder` only decides between the two `EncoderChoice`s from an already-measured
 * `nvencAvailable` flag; the probe itself (`NVENC_PROBE_ARGS`) is spawned by the runner (Task 7), which also
 * owns the 15-minute cache and the "encoder: nvenc requested, cq falling back to cpu" warning. */

export type EncoderChoice = "nvenc" | "cpu";

/** One-shot NVENC availability probe argv (Task 7 spawns this, caches the result 15 minutes). */
export const NVENC_PROBE_ARGS = ["-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-"];

/**
 * `cfg: "auto"` picks `nvenc` when `nvencAvailable`, else `cpu`. `cfg: "nvenc"` with `nvencAvailable: false`
 * also falls back to `cpu` (the runner is the one that warns about this -- this function just decides).
 * `cfg: "cpu"` is always `cpu`, probe or not.
 */
export function resolveEncoder(cfg: "auto" | "nvenc" | "cpu", nvencAvailable: boolean): EncoderChoice {
  if (cfg === "cpu") return "cpu";
  return nvencAvailable ? "nvenc" : "cpu";
}

/**
 * Video encoder args for one mezzanine or final-render pass (spec §5.1/§5.4). `tier: "mezz"` favors speed
 * (NVENC `p4`/`cq 18`, CPU `veryfast`/low crf); `tier: "final"` favors quality (NVENC `p6 tune hq`/`cq 19`
 * with a bitrate cap, CPU `slow`/higher crf). `hevc` swaps the codec name and, for NVENC final, adds the
 * `hvc1` tag Apple/QuickTime need to read an HEVC `.mp4` at all.
 */
export function videoEncoderArgs(p: { choice: EncoderChoice; codec: "h264" | "hevc"; tier: "mezz" | "final"; fps: number }): string[] {
  const { choice, codec, tier, fps } = p;
  let args: string[];

  if (choice === "nvenc") {
    const enc = codec === "hevc" ? "hevc_nvenc" : "h264_nvenc";
    if (tier === "mezz") {
      args = ["-c:v", enc, "-preset", "p4", "-rc", "vbr", "-cq", "18", "-b:v", "0"];
    } else {
      args = ["-c:v", enc, "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-maxrate", "60M", "-bufsize", "120M", "-profile:v", codec === "hevc" ? "main" : "high"];
      if (codec === "hevc") args.push("-tag:v", "hvc1");
    }
  } else {
    const enc = codec === "hevc" ? "libx265" : "libx264";
    if (tier === "mezz") {
      args = ["-c:v", enc, "-preset", "veryfast", "-crf", codec === "hevc" ? "18" : "16"];
    } else {
      args = ["-c:v", enc, "-preset", "slow", "-crf", codec === "hevc" ? "20" : "18"];
      if (codec !== "hevc") args.push("-profile:v", "high");
    }
  }

  args.push("-pix_fmt", "yuv420p", "-r", String(fps), "-g", String(tier === "mezz" ? fps : 2 * fps));
  return args;
}
