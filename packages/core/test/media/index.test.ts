import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type MediaConfig } from "@harness/contracts";
import { hasFfmpeg } from "../../../../tests/media.js";
import { indexSources } from "../../src/media/index.js";

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobeBin(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

const SCENE: MediaConfig["scene"] = { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20, proxy_height: 540 };

/** Three 2s solid-color segments (red, blue, green) concatenated into one 6s clip, no audio -- an
 * unambiguous multi-scene fixture for `indexSources`, built the same way `tests/media.ts#makeVideo`'s
 * `scene_cut_at` option builds its two-segment fixture (that helper only supports two segments). */
function makeThreeSceneVideo(path: string): void {
  const args = [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2:r=25",
    "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=25",
    "-f", "lavfi", "-i", "color=c=green:s=320x180:d=2:r=25",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    path,
  ];
  const r = spawnSync(ffmpegBin(), args);
  if (r.status !== 0) throw new Error(`ffmpeg failed building fixture: ${r.stderr?.toString("utf8") ?? ""}`);
}

/** Small real ffprobe-backed `IndexDeps.probe`: duration via `format=duration`, has_audio via whether an
 * audio stream is listed. Returns null when ffprobe itself fails (e.g. the file is not a real media file). */
function realProbe(path: string): { duration_seconds: number | null; has_audio: boolean } | null {
  const durR = spawnSync(ffprobeBin(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (durR.status !== 0) return null;
  const duration_seconds = Number(durR.stdout.trim());
  const audioR = spawnSync(ffprobeBin(), ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path], { encoding: "utf8" });
  const has_audio = audioR.status === 0 && audioR.stdout.trim().length > 0;
  return { duration_seconds: Number.isFinite(duration_seconds) ? duration_seconds : null, has_audio };
}

describe.skipIf(!hasFfmpeg())("indexSources (needs ffmpeg)", () => {
  it("finds >=3 shots with s000-00N ids and writes a 540px-tall proxy for a 3-scene video", () => {
    const dir = mkdtempSync(join(tmpdir(), "index-sources-"));
    const clip = join(dir, "clip.mp4");
    makeThreeSceneVideo(clip);
    const proxyDir = join(dir, "proxy");
    const sourceId = newId("source_item");

    const idx = indexSources(
      { ffmpeg: ffmpegBin(), probe: realProbe },
      { sources: [{ source_id: sourceId, path: clip, file_name: "clip.mp4" }], scene: SCENE, proxyDir },
    );

    expect(idx.sources).toHaveLength(1);
    const source = idx.sources[0]!;
    expect(source.error).toBeUndefined();
    expect(source.shots.length).toBeGreaterThanOrEqual(3);
    for (const shot of source.shots) expect(shot.shot_id).toMatch(/^s000-\d{3}$/);
    // shot_ids are unique and, within a source, ascending by shot index.
    expect(new Set(source.shots.map((s) => s.shot_id)).size).toBe(source.shots.length);

    const proxyPath = join(proxyDir, `${sourceId}.mp4`);
    expect(existsSync(proxyPath)).toBe(true);
    const heightR = spawnSync(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", proxyPath], { encoding: "utf8" });
    expect(heightR.stdout.trim()).toBe("540");
  });

  it("a broken source gets {error, shots: []} while a good source alongside it still indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "index-sources-mixed-"));
    const goodClip = join(dir, "good.mp4");
    makeThreeSceneVideo(goodClip);
    const badClip = join(dir, "bad.mp4");
    writeFileSync(badClip, "not a video file");
    const proxyDir = join(dir, "proxy");

    const idx = indexSources(
      { ffmpeg: ffmpegBin(), probe: realProbe },
      {
        sources: [
          { source_id: newId("source_item"), path: badClip, file_name: "bad.mp4" },
          { source_id: newId("source_item"), path: goodClip, file_name: "good.mp4" },
        ],
        scene: SCENE,
        proxyDir,
      },
    );

    expect(idx.sources).toHaveLength(2);
    expect(idx.sources[0]!.error).toBeTruthy();
    expect(idx.sources[0]!.shots).toEqual([]);
    expect(idx.sources[0]!.duration_seconds).toBe(0);
    expect(idx.sources[0]!.has_audio).toBe(false);
    expect(idx.sources[1]!.error).toBeUndefined();
    expect(idx.sources[1]!.shots.length).toBeGreaterThan(0);
  });

  it("throws CONFIG_INVALID when every source is unusable", () => {
    const dir = mkdtempSync(join(tmpdir(), "index-sources-allbad-"));
    const bad1 = join(dir, "bad1.mp4");
    const bad2 = join(dir, "bad2.mp4");
    writeFileSync(bad1, "nope");
    writeFileSync(bad2, "also nope");
    const proxyDir = join(dir, "proxy");

    const call = () =>
      indexSources(
        { ffmpeg: ffmpegBin(), probe: realProbe },
        {
          sources: [
            { source_id: newId("source_item"), path: bad1, file_name: "bad1.mp4" },
            { source_id: newId("source_item"), path: bad2, file_name: "bad2.mp4" },
          ],
          scene: SCENE,
          proxyDir,
        },
      );

    expect(call).toThrowError(/no usable source/);
    try {
      call();
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });
});
