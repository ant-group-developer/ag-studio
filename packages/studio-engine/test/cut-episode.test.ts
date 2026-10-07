/**
 * A shot-cut episode as the API shows and steers it (plan phase 5, G): the scene selection with each shot's frame,
 * and running the episode again from its scene selection or edit plan gate. Needs ffmpeg + ffprobe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioSurveySchema } from "@harness/contracts";
import { episodeShots, getEpisode, readStageDocument, rerunEpisodeFrom, StudioRunError, submitStudioGate } from "../src/index.js";
import { cutEpisodeAtSurvey, cutSetup, drain, hasFfmpeg, waiting, type CutSetup } from "./cut-flow.js";

const refusal = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof StudioRunError ? { code: e.code, detail: (e.details as { code?: string } | undefined)?.code } : e; }
  return null;
};

describe.skipIf(!hasFfmpeg())("a shot-cut episode through the API (needs ffmpeg + ffprobe)", () => {
  let s: CutSetup;
  beforeEach(() => { process.env.FAKE_STUDIO_MODE = "plan-cut"; });
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; s?.core.close(); });

  it("shows the scene selection with each shot's frame, waiting then as approved", async () => {
    s = cutSetup();
    const { ep, runId } = await cutEpisodeAtSurvey(s);
    const waitingView = episodeShots(s.core, s.db, ep.id);
    expect(waitingView).toMatchObject({ state: "waiting", turnId: null });
    expect(waitingView.shots).toHaveLength(4);
    for (const x of waitingView.shots) {
      expect(x.frame_key).toBe(`productions/${ep.production_id}/episodes/${ep.id}/shots/${x.shot_id}.jpg`);
      expect(s.bucket.objects.has(x.frame_key!)).toBe(true);
      expect(x.changed).toBe(false);
    }

    const draft = StudioSurveySchema.parse(readStageDocument(s.core, runId, "source-survey", "survey.json"));
    const kept = { ...draft, shots: draft.shots.map((x, i) => (i === 0 ? { ...x, usable: true, note: "giữ lại" } : x)) };
    await submitStudioGate(s.core, s.db, runId, "approve-survey", kept);
    const approved = episodeShots(s.core, s.db, ep.id);
    expect(approved.state).toBe("approved");
    expect(approved.shots.map((x) => x.changed)).toEqual([true, false, false, false]);
    expect(approved.shots[0]).toMatchObject({ usable: true, note: "giữ lại" });
  }, 120_000);

  it("runs the episode again from its scene selection, reusing the footage work, once nothing is working", async () => {
    s = cutSetup();
    const { ep, runId } = await cutEpisodeAtSurvey(s);
    // not passed yet
    expect(refusal(() => rerunEpisodeFrom(s.core, s.db, ep.id, "approve-edit-plan"))).toEqual({ code: "conflict", detail: "gate_not_passed" });
    expect(refusal(() => rerunEpisodeFrom(s.core, s.db, ep.id, "plan-edit" as never))).toEqual({ code: "invalid", detail: "bad_stage" });

    await submitStudioGate(s.core, s.db, runId, "approve-survey", readStageDocument(s.core, runId, "source-survey", "survey.json"));
    // the edit plan is queued: the run is working
    expect(refusal(() => rerunEpisodeFrom(s.core, s.db, ep.id, "approve-survey"))).toEqual({ code: "conflict", detail: "episode_running" });
    await drain(s);
    expect(waiting(s, runId)).toEqual(["approve-edit-plan"]);

    // parked at the edit plan: that run is cancelled, a new one waits at the scene selection again
    const out = rerunEpisodeFrom(s.core, s.db, ep.id, "approve-survey");
    expect(s.core.store.getRun(runId)!.state).toBe("CANCELLED");
    expect(getEpisode(s.db, ep.id)!.run_id).toBe(out.runId);
    expect(out.reused).toEqual(expect.arrayContaining(["episode-intake", "fetch-proxies", "media-index", "watch-source", "source-survey"]));
    expect(out.reused).not.toContain("approve-survey");
    await drain(s);
    expect(waiting(s, out.runId)).toEqual(["approve-survey"]);
    expect(episodeShots(s.core, s.db, ep.id).state).toBe("waiting");
  }, 120_000);
});
