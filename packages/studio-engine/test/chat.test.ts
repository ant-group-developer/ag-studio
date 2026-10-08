/**
 * One chat reply with the fake Claude: a proposal checked like the stage's answer (one repair round), answers,
 * the subscription limit, the intake draft and timeline edits; every call in llm_calls as `claude-chat`.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { intakeMissing, type IntakeDraft } from "@harness/contracts";
import {
  chatScopeFor, createStudioWorker, currentProposal, getTurn, insertUserTurn, listEpisodes, listLlmCalls, markTurnRunning, readLlmCallPayload,
  readStageDocument, runChatTurn, startPlanRun, studioLogger, submitStudioGate, type ChatScopeKey, type TimelineProposal,
} from "../src/index.js";
import { approvePlanGatesUntil, FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

function setup(mode = "") {
  const w = world();
  const claude = { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3, baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode }, rateLimitBackoffMs: [60_000] };
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
    claude: { ...claude, baseEnv: { ...process.env, FAKE_STUDIO_MODE: "" } }, owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  const deps = { core: w.core, db: w.db, bucket: w.bucket, claude, logger: studioLogger({ test: "chat" }) };
  return { ...w, worker, deps };
}
type Setup = ReturnType<typeof setup>;
async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}
function prod(s: Setup): string {
  const id = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
  s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở sáng"]), id]);
  return id;
}
/** Plan 3.0.0 waiting at approve-trend-report. */
async function atTrendGate(s: Setup) {
  const id = prod(s);
  const { runId } = startPlanRun(s.core, s.db, id);
  await drain(s);
  return { id, runId, key: chatScopeFor(s.core, s.db, id) };
}
async function say(s: Setup, key: ChatScopeKey, text: string, context?: unknown) {
  const { assistant } = insertUserTurn(s.db, key, { text, createdBy: "auth0|owner", ...(context ? { context } : {}) }, s.core.clock.now());
  expect(markTurnRunning(s.db, assistant!.id, s.core.clock.now())).toBe(true);
  const outcome = await runChatTurn(s.deps, assistant!.id);
  return { outcome, turn: getTurn(s.db, assistant!.id)! };
}
const chatCalls = (s: Setup, id: string) => listLlmCalls(s.db, { productionId: id, page: 1, pageSize: 50 }).items.filter((c) => c.source === "claude-chat").reverse();

