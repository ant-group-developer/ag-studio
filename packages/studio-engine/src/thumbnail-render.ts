/**
 * Thumbnail pictures with ffmpeg on the Studio node: cut a frame of the final video, draw the words of a thumbnail
 * on a frame (libass, the same Arial the render worker uses — no font is shipped: it comes from the machine), and
 * turn any picture into a YouTube-size JPEG of at most 2 MB. Processes run asynchronously (a stage's heartbeat keeps
 * beating while ffmpeg works) with a timeout; the child gets no Studio secret.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THUMBNAIL_MAX_BYTES, type ThumbnailStyle } from "@harness/contracts";
import { childEnvWithoutSecrets, escapeFilterPath, thumbnailAss } from "@harness/core";

export interface ThumbnailSize { width: number; height: number }

export interface ThumbnailRenderer {
  /** One frame of `video` at `t_s`, scaled to fill `size` and centre-cropped, as a JPEG. */
  extractFrame(video: string, t_s: number, out: string, size: ThumbnailSize): Promise<void>;
  /** `lines` drawn on `base` (a JPEG of `size`) into `out`. */
  compose(base: string, out: string, p: { lines: string[]; style: ThumbnailStyle; size: ThumbnailSize }): Promise<void>;
  /** Any picture (an upload, a Canva export) as a `size` JPEG of at most 2 MB. */
  normalize(input: string, out: string, size: ThumbnailSize): Promise<void>;
}

/**
 * Where libass looks for the thumbnail font (Arial) first: `STUDIO_FONTS_DIR`, else the Windows fonts. Elsewhere
 * none: fontconfig answers, and on Linux it maps Arial to Liberation Sans (same metrics, Vietnamese glyphs; the
 * image installs fonts-liberation2).
 */
export function defaultFontsDir(): string | undefined {
  return process.env.STUDIO_FONTS_DIR || (process.platform === "win32" ? "C:\\Windows\\Fonts" : undefined);
}

function fill(size: ThumbnailSize): string {
  return `scale=w=${size.width}:h=${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: childEnvWithoutSecrets(), windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${signal ? `killed (${signal})` : `exited ${code}`}: ${stderr.trim()}`));
    });
  });
}

export function ffmpegThumbnailRenderer(o: { ffmpeg: string; fontsDir?: string; fontName?: string; timeoutMs?: number }): ThumbnailRenderer {
  const timeout = o.timeoutMs ?? 120_000;
  const fontsDir = o.fontsDir ?? defaultFontsDir();
  const ffmpeg = (args: string[]) => run(o.ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", ...args], timeout);

  /** Re-encode to JPEG, stepping the quality down until the file is at most 2 MB. */
  async function jpegUnderLimit(input: string, out: string, filter: string): Promise<void> {
    for (const q of [2, 4, 7, 12]) {
      await ffmpeg(["-i", input, "-frames:v", "1", "-vf", filter, "-q:v", String(q), "-y", out]);
      if (statSync(out).size <= THUMBNAIL_MAX_BYTES) return;
    }
    throw new Error(`thumbnail still above ${THUMBNAIL_MAX_BYTES} bytes at the lowest quality`);
  }

  return {
    async extractFrame(video, t_s, out, size) {
      // -ss before -i: seek to the nearest keyframe then decode up to t_s (fast on a long 4K file, frame-accurate)
      await ffmpeg(["-ss", t_s.toFixed(3), "-i", video, "-frames:v", "1", "-vf", fill(size), "-q:v", "3", "-y", out]);
    },
    async compose(base, out, p) {
      const dir = mkdtempSync(join(tmpdir(), "studio-thumb-"));
      try {
        const ass = join(dir, "thumb.ass");
        writeFileSync(ass, thumbnailAss({ width: p.size.width, height: p.size.height, lines: p.lines, style: p.style, ...(o.fontName ? { fontName: o.fontName } : {}) }));
        const filter = `${fill(p.size)},ass=filename='${escapeFilterPath(ass)}'${fontsDir ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : ""}`;
        await jpegUnderLimit(base, out, filter);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async normalize(input, out, size) {
      await jpegUnderLimit(input, out, fill(size));
    },
  };
}
