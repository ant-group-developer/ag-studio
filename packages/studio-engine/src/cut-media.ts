/** Small pieces the worker wires into `CutMediaDeps` (shot-cut stages). */
import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Downloads `url` to `dest` as a stream; an HTTP error or a broken transfer throws and removes the partial file.
 * `onBytes`: bytes so far, and the size when the server says it.
 */
export async function httpDownload(url: string, dest: string, signal?: AbortSignal, onBytes?: (received: number, total: number | null) => void): Promise<void> {
  const res = await fetch(url, signal ? { signal } : {});
  // the status rides on the error: a caller retries ag-go's 503 but not a 403
  if (!res.ok || !res.body) throw Object.assign(new Error(`download failed: HTTP ${res.status}`), { status: res.status });
  const total = Number(res.headers.get("content-length")) || null;
  let received = 0;
  const body = Readable.fromWeb(res.body as never);
  if (onBytes) body.on("data", (c: Buffer) => { received += c.length; onBytes(received, total); });
  try {
    await pipeline(body, createWriteStream(dest));
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
}

/** `ffprobe` in the folder of `ffmpeg` (same extension); a bare `ffmpeg` gives a bare `ffprobe` (PATH). */
export function ffprobeBeside(ffmpeg: string): string {
  return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, ext: string | undefined) => `ffprobe${ext ?? ""}`);
}
