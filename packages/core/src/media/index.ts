import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError, ShotsIndexSchema, type MediaConfig, type ShotsIndex } from "@harness/contracts";
import { buildShots, shotId } from "./scene.js";
import { detectSceneChanges, type WatchLogFn } from "./watch.js";

/** `probe` is injected (task 8 wires an ffprobe-backed function; tests may pass a real ffprobe-backed
 * function or a stub) and, unlike `MediaProber.probe`, is synchronous: `indexSources` itself has no need to
 * await it, and every caller so far can answer it without a promise. */
export interface IndexDeps {
  ffmpeg: string;
  probe: (path: string) => { duration_seconds: number | null; has_audio: boolean } | null;
  detect?: typeof detectSceneChanges;
  log?: WatchLogFn;
}

const noopLog: WatchLogFn = () => {};

/** `-vf scale=-2:<proxy_height> -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac`, with
 * `-map 0:v:0 -map 0:a:0?` so a source with no audio stream still encodes instead of failing. */
function encodeProxy(ffmpeg: string, sourcePath: string, outPath: string, proxyHeight: number): boolean {
  mkdirSync(dirname(outPath), { recursive: true });
  const r = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i", sourcePath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf", `scale=-2:${proxyHeight}`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      outPath,
    ],
    { encoding: "utf8" },
  );
  return r.status === 0 && existsSync(outPath);
}

type ShotsSource = ShotsIndex["sources"][number];

function unusableSource(source: { source_id: string; file_name: string }, index: number, reason: string): ShotsSource {
  return { source_id: source.source_id, index, file_name: source.file_name, duration_seconds: 0, has_audio: false, error: reason, shots: [] };
}

/**
 * Builds `shots.json` (`ShotsIndex`) for a set of sources: probe each for duration/audio, run scene detection
 * (`detect`, defaulting to `detectSceneChanges`) at the configured threshold, turn the cuts into shots with
 * `buildShots`, and encode a low-res proxy per usable source at `<proxyDir>/<source_id>.mp4`.
 *
 * A source whose probe returns `null`, throws, or whose duration is `null`/`<= 0` is not fatal to the whole
 * index: it gets `{ error: "<reason>", shots: [], duration_seconds: 0, has_audio: false }` and the loop moves
 * on. Only when *no* source ends up with any shots does this throw `CONFIG_INVALID` ("no usable source") --
 * a stage with zero usable footage has nothing downstream can do anything with.
 */
export function indexSources(
  d: IndexDeps,
  p: { sources: { source_id: string; path: string; file_name: string }[]; scene: MediaConfig["scene"]; proxyDir: string },
): ShotsIndex {
  const log = d.log ?? noopLog;
  const detect = d.detect ?? detectSceneChanges;

  const sources: ShotsSource[] = p.sources.map((source, index) => {
    let probed: { duration_seconds: number | null; has_audio: boolean } | null;
    try {
      probed = d.probe(source.path);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log("warn", "indexSources: probe threw", { source_id: source.source_id, path: source.path, error: reason });
      return unusableSource(source, index, reason);
    }

    const duration = probed?.duration_seconds ?? null;
    if (probed === null || duration === null || duration <= 0) {
      const reason = probed === null ? "probe failed" : duration === null ? "duration unknown" : "duration is zero or negative";
      log("warn", "indexSources: unusable source", { source_id: source.source_id, path: source.path, reason });
      return unusableSource(source, index, reason);
    }

    const cuts = detect(d.ffmpeg, source.path, p.scene.threshold);
    const shots = buildShots(cuts, duration, { min_shot_seconds: p.scene.min_shot_seconds, max_shot_seconds: p.scene.max_shot_seconds }).map(
      (shot, shotIndex) => ({ shot_id: shotId(index, shotIndex), in: shot.in, out: shot.out }),
    );

    const proxyPath = join(p.proxyDir, `${source.source_id}.mp4`);
    if (!encodeProxy(d.ffmpeg, source.path, proxyPath, p.scene.proxy_height)) {
      log("warn", "indexSources: proxy encode failed", { source_id: source.source_id, path: proxyPath });
    }

    return { source_id: source.source_id, index, file_name: source.file_name, duration_seconds: duration, has_audio: probed.has_audio, shots };
  });

  if (sources.every((s) => s.shots.length === 0)) {
    throw new HarnessError("CONFIG_INVALID", "no usable source", { sources: sources.map((s) => s.source_id) });
  }

  return ShotsIndexSchema.parse({ schema_version: "harness.shots/v2", sources });
}
