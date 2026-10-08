/**
 * What a person does from the chat: one message makes a video, Bắt đầu starts it once the intake is complete,
 * Duyệt submits the version on show (never an older one), Sửa tay adds a version, Áp dụng saves timeline edits.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IntakeDraft, TrendReport } from "@harness/contracts";
import {
  applyChatProposal, approveChatScope, chatThread, completeTurn, createDraftProduction, createStudioWorker, getProduction, latestEpisodeRevision,
  listEpisodes, listHumanEdits, messageMentions, productionSources, readStageDocument, saveEpisodeRevision, saveManualEdit,
  sendChatMessage, startFromIntake, startPlanRun, StudioRunError, type TimelineProposal,
} from "../src/index.js";
import { approvePlanGatesUntil, FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

function setup() {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 }, owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker };
}
type Setup = ReturnType<typeof setup>;
async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}
const now = () => new Date().toISOString();
const code = async (f: () => unknown) => { try { await f(); } catch (e) { return e instanceof StudioRunError ? (e.details as { code?: string }).code ?? e.code : String(e); } return null; };
const draft = (over: Partial<IntakeDraft> = {}): IntakeDraft => ({
  schema_version: "studio.intake-draft/v1", title: "Series Kyoto", folder_ids: ["f-kyoto"], channels: [{ url: "@meitime", role: "reference" }],
  keywords: [], aspect: "16:9", language: "vi",
  hints: { description: "", goal: "", audience: "", tone: "", notes: "không lời dẫn", episode_target_seconds: 900, max_episodes: null }, questions: [], ...over,
});

describe("chat actions", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("reads @folder mentions out of a message", () => {
    expect(messageMentions("từ @[Kyoto 2025](folder:f1) và @[Kyushu](folder:f2), @[Kyoto 2025](folder:f1)")).toEqual([
      { kind: "folder", id: "f1", name: "Kyoto 2025" }, { kind: "folder", id: "f2", name: "Kyushu" },
    ]);
  });

  it("one message makes a draft video; Bắt đầu waits for a complete intake, then writes it and starts the series", async () => {
    s = setup();
    seedProduction(s.db); // the team
    const id = createDraftProduction(s.db, "team-1", "auth0|owner", now());
    const sent = sendChatMessage(s.core, s.db, { productionId: id, text: "Làm series từ @[Kyoto 2025](folder:f-kyoto)", userId: "auth0|owner", context: { folders: [] } });
    expect(sent.key.scope).toBe("intake");
    expect(sent.user.mentions).toEqual([{ kind: "folder", id: "f-kyoto", name: "Kyoto 2025" }]);
    expect(await code(() => startFromIntake(s.core, s.db, id))).toBe("intake_incomplete");

    completeTurn(s.db, sent.assistant!.id, { text: "Ngang hay dọc?", action: "revise", proposal: draft({ aspect: null }), problems: [], llmCallId: null }, now());
    try { startFromIntake(s.core, s.db, id); } catch (e) { expect((e as StudioRunError).details).toMatchObject({ missing: ["aspect"] }); }
    const second = sendChatMessage(s.core, s.db, { productionId: id, text: "Ngang", userId: "auth0|owner" });
    completeTurn(s.db, second.assistant!.id, { text: "Đủ rồi", action: "suggest_approve", proposal: draft(), problems: [], llmCallId: null }, now());

    const { runId } = startFromIntake(s.core, s.db, id);
    const p = getProduction(s.db, id)!;
    expect(p).toMatchObject({ run_id: runId, title: "Series Kyoto", aspect: "16:9", youtube_channels: JSON.stringify(["@meitime"]), notes: "không lời dẫn", episode_target_seconds: 900 });
    expect(productionSources(s.db, id)).toEqual(["f-kyoto"]);
    expect(chatThread(s.core, s.db, id).turns.at(-1)?.role).toBe("system");
    expect(chatThread(s.core, s.db, id).blocked?.code).toBe("busy");
  });
});

describe("chat actions at gates", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  async function atTrend(): Promise<{ id: string; runId: string }> {
    s = setup();
    const id = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
    s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở"]), id]);
    const { runId } = startPlanRun(s.core, s.db, id);
    await drain(s);
    return { id, runId };
  }

  it("Duyệt submits the version on show and keeps Claude's draft next to it; an older screen is refused", async () => {
    const { id, runId } = await atTrend();
    const proposed = readStageDocument(s.core, runId, "trend-report", "trend-report.json") as TrendReport;
    const msg = sendChatMessage(s.core, s.db, { productionId: id, text: "Ngắn hơn", userId: "u" });
    const shorter = { ...proposed, summary: "Ngắn." };
    completeTurn(s.db, msg.assistant!.id, { text: "Đã rút gọn", action: "revise", proposal: shorter, problems: [], llmCallId: null }, now());
    expect(chatThread(s.core, s.db, id).current).toMatchObject({ turnId: msg.assistant!.id, document: shorter, draft: proposed });

    expect(await code(() => approveChatScope(s.core, s.db, { productionId: id, stageKey: "approve-trend-report", turnId: null, userId: "u" }))).toBe("stale_version");
    expect(await code(() => approveChatScope(s.core, s.db, { productionId: id, stageKey: "approve-rnd", turnId: msg.assistant!.id, userId: "u" }))).toBe("stale_step");
    await approveChatScope(s.core, s.db, { productionId: id, stageKey: "approve-trend-report", turnId: msg.assistant!.id, userId: "u" });
    expect(readStageDocument(s.core, runId, "approve-trend-report", "trend-report.json")).toEqual(shorter);
    const [edit] = listHumanEdits(s.db, { productionId: id, page: 1, pageSize: 10 }).items;
    expect(edit).toMatchObject({ kind: "trend_report", changed: 1, user_id: "u" });
    await approvePlanGatesUntil(s, id, () => drain(s), "approve-rnd");
  }, 60_000);

  it("Sửa tay adds a version (checked against the stage's schema) without asking Claude", async () => {
    const { id, runId } = await atTrend();
    const proposed = readStageDocument(s.core, runId, "trend-report", "trend-report.json") as TrendReport;
    expect(await code(() => saveManualEdit(s.core, s.db, { productionId: id, stageKey: "approve-trend-report", document: { nope: 1 }, userId: "u" }))).toBe("rejected");
    const turn = saveManualEdit(s.core, s.db, { productionId: id, stageKey: "approve-trend-report", document: { ...proposed, summary: "Tay." }, userId: "u" });
    expect(chatThread(s.core, s.db, id)).toMatchObject({ current: { turnId: turn.id, document: { summary: "Tay." } } });
    expect(chatThread(s.core, s.db, id).turns.filter((t) => t.role === "assistant")).toEqual([]);
  }, 60_000);

  it("Áp dụng saves timeline edits as a revision, refused when the timeline changed since", async () => {
    const { id, runId } = await atTrend();
    await approvePlanGatesUntil(s, id, () => drain(s), null);
    await drain(s);
    const ep = listEpisodes(s.db, id)[0]!;
    const base = latestEpisodeRevision(s.db, ep.id)!;
    const msg = sendChatMessage(s.core, s.db, { productionId: id, episodeId: ep.id, text: "thêm chữ", userId: "u" });
    const timeline = { ...base.data, texts: [{ text_id: "T001", kind: "lower_third" as const, text: "Phở", start: 1, duration: 3, position: "bottom_left" as const }] };
    const prop: TimelineProposal = { ops: [{ op: "addText", kind: "lower_third", text: "Phở", start: 1, duration: 3, position: "bottom_left" }], base_revision: base.revision, timeline };
    completeTurn(s.db, msg.assistant!.id, { text: "Đã thêm", action: "revise", proposal: prop, problems: [], llmCallId: null }, now());
    expect(chatThread(s.core, s.db, id, { episodeId: ep.id }).current?.pendingApply).toBe(true);
    expect(await code(() => approveChatScope(s.core, s.db, { productionId: id, episodeId: ep.id, stageKey: "approve-timeline", turnId: msg.assistant!.id, userId: "u" }))).toBe("not_applied");

    const { revision } = applyChatProposal(s.core, s.db, { productionId: id, turnId: msg.assistant!.id, userId: "u" });
    expect(revision).toBe(base.revision + 1);
    expect(latestEpisodeRevision(s.db, ep.id)?.data.texts.map((t) => t.text)).toEqual(["Phở"]);
    expect(await code(() => applyChatProposal(s.core, s.db, { productionId: id, turnId: msg.assistant!.id, userId: "u" }))).toBe("already_applied");

    // edits proposed on a revision someone else replaced since
    const again = sendChatMessage(s.core, s.db, { productionId: id, episodeId: ep.id, text: "thêm nữa", userId: "u" });
    completeTurn(s.db, again.assistant!.id, { text: "Đã thêm", action: "revise", proposal: { ...prop, base_revision: revision! }, problems: [], llmCallId: null }, now());
    saveEpisodeRevision(s.db, ep.id, { baseRevision: revision!, data: base.data, authorId: "editor" });
    await expect(async () => applyChatProposal(s.core, s.db, { productionId: id, turnId: again.assistant!.id, userId: "u" })).rejects.toThrow(/revision/i);

    const approved = await approveChatScope(s.core, s.db, { productionId: id, episodeId: ep.id, stageKey: "approve-timeline", userId: "u" });
    expect(approved.revision).toBe(revision! + 1);
  }, 90_000);
});
