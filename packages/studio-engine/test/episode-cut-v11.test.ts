/**
 * ag-studio-episode-cut@1.1.0 end to end in process (plan 2026-10-08 phase 4–5), pinned to that release: a cut episode
 * of plan 3.2.0 run on 1.1.0 with the production's style, the branding's text look and music moods, and a track in the
 * team's library. Skipped without ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH may point at any build).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompositionSchema, EditPlanSchema, StudioSurveySchema, TimelineV4Schema, type MusicTrack } from "@harness/contracts";
import {
  cancelEpisode, readStageDocument, saveLibraryMusic, saveProductionDocument, startEpisodeRun, submitEpisodeTimelineGate, submitStudioGate,
} from "../src/index.js";
import { cutEpisodeAtSurvey, cutSetup, drain, hasFfmpeg, waiting, type CutSetup } from "./cut-flow.js";
import { STYLE } from "./helpers.js";

const CUT_V11 = "ag-studio-episode-cut@1.1.0";
const CALM: MusicTrack = {
  schema_version: "harness.music-track/v1", track_id: "m-calm", display_name: "Sáng sớm", file: "library:music/calm.m4a", mood: ["Calm"],
  duration_seconds: 240, loop_ok: true, origin: "own", origin_note: "nhóm", checksum: `sha256:${"a".repeat(64)}`, active: true,
  created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
};

function prompts(s: CutSetup, runId: string, stageKey: string): string {
  const stage = s.core.store.listStageRuns(runId).find((x) => x.stage_key === stageKey)!;
  const attempt = s.core.store.listAttempts(stage.stage_run_id).at(-1)!;
  return readFileSync(join(fileURLToPath(attempt.workspace_uri), "logs", "fake-claude-prompts.log"), "utf8");
}

describe.skipIf(!hasFfmpeg())(`${CUT_V11} end to end (needs ffmpeg + ffprobe)`, () => {
  let s: CutSetup;
  beforeEach(() => { process.env.FAKE_STUDIO_MODE = "plan-cut"; });
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; s?.core.close(); });

  it("the style, the cleaned transcription, the survey in the kit, the text look and the library music reach the render", async () => {
    s = cutSetup();
    // a series of plan 3.2.0 (its style step skipped here: no yt-dlp); the production then has an approved style
    const { prod, ep, runId: first } = await cutEpisodeAtSurvey(s);
    saveProductionDocument(s.db, prod, "style", STYLE, "u");
    saveLibraryMusic(s.db, CALM);
    cancelEpisode(s.core, s.db, ep.id);
    await drain(s);
    const { runId } = startEpisodeRun(s.core, s.db, ep.id, { workflow: CUT_V11 });
    expect(runId).not.toBe(first);
    await drain(s);
    const run = s.core.store.getRun(runId)!;
    expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe(CUT_V11);

    // the intake passed the style on; the transcription was cleaned before the survey read it
    expect(readStageDocument(s.core, runId, "episode-intake", "style.json")).toEqual(STYLE);
    expect(readStageDocument(s.core, runId, "clean-transcript", "clean-report.json")).toMatchObject({ schema_version: "studio.transcript-clean/v1" });
    expect(waiting(s, runId)).toEqual(["approve-survey"]);
    expect(prompts(s, runId, "source-survey")).not.toContain("studio_style");
    const survey = StudioSurveySchema.parse(readStageDocument(s.core, runId, "source-survey", "survey.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-survey", survey);
    await drain(s);

    // the edit plan was written with the style in front of Claude, and follows its shot length
    expect(waiting(s, runId)).toEqual(["approve-edit-plan"]);
    expect(prompts(s, runId, "plan-edit")).toContain("## studio_style (style.json)");
    const plan = EditPlanSchema.parse(readStageDocument(s.core, runId, "plan-edit", "edit-plan.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-edit-plan", plan);
    await drain(s);

    // fit v2: the branding's text look frozen, the library track of the first mood (the plan's "calm")
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
    const timeline = TimelineV4Schema.parse(readStageDocument(s.core, runId, "fit-timeline", "timeline.json"));
    expect(timeline.text_style).toEqual({ text_color: "#FFFFFF", outline_color: "#000000", box_color: "#1D3557", size: "m" });
    expect(timeline.music).toEqual({ track: "library:music/calm.m4a", gain_db: -18, ducking: true });
    await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    await drain(s);

    // the kit read what the cut's shots show
    expect(waiting(s, runId)).toEqual(["approve-youtube-kit"]);
    expect(prompts(s, runId, "youtube-kit")).toContain("## survey_index (survey.json)");
    await submitStudioGate(s.core, s.db, runId, "approve-youtube-kit", readStageDocument(s.core, runId, "youtube-kit", "youtube-kit.json"));
    await drain(s);

    // render v5: the composition carries the text look
    expect(s.core.store.getRun(runId)!.state).toBe("SUCCEEDED");
    const key = [...s.bucket.objects.keys()].filter((k) => k.includes("/jobs/render-final/") && k.endsWith("/in/composition.json")).at(-1)!;
    const composition = CompositionSchema.parse(JSON.parse(s.bucket.objects.get(key)!.toString("utf8")));
    expect(composition.text_style).toEqual(timeline.text_style);
    expect(composition.music?.path).toBe("library:music/calm.m4a");
  }, 240_000);
});
