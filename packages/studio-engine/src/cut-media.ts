/** Small pieces the worker wires into `CutMediaDeps` (shot-cut stages). */
import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Downloads `url` to `dest` as a stream; an HTTP error or a broken transfer throws and removes the partial file. */
export async function httpDownload(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
}

/** `ffprobe` in the folder of `ffmpeg` (same extension); a bare `ffmpeg` gives a bare `ffprobe` (PATH). */
export function ffprobeBeside(ffmpeg: string): string {
  return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext: string | undefined) => `ffprobe${ext ?? ""}`);
}
