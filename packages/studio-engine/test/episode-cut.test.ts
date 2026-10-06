/**
 * A shot-cut episode end to end in process (plan phase 5, E2): plan 3.1.0 with the fake Claude cutting its episode shot by
 * shot, the 720p proxies made by ffmpeg, the fake farm reading the narration and listening to the footage, and every
 * gate passed: scene selection (one shot kept back by the person), edit plan, timeline, YouTube kit. Skipped without
 * ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH may point at any build).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompositionSchema, EditPlanSchema, StudioSurveySchema, TimelineV4Schema } from "@harness/contracts";
import { readStageDocument, STUDIO_WORKFLOWS, submitEpisodeTimelineGate, submitStudioGate } from "../src/index.js";
import { cutEpisodeAtSurvey, cutSetup, drain, hasFfmpeg, waiting, type CutSetup } from "./cut-flow.js";

describe.skipIf(!hasFfmpeg())("ag-studio-episode-cut@1.0.0 end to end (needs ffmpeg + ffprobe)", () => {
  let s: CutSetup;
  beforeEach(() => { process.env.FAKE_STUDIO_MODE = "plan-cut"; });
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; s?.core.close(); });

  it("plans a shot-cut episode, selects and plans its shots with the person, reads the narration, renders it cut", async () => {
    s = cutSetup();
    const { ep, runId } = await cutEpisodeAtSurvey(s);
    expect(ep.edit_style).toBe("cut");
    const run = s.core.store.getRun(runId)!;
    expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe(STUDIO_WORKFLOWS.episodeCut.workflow);

    // 1. scene selection: the fake drops the first shot as shaky; the person keeps it anyway
    expect(waiting(s, runId)).toEqual(["approve-survey"]);
    const survey = StudioSurveySchema.parse(readStageDocument(s.core, runId, "source-survey", "survey.json"));
    expect(survey.shots).toHaveLength(4); // one 20 s video of four colours
    expect(survey.shots[0]!.usable).toBe(false);
    const kept = { ...survey, shots: survey.shots.map((x, i) => (i === 0 ? { ...x, usable: true, note: "giữ lại · rung nhẹ" } : x)) };
    await submitStudioGate(s.core, s.db, runId, "approve-survey", kept);
    await drain(s);

    // 2. edit plan, from the approved selection (the shot kept back is in it)
    expect(waiting(s, runId)).toEqual(["approve-edit-plan"]);
    const plan = EditPlanSchema.parse(readStageDocument(s.core, runId, "plan-edit", "edit-plan.json"));
    expect(plan.shots[0]!.shot_id).toBe(survey.shots[0]!.shot_id);
    expect(plan.lines.length).toBeGreaterThan(0);
    await submitStudioGate(s.core, s.db, runId, "approve-edit-plan", plan);
    await drain(s);

    // 3. the farm read every line; the fitted timeline v4 is the episode's revision
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
    const tts = [...s.farm.jobs.values()].filter((j) => j.type === "studio.tts");
    expect(tts).toHaveLength(1);
    expect((tts[0]!.payload.lines as unknown[]).length).toBe(plan.lines.length);
    // ag-go says these videos have no speech: nothing is sent to listen to, the transcription is empty
    expect([...s.farm.jobs.values()].filter((j) => j.type === "studio.transcribe")).toHaveLength(0);
    const timeline = TimelineV4Schema.parse(readStageDocument(s.core, runId, "fit-timeline", "timeline.json"));
    expect(timeline.edit_style).toBe("cut");
    expect(timeline.clips.some((c) => c.in > 0)).toBe(true);
    expect(timeline.narration.lines.every((l) => l.audio)).toBe(true);
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM studio_voice_lines")!.n).toBe(plan.lines.length);
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);

    // 4. YouTube kit, then the final render of the cut, narration with it
    expect(waiting(s, runId)).toEqual(["approve-youtube-kit"]);
    await submitStudioGate(s.core, s.db, runId, "approve-youtube-kit", readStageDocument(s.core, runId, "youtube-kit", "youtube-kit.json"));
    await drain(s);
    expect(s.core.store.getRun(runId)!.state).toBe("SUCCEEDED");
    const render = [...s.farm.jobs.values()].find((j) => j.type === "studio.render_final")!;
    const attempt = s.core.store.listStageRuns(runId).find((x) => x.stage_key === "render-final")!;
    const prefix = [...s.bucket.objects.keys()].find((k) => k.includes("/jobs/render-final/") && k.endsWith("/in/composition.json"))!.replace(/composition\.json$/, "");
    const composition = CompositionSchema.parse(JSON.parse(s.bucket.objects.get(`${prefix}composition.json`)!.toString("utf8")));
    expect(composition.voice).toBe("tts");
    expect(composition.narration.map((n) => n.wav)).toEqual(timeline.narration.lines.map((l) => `stage:voice/${l.line_id}.wav`));
    for (const n of composition.narration) expect(s.bucket.objects.has(`${prefix}${n.wav.replace("stage:", "")}`)).toBe(true);
    expect(composition.captions.mode).toBe("burn-in");
    expect(composition.output).toMatchObject({ width: 1920, height: 1080 });
    expect(render.payload.composition).toBe("stage:composition.json");
    expect(attempt.state).toBe("SUCCEEDED");

    // a whole-video series still runs 1.3.0 (the plan only cut this one because of plan-cut)
    expect(STUDIO_WORKFLOWS.episode.workflow).toBe("ag-studio-episode@1.3.0");
  });
});
