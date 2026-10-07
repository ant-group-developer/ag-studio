/**
 * A step that is not Claude's and stopped (ADR-0001 item 169): the chat no longer says "still working". A shot-cut
 * episode reaching `tts` without a voice asks for one (`needs_voice`); any other machine step that failed says so,
 * with why (`stage_failed`). Needs ffmpeg + ffprobe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatScopeFor, chatThread, declineNarration, readStageDocument, resumeVoiceWaiting, StudioRunError, submitStudioGate,
} from "../src/index.js";
import { cutEpisodeAtSurvey, cutSetup, drain, hasFfmpeg, VOICE, waiting, type CutSetup } from "./cut-flow.js";

const conflict = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof StudioRunError ? e.details as { code?: string; stage?: string } : e; }
  return null;
};

describe.skipIf(!hasFfmpeg())("a machine step that stopped, in the chat (needs ffmpeg + ffprobe)", () => {
  let s: CutSetup;
  beforeEach(() => { process.env.FAKE_STUDIO_MODE = "plan-cut"; });
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; s?.core.close(); });

  async function toTts(voice: unknown) {
    s = cutSetup();
    const { prod, ep, runId } = await cutEpisodeAtSurvey(s);
    s.db.run("UPDATE productions SET voice = ? WHERE id = ?", [voice === null ? null : JSON.stringify(voice), prod]);
    await submitStudioGate(s.core, s.db, runId, "approve-survey", readStageDocument(s.core, runId, "source-survey", "survey.json"));
    await drain(s);
    await submitStudioGate(s.core, s.db, runId, "approve-edit-plan", readStageDocument(s.core, runId, "plan-edit", "edit-plan.json"));
    await drain(s);
    return { prod, ep, runId };
  }

  it("no voice: the episode asks for one instead of saying it is working", async () => {
    const { prod, ep, runId } = await toTts(null);
    expect(waiting(s, runId)).toEqual(["tts"]);
    expect(conflict(() => chatScopeFor(s.core, s.db, prod, ep.id))).toMatchObject({ code: "needs_voice", stage: "tts" });
    expect(chatThread(s.core, s.db, prod, { episodeId: ep.id }).blocked).toMatchObject({ code: "needs_voice", stage: "tts" });
  }, 120_000);

  it("a machine step failed for another reason: stage_failed, with why", async () => {
    const { prod, ep, runId } = await toTts(null);
    // a voice now exists, but the step has not run again: what stopped it is still the last failure
    s.db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify(VOICE), prod]);
    expect(waiting(s, runId)).toEqual(["tts"]);
    const blocked = chatThread(s.core, s.db, prod, { episodeId: ep.id }).blocked!;
    expect(blocked).toMatchObject({ code: "stage_failed", stage: "tts" });
    expect(blocked.problems?.[0]?.message).toContain("giọng đọc");
  }, 120_000);

  it("given a voice, the episodes waiting at tts run on: read on the farm, then the timeline", async () => {
    const { prod, ep, runId } = await toTts(null);
    s.db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify(VOICE), prod]);
    expect(resumeVoiceWaiting(s.core, s.db, prod)).toEqual([ep.id]);
    expect(resumeVoiceWaiting(s.core, s.db, prod)).toEqual([]);
    await drain(s);
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
    const t = readStageDocument(s.core, runId, "fit-timeline", "timeline.json") as { narration: { voice: string; lines: unknown[] } };
    expect(t.narration.voice).toBe("tts");
    expect(t.narration.lines.length).toBeGreaterThan(0);
  }, 120_000);

  it("narration declined: the episode runs on and is cut without lines", async () => {
    const { prod, runId } = await toTts(null);
    declineNarration(s.db, prod, "auth0|owner");
    resumeVoiceWaiting(s.core, s.db, prod);
    await drain(s);
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
    const t = readStageDocument(s.core, runId, "fit-timeline", "timeline.json") as { narration: { voice: string; lines: unknown[] } };
    expect(t.narration).toMatchObject({ voice: "none", lines: [] });
  }, 120_000);
});
