import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isHarnessError, type MediaProbe, type MediaProber } from "@harness/contracts";
import { hasFfmpeg, makeVideo } from "../../../../tests/media.js";
import {
  WATCH_DEFAULTS,
  detectSceneChanges,
  frameFileName,
  pickFrameTimes,
  watchFromExistingFrames,
  watchVideos,
} from "../../src/media/watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_TRANSCRIBE = join(HERE, "fake-transcribe.mjs");

/** Minimal MediaProber that shells ffprobe directly for `duration_seconds`, per the task-2 brief
 * (core must not import the ffprobe adapter; this test constructs its own tiny prober instead). */
class RealDurationProber implements MediaProber {
  async probe(path: string): Promise<MediaProbe | null> {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const duration_seconds = Number(r.stdout.trim());
    return {
      media: null,
      duration_seconds: Number.isFinite(duration_seconds) ? duration_seconds : null,
      mime_type: null,
      container: null,
      video: null,
      audio: null,
    };
  }
}

describe("WATCH_DEFAULTS", () => {
  it("has defaults for all three modes", () => {
    expect(WATCH_DEFAULTS.samples).toEqual({ interval_seconds: 8, max_frames: 60 });
    expect(WATCH_DEFAULTS.source).toEqual({ interval_seconds: 10, max_frames: 120 });
    expect(WATCH_DEFAULTS.episode).toEqual({ interval_seconds: 15, max_frames: 80 });
  });
});

describe("frameFileName", () => {
  it("formats a timestamp with one decimal, zero-padded to width 7", () => {
    expect(frameFileName(12.5)).toBe("f-00012.5.png");
  });

  it("pads a single-digit timestamp", () => {
    expect(frameFileName(0)).toBe("f-00000.0.png");
  });
});

describe("pickFrameTimes", () => {
  it("merges scene + marks + interval, dedupes within 1s, and thins interval before scene when over budget", () => {
    const result = pickFrameTimes({ duration: 100, scene: [3, 3.5, 40], marks: [50], interval_seconds: 10, max_frames: 8 });

    expect(result.length).toBeLessThanOrEqual(8);

    const ts = result.map((r) => r.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(1);
    }

    const sceneTimes = result.filter((r) => r.kind === "scene").map((r) => r.t);
    expect(sceneTimes).toEqual([3, 40, 50]);

    const intervalCount = result.filter((r) => r.kind === "interval").length;
    expect(intervalCount).toBeGreaterThan(0);
    expect(intervalCount).toBeLessThan(9); // fewer than the 9 un-thinned interval candidates: interval was thinned
  });

  it("thins scene marks evenly once interval is already exhausted and scene alone exceeds max_frames", () => {
    const result = pickFrameTimes({ duration: 30, scene: [5, 10, 25], marks: [], interval_seconds: 5, max_frames: 2 });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.kind === "scene")).toBe(true);
    // evenly thinned from [5, 10, 25]: first and last kept
    expect(result.map((r) => r.t)).toEqual([5, 25]);
  });

  it("keeps everything when under budget", () => {
    const result = pickFrameTimes({ duration: 20, scene: [5], marks: [], interval_seconds: 10, max_frames: 60 });
    const ts = result.map((r) => r.t).sort((a, b) => a - b);
    expect(ts).toEqual([0, 5, 10, 20]);
  });
});

describe("watchFromExistingFrames", () => {
  it("builds a valid index from pre-existing frame images (2C fixture, no ffmpeg)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "watch-existing-"));
    const idx = watchFromExistingFrames({ mode: "samples", outDir }, [
      {
        label: "a",
        source_path: "/src/a.mp4",
        frames: [join(outDir, "a", "f-1.png"), join(outDir, "a", "f-2.png"), join(outDir, "a", "f-3.png")],
      },
      { label: "b", source_path: "/src/b.mp4", frames: [join(outDir, "b", "f-1.png")] },
    ]);

    expect(idx.schema_version).toBe("harness.watch/v1");
    expect(idx.mode).toBe("samples");
    expect(idx.videos).toHaveLength(2);

    expect(idx.videos[0].label).toBe("a");
    expect(idx.videos[0].frames).toEqual([
      { t: 0, file: "a/f-1.png", kind: "interval" },
      { t: 1, file: "a/f-2.png", kind: "interval" },
      { t: 2, file: "a/f-3.png", kind: "interval" },
    ]);
    expect(idx.videos[0].sheets).toEqual([]);
    expect(idx.videos[0].transcript).toBeNull();
    expect(idx.videos[0].transcript_error).toBeUndefined();

    expect(idx.videos[1].frames).toEqual([{ t: 0, file: "b/f-1.png", kind: "interval" }]);
  });
});

/** Reports a fixed duration for any path, so the ffmpeg-missing tests below never need ffprobe or a real
 * file -- the point is what `watchVideos` does once it believes there is something to extract frames from. */
class FixedDurationProber implements MediaProber {
  constructor(private readonly seconds: number) {}
  async probe(): Promise<MediaProbe> {
    return { media: null, duration_seconds: this.seconds, mime_type: null, container: null, video: null, audio: null };
  }
}

