/**
 * Chat at the two gates of a shot-cut episode (plan phase 5, F1/F2). The scene selection: Claude proposes edits to
 * shots, resuming (forked) the session the stage looked at the contact sheets in, or a plain structured reply when
 * that session is gone; approving sends the edited selection on. The edit plan: a new version of the document,
 * checked like the stage's answer. Needs ffmpeg + ffprobe.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditPlanSchema, StudioSurveySchema, TimelineV4Schema } from "@harness/contracts";
import {
  agentSessionFor, applyChatProposal, approveChatScope, chatContext, chatScopeFor, getTurn, insertUserTurn, latestEpisodeRevision, markTurnRunning,
  readStageDocument, runChatTurn, studioLogger, submitStudioGate, type ChatScopeKey, type SurveyProposal, type TimelineProposal,
} from "../src/index.js";
import { cutEpisodeAtSurvey, cutSetup, drain, hasFfmpeg, waiting, type CutSetup } from "./cut-flow.js";

const deps = (s: CutSetup) => ({ core: s.core, db: s.db, bucket: s.bucket, claude: s.claude, logger: studioLogger({ test: "chat-cut" }) });
async function say(s: CutSetup, key: ChatScopeKey, text: string) {
  const { assistant } = insertUserTurn(s.db, key, { text, createdBy: "auth0|owner" }, s.core.clock.now());
  expect(markTurnRunning(s.db, assistant!.id, s.core.clock.now())).toBe(true);
  const outcome = await runChatTurn(deps(s), assistant!.id);
  return { outcome, turn: getTurn(s.db, assistant!.id)! };
}
const turnSession = (s: CutSetup, id: string) => s.db.get<{ session_id: string | null }>("SELECT session_id FROM stage_chat_turns WHERE id = ?", [id])!.session_id;

describe.skipIf(!hasFfmpeg())("chat at the gates of a shot-cut episode (needs ffmpeg + ffprobe)", () => {
  let s: CutSetup;
  beforeEach(() => { process.env.FAKE_STUDIO_MODE = "plan-cut"; });
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; s?.core.close(); });

  it("edits the scene selection shot by shot in the stage's own session, then the edit plan as a document", async () => {
    s = cutSetup();
    const { prod, ep, runId } = await cutEpisodeAtSurvey(s);
    const key = chatScopeFor(s.core, s.db, prod, ep.id);
    expect(key).toMatchObject({ stageKey: "approve-survey", scope: "gate" });
    const session = agentSessionFor(s.db, runId, "source-survey")!;
    expect(chatContext(s.core, s.db, key).resume).toEqual({ sessionId: session.sessionId, cwd: session.cwd });

    // "keep the first shot": Claude resumes the stage's session (it saw the shots) and proposes one edit
    const draft = StudioSurveySchema.parse(readStageDocument(s.core, runId, "source-survey", "survey.json"));
    const first = draft.shots[0]!;
    expect(first.usable).toBe(false);
    const kept = await say(s, key, "Giữ lại shot đầu, rung nhẹ thôi");
    expect(kept.outcome).toEqual({ status: "done" });
    expect(kept.turn).toMatchObject({ status: "done", action: "revise", problems: [] });
    const proposal = kept.turn.proposal as SurveyProposal;
    expect(proposal.ops).toEqual([{ op: "keep", shot_id: first.shot_id, note: "giữ lại · đã xem lại, rung nhẹ" }]);
    expect(proposal.survey.shots[0]).toMatchObject({ shot_id: first.shot_id, usable: true, note: "giữ lại · đã xem lại, rung nhẹ" });
    expect(turnSession(s, kept.turn.id)).toMatch(new RegExp(`^${session.sessionId}-chat-`));
    // the fork is a new session: the stage's own stays the one to resume next time
    expect(agentSessionFor(s.db, runId, "source-survey")!.sessionId).toBe(session.sessionId);

    // a second edit applies on top of the first (the selection on show)
    const second = draft.shots[1]!;
    const dropped = await say(s, key, `Bỏ ${second.shot_id} vì có người nhìn máy`);
    const both = (dropped.turn.proposal as SurveyProposal).survey;
    expect(both.shots.slice(0, 2).map((r) => r.usable)).toEqual([true, false]);
    expect(both.shots[1]!.note).toBe(`Bỏ ${second.shot_id} vì có người nhìn máy`);

    // approving sends the selection on show to the edit plan
    await approveChatScope(s.core, s.db, { productionId: prod, episodeId: ep.id, stageKey: "approve-survey", turnId: dropped.turn.id, userId: "auth0|owner" });
    await drain(s);
    expect(waiting(s, runId)).toEqual(["approve-edit-plan"]);
    const plan = EditPlanSchema.parse(readStageDocument(s.core, runId, "plan-edit", "edit-plan.json"));
    expect(plan.shots.map((x) => x.shot_id)).toContain(first.shot_id);
    expect(plan.shots.map((x) => x.shot_id)).not.toContain(second.shot_id);

    // the edit plan: a whole new version, checked by the stage's validator, no session to resume
    const planKey = chatScopeFor(s.core, s.db, prod, ep.id);
    expect(planKey).toMatchObject({ stageKey: "approve-edit-plan", scope: "gate" });
    expect(chatContext(s.core, s.db, planKey).resume).toBeUndefined();
    const revised = await say(s, planKey, "Đổi tiêu đề cho gọn");
    expect(revised.turn).toMatchObject({ status: "done", action: "revise", problems: [] });
    const newPlan = EditPlanSchema.parse(revised.turn.proposal);
    expect(newPlan.texts[0]!.text).toBe(`${plan.texts[0]!.text.slice(0, 40)} (đã sửa)`);
    await approveChatScope(s.core, s.db, { productionId: prod, episodeId: ep.id, stageKey: "approve-edit-plan", turnId: revised.turn.id, userId: "auth0|owner" });
    await drain(s);
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
  }, 120_000);

  it("edits the cut timeline: a clip shortened, a dissolve out of it, karaoke captions, saved as a v4 revision", async () => {
    s = cutSetup();
    const { prod, ep, runId } = await cutEpisodeAtSurvey(s);
    for (const [gate, stage, file] of [["approve-survey", "source-survey", "survey.json"], ["approve-edit-plan", "plan-edit", "edit-plan.json"]] as const) {
      await submitStudioGate(s.core, s.db, runId, gate, readStageDocument(s.core, runId, stage, file));
      await drain(s);
    }
    expect(waiting(s, runId)).toEqual(["approve-timeline"]);
    const key = chatScopeFor(s.core, s.db, prod, ep.id);
    const before = TimelineV4Schema.parse(latestEpisodeRevision(s.db, ep.id)!.data);
    const first = before.clips[0]!;

    const { turn } = await say(s, key, "Ngắn lại clip đầu, cho nó mờ dần sang clip sau, phụ đề karaoke");
    expect(turn).toMatchObject({ status: "done", action: "revise", problems: [] });
    const p = turn.proposal as TimelineProposal;
    expect(p.ops.map((o) => o.op)).toEqual(["trimClip", "setTransition", "setCaptions"]);
    const after = TimelineV4Schema.parse(p.timeline);
    expect(after.clips[0]).toMatchObject({ clip_id: first.clip_id, in: first.in, out: first.in + 1.5, transition_out: { kind: "dissolve", seconds: 0.5 } });
    expect(after.captions.mode).toBe("karaoke");
    // the prompt showed Claude each clip's range and the narration
    const prompt = readFileSync(join(s.core.dataRoot, "chat", turn.id, "logs", "fake-claude-prompts.log"), "utf8");
    expect(prompt).toContain("Tập cắt theo shot");
    expect(prompt).toContain(`"shot_id": "${first.shot_id}"`);

    expect(applyChatProposal(s.core, s.db, { productionId: prod, turnId: turn.id, userId: "auth0|owner" })).toEqual({ revision: 2 });
    const saved = latestEpisodeRevision(s.db, ep.id)!;
    expect(TimelineV4Schema.parse(saved.data).clips[0]!.out).toBe(first.in + 1.5);
  }, 120_000);

  it("refuses a proposal naming a shot the selection does not have, and replies plainly when the session is gone", async () => {
    s = cutSetup();
    const { prod, ep, runId } = await cutEpisodeAtSurvey(s);
    const key = chatScopeFor(s.core, s.db, prod, ep.id);

    process.env.FAKE_STUDIO_MODE = "plan-cut,chat-bad-always";
    const bad = await say(s, key, "Giữ lại hết");
    expect(bad.turn).toMatchObject({ status: "done", action: "answer", proposal: null });
    expect(bad.turn.problems).toEqual([expect.objectContaining({ code: "not_found" })]);

    // the stage's workspace was cleaned up: no session to resume, a structured reply from the prompt alone
    process.env.FAKE_STUDIO_MODE = "plan-cut";
    rmSync(agentSessionFor(s.db, runId, "source-survey")!.cwd, { recursive: true, force: true });
    expect(chatContext(s.core, s.db, key).resume).toBeUndefined();
    const plain = await say(s, key, "Giữ lại shot đầu");
    expect(plain.turn).toMatchObject({ status: "done", action: "revise", problems: [] });
    expect((plain.turn.proposal as SurveyProposal).ops[0]).toMatchObject({ op: "keep", note: "giữ lại · rung nhẹ" });
    expect(turnSession(s, plain.turn.id)).toBeNull();
  }, 120_000);
});
