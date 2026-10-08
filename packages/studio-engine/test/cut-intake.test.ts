import { describe, expect, it } from "vitest";
import { CutSourcesSchema, StudioEpisodeSchema, type StudioEpisode } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import { cutStages, replaceEpisodes, updateEpisodeRunId } from "../src/index.js";
import { fakeFootage, seedProduction, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const hint = (has_speech: boolean | null) => ({
  subjects: ["đền"], places: ["Hoa Lư"], mood: "calm", setting: "exterior", time_of_day: "evening", people_count: "few",
  shot_variety: ["wide"], has_speech,
});

function episode(prod: string, over: Partial<StudioEpisode> = {}): StudioEpisode {
  return StudioEpisodeSchema.parse({
    schema_version: "studio.episode/v1", production_id: prod, episode_id: "ep-cut", idx: 1,
    title: "Phố cổ Hoa Lư", hook: "Chiều buông", logline: "Đi bộ qua phố cổ", target_seconds: 240,
    items: [
      { asset_id: "asset-b", reason: "mở đầu", section_title: null },
      { asset_id: "asset-a", reason: "đền", section_title: "Đền vua Đinh" },
    ],
    alternates: [], texts_suggested: [],
    assets: {
      "asset-a": { title: "Đền vua Đinh", summary_vi: "Cổng đền", duration_s: 182.5, orientation: "landscape" },
      "asset-b": { title: "Phố cổ", summary_vi: "Phố đèn lồng", duration_s: 305, orientation: "landscape" },
    },
    edit_style: "cut",
    ...over,
  });
}

function setup(ep: StudioEpisode) {
  const { db, bucket } = world();
  const prod = seedProduction(db);
  const e = { ...ep, production_id: prod };
  replaceEpisodes(db, prod, [{ id: "ep-cut", idx: 1, title: e.title, hook: e.hook, plan: JSON.stringify(e) }], "plan-run");
  updateEpisodeRunId(db, "ep-cut", "run-cut");
  const stages = cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }) });
  return { db, prod, stages };
}

describe("studio-cut-intake", () => {
  it("writes the usual intake plus the videos the episode is cut from, in plan order", async () => {
    const ep = episode("p", { narration: "tts", asset_hints: { "asset-a": hint(true) } });
    const { prod, stages } = setup(ep);
    const run = stageWorkspace({ runId: "run-cut", stageKey: "episode-intake" });
    await runStage(stages["studio-cut-intake"], run);

    expect(run.has("brief.json") && run.has("episode.json") && run.has("trend-report.json")).toBe(true);
    const sources = CutSourcesSchema.parse(run.json("sources.json"));
    expect(sources).toMatchObject({ production_id: prod, episode_id: "ep-cut", language: "vi", narration: "tts" });
    expect(sources.sources.map((s) => [s.index, s.asset_id, s.duration_s, s.has_speech])).toEqual([
      [0, "asset-b", 305, null],
      [1, "asset-a", 182.5, true],
    ]);
    expect(sources.sources[0]!.source_id).toBe(studioSourceId("asset-b"));
    expect(sources.sources[1]!.hints?.places).toEqual(["Hoa Lư"]);
    expect(sources.sources[0]!.hints).toBeNull();
  });

  it("a plan that says nothing about narration reads it as tts", async () => {
    const { stages } = setup(episode("p"));
    const run = stageWorkspace({ runId: "run-cut" });
    await runStage(stages["studio-cut-intake"], run);
    expect(CutSourcesSchema.parse(run.json("sources.json")).narration).toBe("tts");
  });

  it("an item with no catalog entry stops the run as a contract error", async () => {
    const ep = episode("p");
    const { stages } = setup({ ...ep, assets: { "asset-a": ep.assets["asset-a"]! } });
    await expect(runStage(stages["studio-cut-intake"], stageWorkspace({ runId: "run-cut" }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
