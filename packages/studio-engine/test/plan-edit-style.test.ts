/** Plan 3.1.0: plan-episodes says how each episode is edited; spawn-episodes-v2 runs each on its workflow. */
import { describe, expect, it } from "vitest";
import { SeriesPlanSchema, StudioEpisodeSchema, type StudioCatalog } from "@harness/contracts";
import { episodeWorkflowFor, EPISODE_CUT_WORKFLOW, listEpisodes, replaceEpisodes, startEpisodeRun, studioStages, STUDIO_WORKFLOWS } from "../src/index.js";
import { fakeFootage, seedProduction, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

describe("episodeWorkflowFor", () => {
  it("a shot-cut episode of plan 3.1.0 on runs the shot-cut workflow; everything else as before", () => {
    expect(episodeWorkflowFor("3.1.0", "cut")).toBe(EPISODE_CUT_WORKFLOW);
    expect(episodeWorkflowFor("4.0.0", "cut")).toBe(EPISODE_CUT_WORKFLOW);
    expect(episodeWorkflowFor("3.1.0", "whole")).toBe(STUDIO_WORKFLOWS.episode.workflow);
    expect(episodeWorkflowFor("3.1.0", undefined)).toBe(STUDIO_WORKFLOWS.episode.workflow);
    expect(episodeWorkflowFor("3.0.0", "cut")).toBe(STUDIO_WORKFLOWS.episode.workflow);
    expect(episodeWorkflowFor("2.0.0", "cut")).toBe("ag-studio-episode@1.2.0");
  });
});

const asset = (id: string, over: Partial<StudioCatalog["assets"][number]> = {}): StudioCatalog["assets"][number] => ({
  asset_id: id, name: id, title_vi: `Video ${id}`, summary_vi: `Tóm tắt ${id}`, duration_s: 120, orientation: "landscape", genre: "travel",
  topics: [], subjects: ["đền"], places: ["Hoa Lư"], actions: [], keywords_vi: [], tags: [], mood: "calm", setting: "exterior", time_of_day: "evening",
  people_count: "few", shot_variety: ["wide"], has_speech: false, quality: 4, usable: true, approved: true, project_names: [], ...over,
});

describe("studio-spawn-episodes-v2", () => {
  it("snapshots each episode's edit style, narration and the AI hints, records the style, starts each on its workflow", async () => {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    const started: { episodeId: string; workflow: string }[] = [];
    const stages = studioStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async (episodeId, workflow) => { started.push({ episodeId, workflow }); return { runId: `run-${started.length}` }; } });
    const plan = SeriesPlanSchema.parse({
      schema_version: "studio.series-plan/v1", series_title: "Hoa Lư", rationale: "r",
      episodes: [
        { idx: 1, title: "Phố cổ", hook: "h", logline: "l", target_seconds: 180, items: [{ asset_id: "a", reason: "r", section_title: null }, { asset_id: "b", reason: "r", section_title: null }],
          alternates: [], texts_suggested: [], edit_style: "cut", narration: "tts" },
        { idx: 2, title: "Đền", hook: "h", logline: "l", target_seconds: 120, items: [{ asset_id: "c", reason: "r", section_title: null }],
          alternates: [], texts_suggested: [], edit_style: "whole", narration: "none" },
      ],
    });
    const catalog: StudioCatalog = { schema_version: "studio.catalog/v2", production_id: prod, folder_ids: ["f"], total_available: 3, truncated: false,
      assets: [asset("a", { has_speech: true }), asset("b"), asset("c")] };
    const run = stageWorkspace({ runId: "plan-run", inputs: [
      { type: "studio_brief", name: "brief.json", json: { schema_version: "studio.brief/v2", production_id: prod, run_id: "plan-run", owner_user_id: "auth0|owner", title: "T", description: "Phố cổ Hoa Lư", goal: "g", audience: "a", tone: "t", notes: "",
        folder_ids: ["f"], episode_target_seconds: 120, max_episodes: 2, aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null, youtube_channels: [], keywords: [] } },
      { type: "studio_catalog", name: "catalog.json", json: catalog },
      { type: "series_plan", name: "series-plan.json", json: plan },
    ] });
    (run.request as { workflow: { version: string } }).workflow.version = "3.1.0";
    await runStage(stages["studio-spawn-episodes-v2"], run);

    const eps = listEpisodes(db, prod);
    expect(eps.map((e) => [e.idx, e.edit_style])).toEqual([[1, "cut"], [2, "whole"]]);
    expect(started.map((s) => s.workflow)).toEqual([EPISODE_CUT_WORKFLOW, STUDIO_WORKFLOWS.episode.workflow]);
    const cut = StudioEpisodeSchema.parse(JSON.parse(eps[0]!.plan!));
    expect(cut).toMatchObject({ edit_style: "cut", narration: "tts" });
    expect(cut.asset_hints?.a).toMatchObject({ places: ["Hoa Lư"], has_speech: true });
    const whole = StudioEpisodeSchema.parse(JSON.parse(eps[1]!.plan!));
    expect(whole.edit_style).toBe("whole");
    expect(whole.asset_hints).toBeUndefined();
  });
});

describe("startEpisodeRun follows the episode's edit style", () => {
  it("a shot-cut episode runs ag-studio-episode-cut, a whole-video one 1.3.0", () => {
    const { core, db } = world();
    const prod = seedProduction(db);
    replaceEpisodes(db, prod, [
      { id: "ep-cut", idx: 1, title: "Phố cổ", hook: "h", plan: "{}", edit_style: "cut" },
      { id: "ep-whole", idx: 2, title: "Đền", hook: "h", plan: "{}" },
    ], "plan-run");
    const cut = core.store.getRun(startEpisodeRun(core, db, "ep-cut").runId)!;
    const whole = core.store.getRun(startEpisodeRun(core, db, "ep-whole").runId)!;
    expect(`${cut.workflow_release.id}@${cut.workflow_release.version}`).toBe(STUDIO_WORKFLOWS.episodeCut.workflow);
    expect(`${whole.workflow_release.id}@${whole.workflow_release.version}`).toBe(STUDIO_WORKFLOWS.episode.workflow);
    core.close();
  });
});
