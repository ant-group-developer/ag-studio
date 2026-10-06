/**
 * Shots and the transcription job of a shot-cut episode, on real synthetic proxies (skipped without ffmpeg + ffprobe;
 * FFMPEG_PATH / FFPROBE_PATH may point at any build).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ShotsIndexSchema } from "@harness/contracts";
import { StudioTranscribePayloadSchema, TranscribeManifestSchema } from "@ag-farm/protocol";
import { studioSourceId } from "@harness/core";
import { cutPayloadBuilders, cutStages, transcriptFromManifest, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";
import { hasFfmpeg, makeSceneClip } from "../../../tests/media.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const media: CutMediaDeps = {
  ffmpeg: FFMPEG, ffprobe: FFPROBE, voiceDir: join(tmpdir(), "voice"),
  resolveAssets: async () => ({ items: [], missing: [] }),
  download: async () => {},
};

function sources(ids: string[], speech: (boolean | null)[] = []) {
  return {
    schema_version: "studio.cut-sources/v1", production_id: "prod-1", episode_id: "ep-1", language: "vi", narration: "tts",
    sources: ids.map((id, index) => ({ index, asset_id: id, source_id: studioSourceId(id), title: id, duration_s: 9, has_speech: speech[index] ?? null, hints: null })),
  };
}

/** A proxy_set directory with one synthetic clip per asset. */
function proxySet(ids: string[], make: (id: string, path: string) => void): string {
  const dir = join(mkdtempSync(join(tmpdir(), "proxies-")), "proxies");
  mkdirSync(dir, { recursive: true });
  const proxies = ids.map((id, index) => {
    const file = `${studioSourceId(id)}.mp4`;
    make(id, join(dir, file));
    return { index, asset_id: id, source_id: studioSourceId(id), file, source_kind: "proxy", watermarked: false, bytes: 1 };
  });
  writeFileSync(join(dir, "proxies.json"), JSON.stringify({ schema_version: "studio.cut-proxies/v1", proxies }));
  return dir;
}

function deps() {
  const { db, bucket } = world();
  return { db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media };
}

describe("transcriptFromManifest", () => {
  it("gives every source a transcript, empty for the ones that were not sent", () => {
    const t = transcriptFromManifest(
      { schema: "ag.studio.transcribe/v1", production_id: "p", engine: { name: "whisperx:large-v3", version: null },
        sources: [{ source_id: studioSourceId("a"), language: "vi", alignment: "word", segments: [{ start: 0.5, end: 1.5, text: "Xin chào", words: [{ word: "Xin", start: 0.5, end: 0.8 }] }] }] },
      [studioSourceId("a"), studioSourceId("b")],
    );
    expect(t).toMatchObject({ schema_version: "harness.transcript/v1", engine: "whisperx:large-v3" });
    expect(t.sources.map((s) => [s.source_id, s.segments.length])).toEqual([[studioSourceId("a"), 1], [studioSourceId("b"), 0]]);
  });
});

describe("studio-cut-transcribe without speech", () => {
  it("answers skip, with an empty transcription, when no source may speak", async () => {
    const d = deps();
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(["a"], [false]) },
      { type: "shots", name: "shots.json", json: { schema_version: "harness.shots/v2", sources: [{ source_id: studioSourceId("a"), index: 0, file_name: "a.mp4", duration_seconds: 9, has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 9 }] }] } },
    ] });
    const build = await cutPayloadBuilders(d)["studio-cut-transcribe"]!(run.request, run.ctx);
    expect(build.skip).toBeDefined();
    const manifest = TranscribeManifestSchema.parse(JSON.parse(String(build.skip!.files["transcribe.json"])));
    expect(manifest.sources).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg())("shot-cut media stages (needs ffmpeg + ffprobe)", () => {
  const ids = ["a", "b"];
  let dir = "";
  beforeAll(() => {
    dir = proxySet(ids, (id, path) => id === "a"
      ? makeSceneClip(path, { seconds: 9, colors: ["black", "white", "gray"], cuts: [3, 6] })
      : makeSceneClip(path, { seconds: 4, colors: ["white"], audio: null }));
  });

  it("studio-media-index finds each proxy's shots, numbered by source", async () => {
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(ids) },
      { type: "proxy_set", name: "proxies", dir },
    ] });
    await runStage(cutStages(deps())["studio-media-index"], run);
    const shots = ShotsIndexSchema.parse(run.json("shots.json"));
    expect(shots.sources.map((s) => [s.source_id, s.index, s.has_audio, s.shots.map((x) => x.shot_id)])).toEqual([
      [studioSourceId("a"), 0, true, ["s000-000", "s000-001", "s000-002"]],
      [studioSourceId("b"), 1, false, ["s001-000"]],
    ]);
    expect(shots.sources[0]!.shots[1]!.in).toBeCloseTo(3, 0);
    expect(shots.sources[0]!.duration_seconds).toBeCloseTo(9, 0);
  });

  it("studio-cut-transcribe sends the sound of the sources that have some", async () => {
    const d = deps();
    const index = stageWorkspace({ runId: "r", inputs: [{ type: "cut_sources", name: "sources.json", json: sources(ids) }, { type: "proxy_set", name: "proxies", dir }] });
    await runStage(cutStages(d)["studio-media-index"], index);
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(ids) },
      { type: "proxy_set", name: "proxies", dir },
      { type: "shots", name: "shots.json", json: index.json("shots.json") },
    ] });
    const build = await cutPayloadBuilders(d)["studio-cut-transcribe"]!(run.request, run.ctx);
    expect(build.skip).toBeUndefined();
    const payload = StudioTranscribePayloadSchema.parse(build.payload);
    expect(payload).toMatchObject({ production_id: "prod-1", model: "large-v3", align_words: true });
    expect(payload.sources).toEqual([{ source_id: studioSourceId("a"), audio: `stage:audio/${studioSourceId("a")}.wav`, language: null }]);
    expect(build.extraUploads?.map((u) => u.relPath)).toEqual([`audio/${studioSourceId("a")}.wav`]);
  });
});
