/**
 * An episode whose final render failed on the farm: its run ends FAILED. The chat still edits the timeline (scope
 * `timeline`), and the thread says which step stopped and why (`stopped`), so the result pane shows the render.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  approveChatScope, chatScopeFor, chatThread, episodeRunView, submitEpisodeTimelineGate,
} from "../src/index.js";
import { drain, oneEpisode, setup, type Setup } from "./episode-flow.js";

/** Every final render the fake farm takes fails as the render worker does when it cannot download its input. */
function failRenders(s: Setup): void {
  const submit = s.farm.submitJob.bind(s.farm);
  s.farm.submitJob = async (req) => {
    const r = await submit(req);
    if (req.type === "studio.render_final") {
      const j = s.farm.jobs.get(r.job.id)!;
      s.farm.jobs.set(r.job.id, { ...j, status: "failed", result: null, error: { code: "WORKER_ERROR", message: "fetch failed", retryable: true } });
    }
    return r;
  };
}

/** The retry of a failed stage waits its backoff; a test does not. */
function retryNow(s: Setup, runId: string): void {
  const st = s.core.store.listStageRuns(runId).find((x) => x.stage_key === "render-final")!;
  s.core.store.updateStageRun({ ...st, not_before: s.core.clock.now() });
}

describe("an episode whose final render failed", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("chats on the timeline, and the thread says the render stopped and why", async () => {
    s = setup();
    failRenders(s);
    const ep = await oneEpisode(s);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);
    await approveChatScope(s.core, s.db, { productionId: ep.production_id, episodeId: ep.id, stageKey: "approve-youtube-kit", turnId: null, userId: "auth0|owner", renderMachine: "any" });
    await drain(s);
    const runId = episodeRunView(s.core, s.db, ep.id).run_id;
    retryNow(s, runId);
    await drain(s);
    expect(s.core.store.getRun(runId)!.state).toBe("FAILED");

    expect(chatScopeFor(s.core, s.db, ep.production_id, ep.id)).toMatchObject({ scope: "timeline", runId });
    const thread = chatThread(s.core, s.db, ep.production_id, { episodeId: ep.id });
    expect(thread.blocked).toBeNull();
    expect(thread.stopped).toMatchObject({ stage: "render-final" });
    expect(thread.stopped!.problems[0]!.message).toContain("fetch failed");
  }, 90_000);

  it("a render that went through stops nothing", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);
    await approveChatScope(s.core, s.db, { productionId: ep.production_id, episodeId: ep.id, stageKey: "approve-youtube-kit", turnId: null, userId: "auth0|owner", renderMachine: "any" });
    await drain(s);
    const thread = chatThread(s.core, s.db, ep.production_id, { episodeId: ep.id });
    expect(thread.scope).toMatchObject({ scope: "timeline" });
    expect(thread.stopped).toBeNull();
  }, 90_000);
});