// Final-review finding I-2: a studio with ffprobe but no ffmpeg used to get a SUCCEEDED, completely empty
// `watch/` -- every ffmpeg spawn failed with ENOENT, which only ever became a warning.
describe("missing ffmpeg binary", () => {
  it("detectSceneChanges throws CONFIG_INVALID instead of reporting 'no scene changes'", () => {
    expect(() => detectSceneChanges("definitely-missing-ffmpeg", "clip.mp4", 0.3)).toThrowError(/ffmpeg not available/);
    try {
      detectSceneChanges("definitely-missing-ffmpeg", "clip.mp4", 0.3);
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("watchVideos rejects with CONFIG_INVALID rather than writing a frameless watch.json", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "watch-no-ffmpeg-"));
    await expect(
      watchVideos({ prober: new FixedDurationProber(10), ffmpeg: "definitely-missing-ffmpeg" }, { mode: "source", outDir }, [
        { label: "clip", path: join(outDir, "clip.mp4") },
      ]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(existsSync(join(outDir, "watch.json"))).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg())("detectSceneChanges (needs ffmpeg)", () => {
  it("finds a scene cut near scene_cut_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-scene-"));
    const clip = join(dir, "clip.mp4");
    makeVideo(clip, { seconds: 12, audio: false, scene_cut_at: 6 });

    const marks = detectSceneChanges("ffmpeg", clip, 0.3);

    expect(marks.length).toBeGreaterThan(0);
    expect(marks.some((t) => Math.abs(t - 6) <= 0.5)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg())("watchVideos (needs ffmpeg)", () => {
  it("extracts frames at scene+interval marks, writes one contact sheet, and a parseable watch.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-videos-"));
    const clip = join(dir, "clip.mp4");
    makeVideo(clip, { seconds: 12, audio: false, scene_cut_at: 4 });
    const outDir = join(dir, "out");

    const index = await watchVideos(
      { prober: new RealDurationProber() },
      { mode: "source", outDir, interval_seconds: 3, max_frames: 6 },
      [{ label: "clip", path: clip, shot_marks: [4] }],
    );

    expect(index.mode).toBe("source");
    expect(index.videos).toHaveLength(1);
    const v = index.videos[0];

    expect(v.frames.length).toBeGreaterThan(0);
    expect(v.frames.length).toBeLessThanOrEqual(6);
    expect(v.frames.some((f) => f.kind === "scene" && Math.abs(f.t - 4) <= 1)).toBe(true);
    for (const f of v.frames) {
      expect(existsSync(join(outDir, f.file))).toBe(true);
      expect(f.file.includes("\\")).toBe(false);
    }

    expect(v.sheets).toHaveLength(1);
    for (const s of v.sheets) expect(existsSync(join(outDir, s))).toBe(true);

    expect(v.transcript).toBeNull();
    expect(v.transcript_error).toBeUndefined();

    const writtenPath = join(outDir, "watch.json");
    expect(existsSync(writtenPath)).toBe(true);
    const written = JSON.parse(readFileSync(writtenPath, "utf8"));
    expect(written.mode).toBe("source");
    expect(written.videos[0].label).toBe("clip");
  });

  it("parses segments from a successful transcribe run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-transcribe-ok-"));
    const clip = join(dir, "clip.mp4");
    makeVideo(clip, { seconds: 2, audio: false });
    const outDir = join(dir, "out");

    const index = await watchVideos(
      {
        prober: new RealDurationProber(),
        transcribe: { argv: [process.execPath, FAKE_TRANSCRIBE], cwd: dir, timeout_seconds: 10, env: { ...process.env } },
      },
      { mode: "source", outDir, interval_seconds: 5, max_frames: 4 },
      [{ label: "clip", path: clip }],
    );

    const v = index.videos[0];
    expect(v.transcript_error).toBeUndefined();
    expect(v.transcript).not.toBeNull();
    expect(v.transcript?.segments).toEqual([{ start: 0, end: 1, text: "xin chào" }]);
  });

  it("sets transcript null + transcript_error when the transcribe child crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-transcribe-crash-"));
    const clip = join(dir, "clip.mp4");
    makeVideo(clip, { seconds: 2, audio: false });
    const outDir = join(dir, "out");

    const index = await watchVideos(
      {
        prober: new RealDurationProber(),
        transcribe: {
          argv: [process.execPath, FAKE_TRANSCRIBE],
          cwd: dir,
          timeout_seconds: 10,
          env: { ...process.env, FAKE_TRANSCRIBE: "crash" },
        },
      },
      { mode: "source", outDir, interval_seconds: 5, max_frames: 4 },
      [{ label: "clip", path: clip }],
    );

    const v = index.videos[0];
    expect(v.transcript).toBeNull();
    expect(v.transcript_error).toBeTruthy();
  });

  it("times out a hung transcribe child within its timeout_seconds and never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-transcribe-hang-"));
    const clip = join(dir, "clip.mp4");
    makeVideo(clip, { seconds: 2, audio: false });
    const outDir = join(dir, "out");

    const start = Date.now();
    const index = await watchVideos(
      {
        prober: new RealDurationProber(),
        transcribe: {
          argv: [process.execPath, FAKE_TRANSCRIBE],
          cwd: dir,
          timeout_seconds: 1,
          env: { ...process.env, FAKE_TRANSCRIBE: "hang" },
        },
      },
      { mode: "source", outDir, interval_seconds: 5, max_frames: 4 },
      [{ label: "clip", path: clip }],
    );
    const elapsed = Date.now() - start;

    // The child sleeps 30 s, so this only bounds "killed, not waited out"; it also carries the frame
    // extraction, which under full-suite ffmpeg load alone can take several seconds.
    expect(elapsed).toBeLessThan(15_000);
    const v = index.videos[0];
    expect(v.transcript).toBeNull();
    expect(v.transcript_error).toMatch(/ETIMEDOUT|timed out/);
  });
});
