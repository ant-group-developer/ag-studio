import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MediaProbe, MediaProber, WatchTranscript } from "@harness/contracts";
import { hasFfmpegOnPath as hasFfmpeg, makeVideo } from "../../../../tests/media.js";
import { watchVideos } from "../../src/media/watch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_TRANSCRIBE = join(HERE, "fake-transcribe.mjs");

/** Same tiny real prober `watch.test.ts` uses: shells ffprobe directly (core must not import the ffprobe
 * adapter, per the task-2 brief). */
class RealDurationProber implements MediaProber {
  async probe(path: string): Promise<MediaProbe | null> {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const duration_seconds = Number(r.stdout.trim());
    return { media: null, duration_seconds: Number.isFinite(duration_seconds) ? duration_seconds : null, mime_type: null, container: null, video: null, audio: null };
  }
}

describe.skipIf(!hasFfmpeg())("watchVideos: multi-source sheet budget and transcript-from-input (needs ffmpeg)", () => {
  it("distributes max_sheets proportionally to duration, at least 1 sheet per video, total within budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-multi-sheets-"));
    const shortClip = join(dir, "short.mp4");
    const midClip = join(dir, "mid.mp4");
    const longClip = join(dir, "long.mp4");
    makeVideo(shortClip, { seconds: 2, audio: false });
    makeVideo(midClip, { seconds: 6, audio: false });
    makeVideo(longClip, { seconds: 12, audio: false });
    const outDir = join(dir, "out");

    const index = await watchVideos(
      { prober: new RealDurationProber() },
      { mode: "source", outDir, interval_seconds: 2, max_frames: 30, max_sheets: 4 },
      [
        { label: "short", path: shortClip },
        { label: "mid", path: midClip },
        { label: "long", path: longClip },
      ],
    );

    expect(index.videos).toHaveLength(3);
    let totalSheets = 0;
    for (const v of index.videos) {
      expect(v.sheets.length).toBeGreaterThanOrEqual(1);
      totalSheets += v.sheets.length;
    }
    expect(totalSheets).toBeLessThanOrEqual(4);
    // the longest video's proportional share is the largest, so it should get at least as many sheets as
    // either of the shorter ones.
    const [short, mid, long] = index.videos;
    expect(long!.sheets.length).toBeGreaterThanOrEqual(mid!.sheets.length);
    expect(mid!.sheets.length).toBeGreaterThanOrEqual(short!.sheets.length);
  });

  it("gives every video exactly 1 sheet when there are more videos than max_sheets (degenerate budget)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-multi-degenerate-"));
    const clips = ["a", "b", "c"].map((name) => join(dir, `${name}.mp4`));
    for (const clip of clips) makeVideo(clip, { seconds: 3, audio: false });
    const outDir = join(dir, "out");

    const index = await watchVideos(
      { prober: new RealDurationProber() },
      { mode: "source", outDir, interval_seconds: 1, max_frames: 30, max_sheets: 2 },
      clips.map((path, i) => ({ label: `v${i}`, path })),
    );

    expect(index.videos).toHaveLength(3);
    for (const v of index.videos) expect(v.sheets.length).toBe(1);
  });

  it("uses transcriptBySource (keyed by source_id, falling back to label) and never invokes the transcribe hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-multi-transcript-"));
    const clipA = join(dir, "a.mp4");
    const clipB = join(dir, "b.mp4");
    makeVideo(clipA, { seconds: 2, audio: false });
    makeVideo(clipB, { seconds: 2, audio: false });
    const outDir = join(dir, "out");

    const providedA: WatchTranscript = { segments: [{ start: 0, end: 1, text: "from input a" }] };
    const providedB: WatchTranscript = { segments: [{ start: 0, end: 1, text: "from input b" }] };

    const index = await watchVideos(
      {
        prober: new RealDurationProber(),
        // If this hook were invoked, it would succeed and write labelDir/transcript.json (see fake-transcribe.mjs);
        // its absence below is the spy that proves it was never called.
        transcribe: { argv: [process.execPath, FAKE_TRANSCRIBE], cwd: dir, timeout_seconds: 10, env: { ...process.env } },
      },
      {
        mode: "source",
        outDir,
        interval_seconds: 1,
        max_frames: 10,
        transcriptBySource: { "src-a": providedA, b: providedB },
      },
      [
        { label: "a", path: clipA, source_id: "src-a" },
        { label: "b", path: clipB },
      ],
    );

    expect(index.videos[0]!.transcript).toEqual(providedA);
    expect(index.videos[0]!.transcript_error).toBeUndefined();
    expect(index.videos[1]!.transcript).toEqual(providedB);
    expect(index.videos[1]!.transcript_error).toBeUndefined();

    expect(existsSync(join(outDir, "a", "transcript.json"))).toBe(false);
    expect(existsSync(join(outDir, "b", "transcript.json"))).toBe(false);
  });

  it("falls back to the transcribe hook for a video with no matching transcriptBySource entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-multi-transcript-fallback-"));
    const clipA = join(dir, "a.mp4");
    const clipB = join(dir, "b.mp4");
    makeVideo(clipA, { seconds: 2, audio: false });
    makeVideo(clipB, { seconds: 2, audio: false });
    const outDir = join(dir, "out");

    const providedA: WatchTranscript = { segments: [{ start: 0, end: 1, text: "from input a" }] };

    const index = await watchVideos(
      {
        prober: new RealDurationProber(),
        transcribe: { argv: [process.execPath, FAKE_TRANSCRIBE], cwd: dir, timeout_seconds: 10, env: { ...process.env } },
      },
      { mode: "source", outDir, interval_seconds: 1, max_frames: 10, transcriptBySource: { "src-a": providedA } },
      [
        { label: "a", path: clipA, source_id: "src-a" },
        { label: "b", path: clipB },
      ],
    );

    expect(index.videos[0]!.transcript).toEqual(providedA);
    expect(index.videos[1]!.transcript).toEqual({ segments: [{ start: 0, end: 1, text: "xin chào" }] });
    expect(existsSync(join(outDir, "a", "transcript.json"))).toBe(false);
    expect(existsSync(join(outDir, "b", "transcript.json"))).toBe(true);
  });
});
