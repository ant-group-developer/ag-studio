/**
 * Phase 3: the machine type a person picks for an episode's final render reaches ag-farm as the job's requirements.
 */
import { afterEach, describe, expect, it } from "vitest";
import { YoutubeKitSchema } from "@harness/contracts";
import { episodeRunView, episodeState, readStageDocument, setRenderChoice, submitEpisodeTimelineGate, submitStudioGate } from "../src/index.js";
import { drain, oneEpisode, setup, type Setup } from "./episode-flow.js";

const NOW = "2026-10-06T10:00:00.000Z";

function finalJobs(s: Setup) {
  return [...s.farm.jobs.values()].filter((j) => j.type === "studio.render_final");
}

describe("render machine of an episode's final render", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("the farm job carries the requirements of the type chosen for the run; the row in studio_farm_jobs says so too", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);
    const runId = episodeRunView(s.core, s.db, ep.id).run_id;
    setRenderChoice(s.db, { runId, stageKey: "render-final", machine: "gpu", by: "auth0|owner", now: NOW });
    await submitStudioGate(s.core, s.db, runId, "approve-youtube-kit", YoutubeKitSchema.parse(readStageDocument(s.core, runId, "youtube-kit", "youtube-kit.json")));
    await drain(s);
    expect(episodeState(s.core, s.db, ep).status).toBe("ready");
    expect(finalJobs(s).map((j) => j.requirements)).toEqual([{ gpu: true }]);
    expect(s.db.all("SELECT episode_id, requirements FROM studio_farm_jobs WHERE stage_key = 'render-final'"))
      .toEqual([{ episode_id: ep.id, requirements: '{"gpu":true}' }]);
  }, 60_000);

  it("no choice: the job goes out with {} as before phase 3", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);
    const runId = episodeRunView(s.core, s.db, ep.id).run_id;
    await submitStudioGate(s.core, s.db, runId, "approve-youtube-kit", YoutubeKitSchema.parse(readStageDocument(s.core, runId, "youtube-kit", "youtube-kit.json")));
    await drain(s);
    expect(finalJobs(s).map((j) => j.requirements)).toEqual([{}]);
  }, 60_000);
});
