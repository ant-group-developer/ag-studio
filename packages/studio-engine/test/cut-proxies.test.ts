import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { studioSourceId } from "@harness/core";
import { CutProxySetSchema } from "@harness/contracts";
import { cutStages, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const OWNER = "auth0|owner";

function sources(assetIds: string[]) {
  return {
    schema_version: "studio.cut-sources/v1", production_id: "p", episode_id: "e", language: "vi", narration: "tts",
    sources: assetIds.map((id, index) => ({ index, asset_id: id, source_id: studioSourceId(id), title: id, duration_s: 30, has_speech: null, hints: null })),
  };
}

function brief() {
  return { owner_user_id: OWNER };
}

function media(over: Partial<CutMediaDeps> = {}): CutMediaDeps & { resolved: { actAs: string; ids: string[]; purpose: string }[]; downloaded: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ag-go-"));
  const resolved: { actAs: string; ids: string[]; purpose: string }[] = [];
  const downloaded: string[] = [];
  return {
    ffmpeg: "ffmpeg", ffprobe: "ffprobe", voiceDir: join(tmpdir(), "voice"),
    async resolveAssets(actAs, ids, purpose) {
      resolved.push({ actAs, ids, purpose });
      return {
        items: ids.map((id) => {
          const f = join(dir, `${id}.mp4`);
          writeFileSync(f, `video ${id}`);
          return { assetId: id, url: f, sourceKind: id === "b" ? "preview" as const : "proxy" as const, watermarked: id === "b" };
        }),
        missing: [],
      };
    },
    async download(url, dest) { downloaded.push(url); writeFileSync(dest, readFileSync(url)); },
    resolved, downloaded,
    ...over,
  } as CutMediaDeps & { resolved: typeof resolved; downloaded: string[] };
}

function stages(m: CutMediaDeps | undefined) {
  const { db, bucket } = world();
  return cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), ...(m ? { media: m } : {}) });
}

describe("studio-cut-proxies", () => {
  it("fetches every video's 720p proxy as the production owner and lists what it got", async () => {
    const m = media();
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(["a", "b"]) },
      { type: "studio_brief", name: "brief.json", json: brief() },
    ] });
    await runStage(stages(m)["studio-cut-proxies"], run);
    expect(m.resolved).toEqual([{ actAs: OWNER, ids: ["a", "b"], purpose: "preview" }]);
    const set = CutProxySetSchema.parse(run.json("proxies/proxies.json"));
    expect(set.proxies.map((p) => [p.asset_id, p.file, p.source_kind, p.watermarked])).toEqual([
      ["a", `${studioSourceId("a")}.mp4`, "proxy", false],
      ["b", `${studioSourceId("b")}.mp4`, "preview", true],
    ]);
    expect(readFileSync(run.output(`proxies/${studioSourceId("a")}.mp4`), "utf8")).toBe("video a");
  });

  it("a video ag-go cannot serve stops the run as a contract error, naming it", async () => {
    const m = media({ async resolveAssets() { return { items: [], missing: ["a"] }; } });
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(["a"]) },
      { type: "studio_brief", name: "brief.json", json: brief() },
    ] });
    await expect(runStage(stages(m)["studio-cut-proxies"], run)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("a") });
  });

  it("a failed download is left to the retry (not a contract error)", async () => {
    const m = media({ async download() { throw new Error("403 expired"); } });
    const run = stageWorkspace({ runId: "r", inputs: [
      { type: "cut_sources", name: "sources.json", json: sources(["a"]) },
      { type: "studio_brief", name: "brief.json", json: brief() },
    ] });
    const err = await runStage(stages(m)["studio-cut-proxies"], run).catch((e: unknown) => e);
    expect(String(err)).toContain("403");
    expect((err as { code?: string }).code).toBeUndefined();
  });

  it("a worker without media tools refuses the stage", async () => {
    const run = stageWorkspace({ runId: "r", inputs: [{ type: "cut_sources", name: "sources.json", json: sources(["a"]) }, { type: "studio_brief", name: "brief.json", json: brief() }] });
    await expect(runStage(stages(undefined)["studio-cut-proxies"], run)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
