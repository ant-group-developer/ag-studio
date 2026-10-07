/**
 * Phase 3: the machine type a person picks for an episode's final render reaches ag-farm as the job's requirements.
 */
import { afterEach, describe, expect, it } from "vitest";
import { YoutubeKitSchema } from "@harness/contracts";
import {
  approveChatScope, chatThread, episodeRenderInfo, latestEpisodeRevision, rerenderEpisode, saveEpisodeRevision, episodeRunView, episodeState, readStageDocument, renderChoiceFor, setRenderChoice, StudioRunError, submitEpisodeTimelineGate, submitStudioGate,
} from "../src/index.js";
import { drain, oneEpisode, setup, type Setup } from "./episode-flow.js";

const NOW = "2026-10-06T10:00:00.000Z";

function claudeCalls(s: Setup): number {
  return s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")!.n;
}

/** Episode rendered once, approved in the chat with `machine`. */
async function rendered(s: Setup, machine: "any" | "nvenc" | "gpu") {
  const ep = await oneEpisode(s);
  await submitEpisodeTimelineGate(s.core, s.db, ep.id);
  await drain(s);
  await approveChatScope(s.core, s.db, { productionId: ep.production_id, episodeId: ep.id, stageKey: "approve-youtube-kit", turnId: null, userId: "auth0|owner", renderMachine: machine });
  await drain(s);
  expect(episodeState(s.core, s.db, ep).status).toBe("ready");
  return ep;
}

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

  it("approving the kit in the chat with a machine type renders on that type, and the chat says which", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);
    const runId = episodeRunView(s.core, s.db, ep.id).run_id;
    await approveChatScope(s.core, s.db, { productionId: ep.production_id, episodeId: ep.id, stageKey: "approve-youtube-kit", turnId: null, userId: "auth0|owner", renderMachine: "nvenc" });
    expect(renderChoiceFor(s.db, runId, "render-final")).toBe("nvenc");
    await drain(s);
    expect(finalJobs(s).map((j) => j.requirements)).toEqual([{ nvenc: true }]);
    const said = chatThread(s.core, s.db, ep.production_id, { episodeId: ep.id }).turns.map((t) => t.text);
    expect(said).toContain("Đã duyệt. Render bản cuối trên máy có NVENC.");
  }, 60_000);

  it("a machine type on any other gate is refused, and nothing is approved", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    const err = await approveChatScope(s.core, s.db, { productionId: ep.production_id, episodeId: ep.id, stageKey: "approve-timeline", turnId: null, userId: "u", renderMachine: "gpu" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRunError);
    expect((err as StudioRunError).code).toBe("invalid");
    expect(episodeRunView(s.core, s.db, ep.id).waiting_gate).toBe("approve-timeline");
    expect(s.db.all("SELECT * FROM studio_render_choices")).toEqual([]);
  }, 60_000);

  it("Render lại with another machine type: the timeline did not change, so only the render runs again — no Claude, no approval", async () => {
    s = setup();
    const ep = await rendered(s, "nvenc");
    const calls = claudeCalls(s);
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ machine: "nvenc", defaultMachine: "nvenc", restartFrom: "render-final", job: { machine: "nvenc" } });

    const again = rerenderEpisode(s.core, s.db, ep.id, { machine: "any", by: "auth0|owner" });
    expect(again.from).toBe("render-final");
    expect(again.reused).toEqual(expect.arrayContaining(["approve-timeline", "youtube-kit", "approve-youtube-kit", "freeze-timeline"]));
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ machine: "any", restartFrom: null });
    await drain(s);
    expect(episodeState(s.core, s.db, ep).status).toBe("ready");
    expect(claudeCalls(s)).toBe(calls);
    expect(finalJobs(s).map((j) => j.requirements)).toEqual([{ nvenc: true }, {}]);
    expect(s.db.all("SELECT requirements FROM studio_farm_jobs WHERE stage_key = 'render-final' ORDER BY created_at"))
      .toEqual([{ requirements: '{"nvenc":true}' }, { requirements: "{}" }]);
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ machine: "any", restartFrom: "render-final", job: { machine: "any" } });
  }, 90_000);

  it("Render lại after the timeline was edited: from approve-timeline as before, the type waiting on the new run", async () => {
    s = setup();
    const ep = await rendered(s, "gpu");
    const latest = latestEpisodeRevision(s.db, ep.id)!;
    saveEpisodeRevision(s.db, ep.id, { baseRevision: latest.revision, data: { ...latest.data, texts: [{ text_id: "T901", kind: "lower_third" as const, text: "Phở sáng", start: 1, duration: 3, position: "bottom_left" as const }] }, authorId: "editor-1" });
    expect(episodeRenderInfo(s.core, s.db, ep.id).restartFrom).toBe("approve-timeline");
    const again = rerenderEpisode(s.core, s.db, ep.id, { machine: "nvenc", by: "auth0|owner" });
    expect(again.from).toBe("approve-timeline");
    await drain(s);
    expect(episodeRunView(s.core, s.db, ep.id).waiting_gate).toBe("approve-timeline");
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ machine: "nvenc", defaultMachine: "nvenc" });
  }, 90_000);

  it("Render lại without a type keeps the old behaviour of the button: no choice is written", async () => {
    s = setup();
    const ep = await rendered(s, "gpu");
    const again = rerenderEpisode(s.core, s.db, ep.id);
    expect(again.from).toBe("render-final");
    await drain(s);
    expect(finalJobs(s).map((j) => j.requirements)).toEqual([{ gpu: true }, {}]);
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ machine: null, defaultMachine: "gpu" });
  }, 90_000);

  it("while the episode is producing there is nothing to render again", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    expect(episodeRenderInfo(s.core, s.db, ep.id)).toMatchObject({ restartFrom: null, machine: null, defaultMachine: "any", job: null });
    expect(() => rerenderEpisode(s.core, s.db, ep.id, { machine: "gpu", by: "u" })).toThrow(StudioRunError);
    expect(s.db.all("SELECT * FROM studio_render_choices")).toEqual([]);
  }, 60_000);
});
