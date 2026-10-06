/**
 * Phase 2 acceptance (plan 2026-10-06-ag-studio-phase-2-chat, E1), in one process with the fake Claude: the worker
 * pool (stage loops + chat loop) runs in the background while the test acts like a person through the engine's chat
 * actions — the same functions the API's chat routes call (their roles and HTTP answers are covered by
 * apps/api/src/studio/chat.spec.ts):
 *   one message makes a video → Claude asks the frame → answered → Bắt đầu → trend report approved → chat about the
 *   R&D → its new version approved → branding runs on its own → branding and plan approved → an episode → chat about
 *   its timeline → Áp dụng → timeline approved → the YouTube kit waits for approval.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyChatProposal, approveChatScope, chatThread, createDraftProduction, createStudioWorkerPool, episodeRunView, getProduction, latestEpisodeRevision,
  listEpisodes, planRunView, productionRnd, sendChatMessage, startFromIntake, type ChatThreadView, type StudioWorkerPool,
} from "@ag-studio/engine";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, world } from "../../packages/studio-engine/test/helpers.js";

const USER = "auth0|owner";
const FOLDERS = { folders: [{ id: "folder-a", name: "Kyoto 2025", usableVideos: 8 }] };

async function until<T>(what: string, f: () => T | undefined | null | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("chat-first series with the fake Claude", () => {
  const w = world();
  let pool: StudioWorkerPool;
  const ac = new AbortController();
  let running: Promise<void>;
  let prod = "";

  beforeAll(() => {
    const now = new Date().toISOString();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Du lịch', ?, ?)", [now, now]);
    w.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'owner', ?)", [USER, now]);
    pool = createStudioWorkerPool({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(6, 30), farm: fakeFarm(w.bucket) as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "chat-flow", thumbnails: fakeThumbnails(), claudeMaxConcurrent: 4, chatPollMs: 50,
    });
    running = pool.runForever(ac.signal);
  });
  afterAll(async () => {
    ac.abort();
    await running;
    w.core.close();
  });

  const thread = (episodeId?: string): ChatThreadView => chatThread(w.core, w.db, prod, { episodeId: episodeId ?? null });
  /** Sends a message and waits for Claude's reply to it. */
  async function say(text: string, episodeId?: string) {
    const { assistant } = sendChatMessage(w.core, w.db, { productionId: prod, episodeId: episodeId ?? null, text, userId: USER, context: FOLDERS });
    return until(`a reply to "${text}"`, () => thread(episodeId).turns.find((t) => t.id === assistant!.id && t.status === "done"));
  }
  const waitingAt = (gate: string) => until(`the plan at ${gate}`, () => {
    try { return planRunView(w.core, w.db, prod).waiting_gate === gate; } catch { return false; }
  });

  it("one message makes a video; Claude asks what is missing, then it starts", async () => {
    prod = createDraftProduction(w.db, "team-1", USER, new Date().toISOString());
    const first = await say("Làm series vlog từ @[Kyoto 2025](folder:folder-a), giống kênh @meitime, không lời dẫn");
    expect(first).toMatchObject({ action: "revise", text: "Video ngang hay dọc?" });
    const second = await say("Ngang 16:9");
    expect(second.action).toBe("suggest_approve");
    startFromIntake(w.core, w.db, prod);
    expect(getProduction(w.db, prod)).toMatchObject({ title: "Series Kyoto 2025", aspect: "16:9", youtube_channels: JSON.stringify(["@meitime"]) });
  });

  it("the trend report waits for approval, then the R&D is revised in the chat and approved", async () => {
    await waitingAt("approve-trend-report");
    await approveChatScope(w.core, w.db, { productionId: prod, stageKey: "approve-trend-report", turnId: thread().current?.turnId ?? null, userId: USER });
    await waitingAt("approve-rnd");
    const reply = await say("Gộp tập 3 và 4, làm 3 tập thôi");
    expect(reply.action).toBe("revise");
    const shown = thread().current!;
    expect(shown.turnId).toBe(reply.id);
    await approveChatScope(w.core, w.db, { productionId: prod, stageKey: "approve-rnd", turnId: shown.turnId, userId: USER });
    // branding runs on its own after the R&D, which apply-rnd wrote into the production as approved
    await waitingAt("approve-branding");
    expect(productionRnd(getProduction(w.db, prod)!)?.summary).toBe((shown.document as { summary: string }).summary);
  });

  it("branding and plan approved; an episode's timeline is changed in the chat, applied and approved", async () => {
    await approveChatScope(w.core, w.db, { productionId: prod, stageKey: "approve-branding", turnId: thread().current?.turnId ?? null, userId: USER });
    await waitingAt("approve-plan");
    await approveChatScope(w.core, w.db, { productionId: prod, stageKey: "approve-plan", turnId: thread().current?.turnId ?? null, userId: USER });
    const ep = await until("an episode at approve-timeline", () => {
      const e = listEpisodes(w.db, prod)[0];
      return e?.run_id && episodeRunView(w.core, w.db, e.id).waiting_gate === "approve-timeline" ? e : undefined;
    });
    const before = latestEpisodeRevision(w.db, ep.id)!;
    const reply = await say("Nhạc nhỏ lại, thêm chữ \"Phở sáng\" ở clip 2", ep.id);
    expect(reply.action).toBe("revise");
    expect(thread(ep.id).current?.pendingApply).toBe(true);
    const { revision } = applyChatProposal(w.core, w.db, { productionId: prod, turnId: reply.id, userId: USER });
    expect(revision).toBe(before.revision + 1);
    expect(latestEpisodeRevision(w.db, ep.id)!.data.texts.some((t) => t.text === "Phở sáng")).toBe(true);
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId: ep.id, stageKey: "approve-timeline", userId: USER });
    await until("the episode at approve-youtube-kit", () => episodeRunView(w.core, w.db, ep.id).waiting_gate === "approve-youtube-kit");
  });
});
