// Shared ffmpeg/ffprobe helpers for the fake footage-production wrappers.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** @param {string[]} args @returns {void} */
export function ffmpeg(args) {
  const bin = process.env.FFMPEG_PATH ?? "ffmpeg";
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed (status ${String(r.status)}): ${r.stderr ?? r.error?.message ?? "unknown error"}`);
  }
}

/** @param {string} path @returns {number} */
export function probeDuration(path) {
  const bin = process.env.FFPROBE_PATH ?? "ffprobe";
  const r = spawnSync(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${bin} probe ${path} failed (status ${String(r.status)}): ${r.stderr ?? r.error?.message ?? "unknown error"}`);
  }
  return Number(r.stdout.trim());
}

/** @param {string} uri @returns {string} */
export function fileUrlToPath(uri) {
  return fileURLToPath(uri);
}
