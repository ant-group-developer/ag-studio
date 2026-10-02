/**
 * Thumbnails with a real ffmpeg (skipped without one; FFMPEG_PATH may point at any ffmpeg, ffprobe is not needed):
 * a frame cut at the asked moment and filled to 1280x720, Vietnamese words drawn on it, a big PNG normalised.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THUMBNAIL_MAX_BYTES, type ThumbnailStyle } from "@harness/contracts";
import { defaultFontsDir, ffmpegThumbnailRenderer } from "../src/thumbnail-render.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;
const fontsDir = defaultFontsDir();
/** Arial in the fonts folder, or anything fontconfig gives for it (Liberation Sans on Linux). */
const hasArial = fontsDir
  ? existsSync(fontsDir) && readdirSync(fontsDir).some((f) => /^arial(bd)?\.ttf$/i.test(f))
  : spawnSync("fc-match", ["Arial"]).status === 0;

/** Width and height of a JPEG from its SOF marker. */
function jpegSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}

/** The average colour of a picture (scaled to one pixel). */
function rgb(path: string): [number, number, number] {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", path, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [r.stdout[0]!, r.stdout[1]!, r.stdout[2]!];
}

const style: ThumbnailStyle = { position: "bottom", size: "l", text_color: "#FFFF00", outline_color: "#000000", box_color: null, uppercase: true };

describe.skipIf(!hasFfmpeg)("ffmpeg thumbnail renderer", () => {
  const dir = mkdtempSync(join(tmpdir(), "thumb-render-"));
  const video = join(dir, "final.mp4");
  spawnSync(FFMPEG, [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1920x1080:d=1.5:r=25", "-f", "lavfi", "-i", "color=c=blue:s=1920x1080:d=1.5:r=25",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video,
  ]);
  const r = ffmpegThumbnailRenderer({ ffmpeg: FFMPEG });

  it("cuts the frame at the asked moment, filled to the thumbnail size", async () => {
    const red = join(dir, "red.jpg");
    const blue = join(dir, "blue.jpg");
    await r.extractFrame(video, 0.5, red, { width: 1280, height: 720 });
    await r.extractFrame(video, 2.5, blue, { width: 1280, height: 720 });
    expect(jpegSize(red)).toEqual({ width: 1280, height: 720 });
    expect(rgb(red)[0]).toBeGreaterThan(200);
    expect(rgb(blue)[2]).toBeGreaterThan(200);
    const portrait = join(dir, "portrait.jpg");
    await r.extractFrame(video, 0.5, portrait, { width: 720, height: 1280 });
    expect(jpegSize(portrait)).toEqual({ width: 720, height: 1280 });
  });

  it.skipIf(!hasArial)("draws Vietnamese words on a frame", async () => {
    const base = join(dir, "base.jpg");
    const out = join(dir, "composed.jpg");
    await r.extractFrame(video, 2.5, base, { width: 1280, height: 720 });
    await r.compose(base, out, { lines: ["PHỞ SÁNG", "HÀ NỘI"], style, size: { width: 1280, height: 720 } });
    expect(jpegSize(out)).toEqual({ width: 1280, height: 720 });
    // yellow words on blue: the average gets red and green that plain blue does not have
    const [rb, gb] = rgb(base);
    const [ro, go] = rgb(out);
    expect(ro - rb).toBeGreaterThan(5);
    expect(go - gb).toBeGreaterThan(5);
  });

  it("normalises a big picture to the thumbnail size under 2 MB", async () => {
    const png = join(dir, "big.png");
    spawnSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=4000x3000", "-frames:v", "1", png]);
    const out = join(dir, "upload.jpg");
    await r.normalize(png, out, { width: 1280, height: 720 });
    expect(jpegSize(out)).toEqual({ width: 1280, height: 720 });
    expect(statSync(out).size).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
  });

  it("fails with ffmpeg's message for a file that is not a picture", async () => {
    await expect(r.normalize(join(dir, "missing.png"), join(dir, "x.jpg"), { width: 1280, height: 720 })).rejects.toThrow(/ffmpeg exited/);
  });
});
