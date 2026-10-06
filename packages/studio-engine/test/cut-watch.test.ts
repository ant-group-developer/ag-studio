/** Contact sheets of a shot-cut episode on real synthetic proxies (skipped without ffmpeg + ffprobe). */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CutWatchSchema } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import { cutStages, MemoryBucket, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";
import { hasFfmpeg, makeSceneClip } from "../../../tests/media.js";

const media: CutMediaDeps = {
  ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe",
  resolveAssets: async () => ({ items: [], missing: [] }), download: async () => {},
};

describe.skipIf(!hasFfmpeg())("studio-watch-source (needs ffmpeg + ffprobe)", () => {
  const src = studioSourceId("a");
  let dir = "";
  beforeAll(() => {
    dir = join(mkdtempSync(join(tmpdir(), "proxies-")), "proxies");
    mkdirSync(dir, { recursive: true });
    makeSceneClip(join(dir, `${src}.mp4`), { seconds: 20, colors: ["black", "white", "gray", "navy", "yellow"] });
    writeFileSync(join(dir, "proxies.json"), JSON.stringify({ schema_version: "studio.cut-proxies/v1", proxies: [
      { index: 0, asset_id: "a", source_id: src, file: `${src}.mp4`, source_kind: "proxy", watermarked: false, bytes: 1 },
    ] }));
  });

  it("one frame per shot, sheets of 16 in shot order, each frame in the bucket", async () => {
    const shots = Array.from({ length: 18 }, (_, i) => ({ shot_id: `s000-${String(i).padStart(3, "0")}`, in: i, out: i + 1 }));
    const { db } = world();
    const bucket = new MemoryBucket();
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: { schema_version: "studio.cut-sources/v1", production_id: "prod-1", episode_id: "ep-1", language: "vi", narration: "tts",
        sources: [{ index: 0, asset_id: "a", source_id: src, title: "a", duration_s: 20, has_speech: null, hints: null }] } },
      { type: "proxy_set", name: "proxies", dir },
      { type: "shots", name: "shots.json", json: { schema_version: "harness.shots/v2", sources: [{ source_id: src, index: 0, file_name: `${src}.mp4`, duration_seconds: 20, has_audio: true, shots }] } },
    ] });
    await runStage(cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media })["studio-watch-source"], run);

    const watch = CutWatchSchema.parse(run.json("watch/watch.json"));
    const s = watch.sources[0]!;
    expect(s.shots).toHaveLength(18);
    expect(s.shots[3]).toMatchObject({ shot_id: "s000-003", t: 3.5, frame: "frames/s000-003.jpg", bucket_key: "productions/prod-1/episodes/ep-1/shots/s000-003.jpg" });
    expect(s.sheets.map((x) => [x.file, x.shots.length, x.shots[0]])).toEqual([["sheets/s000-01.jpg", 16, "s000-000"], ["sheets/s000-02.jpg", 2, "s000-016"]]);
    expect(existsSync(run.output("watch/frames/s000-017.jpg")) && existsSync(run.output("watch/sheets/s000-02.jpg"))).toBe(true);
    expect([...bucket.objects.keys()].filter((k) => k.includes("/shots/"))).toHaveLength(18);
  });
});