describe("runChatTurn", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("revises the document at a gate, checked by the stage's validator, starting from the stage's prompt head", async () => {
    s = setup();
    const { id, runId, key } = await atTrendGate(s);
    const { outcome, turn } = await say(s, key, "Bỏ từ khoá kyoto food");
    expect(outcome).toEqual({ status: "done" });
    expect(turn).toMatchObject({ status: "done", action: "revise", problems: [] });
    const draft = readStageDocument(s.core, runId, "trend-report", "trend-report.json") as { summary: string };
    expect((turn.proposal as { summary: string }).summary).toBe(`${draft.summary} (đã sửa)`);
    expect(currentProposal(s.db, key)?.id).toBe(turn.id);
    const [call] = chatCalls(s, id);
    expect(call).toMatchObject({ stage_key: "approve-trend-report", attempt_id: turn.id, skill: "studio-trend-report", round: 0, outcome: "accepted" });
    expect(turn.llm_call_id).toBe(call!.id);
    const prompt = (await readLlmCallPayload(s.bucket, call!.payload_key!)).prompt;
    expect(prompt).toMatch(/^# Skill\n# Skill: studio-trend-report/);
    expect(prompt).toContain("# Bản hiện tại\n```json");
    expect(prompt).toContain("# Góp ý\n- Người dùng: Bỏ từ khoá kyoto food\n");

    // the next message sees the whole conversation, and the new version
    const second = await say(s, key, "Ngắn hơn nữa");
    expect((second.turn.proposal as { summary: string }).summary).toBe(`${draft.summary} (đã sửa) (đã sửa)`);
  }, 60_000);

  it("answers a question without a proposal, and only suggests approving when the person agrees", async () => {
    s = setup();
    const { key } = await atTrendGate(s);
    expect((await say(s, key, "Số liệu lấy từ đâu?")).turn).toMatchObject({ action: "answer", proposal: null });
    expect((await say(s, key, "ok")).turn).toMatchObject({ action: "suggest_approve", proposal: null });
  }, 60_000);

  it("a refused proposal gets one repair round", async () => {
    s = setup("chat-bad-once");
    const { id, key } = await atTrendGate(s);
    const { turn } = await say(s, key, "Viết lại phần gợi ý");
    expect(turn).toMatchObject({ action: "revise", problems: [] });
    expect(turn.proposal).not.toBeNull();
    expect(chatCalls(s, id).map((c) => [c.round, c.outcome])).toEqual([[0, "rejected"], [1, "accepted"]]);
  }, 60_000);

  it("refused twice: the reply stays, the proposal is dropped with why", async () => {
    s = setup("chat-bad-always");
    const { id, key } = await atTrendGate(s);
    const { turn } = await say(s, key, "Viết lại phần gợi ý");
    expect(turn).toMatchObject({ status: "done", action: "answer", proposal: null });
    expect(turn.problems.length).toBeGreaterThan(0);
    expect(currentProposal(s.db, key)).toBeUndefined();
    expect(chatCalls(s, id).map((c) => c.outcome)).toEqual(["rejected", "rejected"]);
  }, 60_000);

  it("the subscription limit leaves the reply waiting, then it runs", async () => {
    s = setup("rate-limit-once");
    const { key } = await atTrendGate(s);
    const first = await say(s, key, "Viết lại");
    expect(first.outcome.status).toBe("rate_limited");
    expect(first.turn.status).toBe("rate_limited");
    const at = (first.outcome as { notBefore: string }).notBefore;
    expect(Date.parse(at) - Date.parse(first.turn.updated_at)).toBe(60_000);
    expect(markTurnRunning(s.db, first.turn.id, at)).toBe(true);
    expect(await runChatTurn(s.deps, first.turn.id)).toEqual({ status: "done" });
    expect(getTurn(s.db, first.turn.id)).toMatchObject({ status: "done", action: "revise" });
  }, 60_000);

  it("a message sent before the gate was approved gets no reply", async () => {
    s = setup();
    const { runId, key } = await atTrendGate(s);
    const { assistant } = insertUserTurn(s.db, key, { text: "Viết lại", createdBy: "u" }, s.core.clock.now());
    await submitStudioGate(s.core, s.db, runId, "approve-trend-report", readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    markTurnRunning(s.db, assistant!.id, s.core.clock.now());
    expect(await runChatTurn(s.deps, assistant!.id)).toEqual({ status: "failed" });
    expect(getTurn(s.db, assistant!.id)?.text).toMatch(/đã được duyệt/);
  }, 60_000);

  it("intake: a sentence and an @folder become a draft; Claude asks what is missing, one thing at a time", async () => {
    s = setup();
    const id = prod(s);
    s.db.run("UPDATE productions SET title = 'Video mới', aspect = NULL, keywords = NULL WHERE id = ?", [id]);
    s.db.run("DELETE FROM production_sources WHERE production_id = ?", [id]);
    const key = chatScopeFor(s.core, s.db, id);
    const folders = { folders: [{ id: "f-kyoto", name: "Kyoto 2025", usableVideos: 38 }] };
    const first = await say(s, key, "Làm series vlog từ @[Kyoto 2025](folder:f-kyoto), giống kênh @meitime", folders);
    expect(first.turn.problems).toEqual([]);
    const d1 = first.turn.proposal as IntakeDraft;
    expect(d1).toMatchObject({ title: "Series Kyoto 2025", folder_ids: ["f-kyoto"], channels: [{ url: "@meitime", role: "reference" }], aspect: null });
    expect(first.turn).toMatchObject({ action: "revise", text: "Video ngang hay dọc?" });
    const second = await say(s, key, "Ngang 16:9");
    const d2 = second.turn.proposal as IntakeDraft;
    expect(d2.aspect).toBe("16:9");
    expect(intakeMissing(d2)).toEqual([]);
    expect(second.turn.action).toBe("suggest_approve");
    const [call] = chatCalls(s, id);
    expect(call).toMatchObject({ run_id: "intake", stage_key: "intake", skill: "studio-intake" });
    // a voice sample and music pasted in the chat: offered in the draft, nothing fetched, still ready to start
    const third = await say(s, key, "Giọng đọc: https://drive.google.com/file/d/abc/view , nhạc nền https://cdn.example.com/calm.mp3");
    const d3 = third.turn.proposal as IntakeDraft;
    expect(third.turn.problems).toEqual([]);
    expect(d3.audio_links).toEqual({ voice: "https://drive.google.com/file/d/abc/view", music: "https://cdn.example.com/calm.mp3" });
    expect(intakeMissing(d3)).toEqual([]);
  }, 60_000);

  it("timeline: edits proposed as operations, with the timeline they give", async () => {
    s = setup();
    const id = prod(s);
    const { runId } = startPlanRun(s.core, s.db, id);
    await approvePlanGatesUntil(s, id, () => drain(s), null);
    await drain(s);
    const ep = listEpisodes(s.db, id)[0]!;
    const key = chatScopeFor(s.core, s.db, id, ep.id);
    const { turn } = await say(s, key, "Thêm chữ \"Phở sáng\" ở clip 2");
    expect(turn.problems).toEqual([]);
    const p = turn.proposal as TimelineProposal;
    expect(p.ops).toEqual([expect.objectContaining({ op: "addText", text: "Phở sáng" })]);
    expect(p.base_revision).toBe(1);
    expect(p.timeline.texts.some((t) => t.text === "Phở sáng")).toBe(true);
    const [call] = chatCalls(s, id);
    expect(call).toMatchObject({ episode_id: ep.id, stage_key: "approve-timeline", skill: "studio-timeline" });

    // a whole-video episode (timeline v3) has no clip ranges: trimming is refused, twice, and nothing is proposed
    const trim = await say(s, key, "Ngắn lại clip đầu");
    expect(trim.turn).toMatchObject({ status: "done", action: "answer", proposal: null });
    expect(trim.turn.problems).toEqual([expect.objectContaining({ code: "needs_v4" })]);
  }, 90_000);
});
