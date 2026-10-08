/**
 * Chat context: which scope a message goes to, the document on show, the prompt head and the check of a proposal.
 * The head of a gate's chat must be byte for byte the head of the stage that wrote the document (prompt cache).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrendReportSchema, type TimelineChatProposal } from "@harness/contracts";
import {
  cancelPlan, chatContext, chatScopeFor, completeTurn, createStudioWorker, insertUserTurn, listEpisodes, listLlmCalls, readLlmCallPayload,
  readStageDocument, resumePlanRunFrom, startPlanRun, StudioRunError, submitStudioGate, type TimelineProposal,
} from "../src/index.js";
import { approvePlanGatesUntil, FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

function setup(mode = "") {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3, baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode } },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker };
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
const ws = () => mkdtempSync(join(tmpdir(), "chat-ws-"));
const conflictCode = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof StudioRunError ? (e.details as { code?: string }).code : String(e); } return null; };

describe("chat context", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("a production with no run chats about its intake; the draft is what the row has", async () => {
    s = setup();
    const id = prod(s);
    const key = chatScopeFor(s.core, s.db, id);
    expect(key).toEqual({ productionId: id, episodeId: null, runId: null, stageKey: "intake", scope: "intake" });
    const ctx = chatContext(s.core, s.db, key, { folders: [{ id: "folder-a", name: "Phở", usableVideos: 8 }] });
    expect(ctx.current).toMatchObject({ title: "Phở sáng Hà Nội", folder_ids: ["folder-a"], keywords: ["phở sáng"], aspect: "16:9" });
    const { head, validate } = await ctx.prepare(ws());
    expect(head).toContain("\"usable_videos\": 8");
    expect(validate({ ...(ctx.current as object), folder_ids: ["folder-z"] }).problems[0]?.code).toBe("unknown_folder");
    expect(validate(ctx.current).ok).toBe(true);
  });

  it("a waiting gate: the stage's own head, its draft, its check; a proposal becomes the document on show", async () => {
    s = setup();
    const id = prod(s);
    const { runId } = startPlanRun(s.core, s.db, id);
    expect(conflictCode(() => chatScopeFor(s.core, s.db, id))).toBe("busy");
    await drain(s);
    const key = chatScopeFor(s.core, s.db, id);
    expect(key).toMatchObject({ runId, stageKey: "approve-trend-report", scope: "gate" });
    const ctx = chatContext(s.core, s.db, key);
    expect(ctx.skill).toBe("studio-trend-report");
    expect(ctx.current).toEqual(readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    const { validate } = await ctx.prepare(ws());
    expect(validate(ctx.current).ok).toBe(true);
    expect(validate({ schema_version: "studio.trend-report/v1" }).ok).toBe(false);

    const t = insertUserTurn(s.db, key, { text: "Ngắn hơn", createdBy: "u" }, new Date().toISOString());
    const shorter = { ...TrendReportSchema.parse(ctx.current), summary: "Ngắn." };
    completeTurn(s.db, t.assistant!.id, { text: "Đã rút gọn", action: "revise", proposal: shorter, problems: [], llmCallId: null }, new Date().toISOString());
    const again = chatContext(s.core, s.db, key);
    expect(again.current).toEqual(shorter);
    expect(again.currentTurnId).toBe(t.assistant!.id);
    expect(again.draft).toEqual(ctx.current);

    // the R&D (a real Claude call here: the trend report was skipped, no research videos): the head is the stage's own
    await submitStudioGate(s.core, s.db, runId, "approve-trend-report", shorter);
    await approvePlanGatesUntil(s, id, () => drain(s), "approve-rnd");
    const rnd = chatContext(s.core, s.db, chatScopeFor(s.core, s.db, id));
    const { head } = await rnd.prepare(ws());
    const call = listLlmCalls(s.db, { productionId: id, page: 1, pageSize: 20 }).items.find((c) => c.stage_key === "rnd")!;
    const sent = (await readLlmCallPayload(s.bucket, call.payload_key!)).prompt;
    expect(sent).toContain(`# Brief\n${head}\n\n# Đầu ra`);
  }, 60_000);

  it("a gate whose stage was reused in a new run still gets that stage's inputs", async () => {
    s = setup();
    const id = prod(s);
    const { runId } = startPlanRun(s.core, s.db, id);
    await drain(s);
    await submitStudioGate(s.core, s.db, runId, "approve-trend-report", readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    await approvePlanGatesUntil(s, id, () => drain(s), "approve-rnd");
    cancelPlan(s.core, s.db, id);
    await drain(s);
    const { runId: next } = resumePlanRunFrom(s.core, s.db, id, "approve-rnd");
    await approvePlanGatesUntil(s, id, () => drain(s), "approve-rnd");
    const ctx = chatContext(s.core, s.db, chatScopeFor(s.core, s.db, id));
    expect(ctx.skill).toBe("studio-rnd");
    const { head, validate } = await ctx.prepare(ws());
    expect(head).toContain("## studio_catalog_summary (catalog.json)");
    expect(validate(ctx.current).ok).toBe(true);
    expect(next).not.toBe(runId);
  }, 60_000);

  it("a Claude stage that failed its check: the rejected answer and why", async () => {
    s = setup("plan-bad-always");
    const id = prod(s);
    startPlanRun(s.core, s.db, id, { workflow: "ag-studio-series-plan@1.0.0" });
    await drain(s);
    const key = chatScopeFor(s.core, s.db, id);
    expect(key).toMatchObject({ stageKey: "plan-episodes", scope: "failed" });
    const ctx = chatContext(s.core, s.db, key);
    expect(ctx.skill).toBe("studio-plan-episodes");
    expect(ctx.problems.length).toBeGreaterThan(0);
    expect(ctx.draft).not.toBeNull();
  }, 60_000);

  it("an episode at approve-timeline chats with edit operations checked by layout and timelineIssues", async () => {
    s = setup();
    const id = prod(s);
    const { runId } = startPlanRun(s.core, s.db, id);
    await approvePlanGatesUntil(s, id, () => drain(s), null);
    await drain(s);
    const ep = listEpisodes(s.db, id)[0]!;
    const key = chatScopeFor(s.core, s.db, id, ep.id);
    expect(key).toMatchObject({ episodeId: ep.id, stageKey: "approve-timeline", scope: "gate" });
    const ctx = chatContext(s.core, s.db, key);
    expect(ctx.skill).toBe("studio-timeline");
    const { head, validate } = await ctx.prepare(ws());
    expect(head).toContain("## Timeline (thời điểm tính bằng giây)");
    const ops: TimelineChatProposal = { ops: [{ op: "addText", kind: "lower_third", text: "Phở sáng", start: 1, duration: 3, position: "bottom_left" }] };
    const ok = validate(ops);
    expect(ok.ok).toBe(true);
    expect((ok.value as TimelineProposal).timeline.texts.at(-1)?.text).toBe("Phở sáng");
    expect(validate({ ops: [{ op: "addClip", asset_id: "nope", index: 0 }] }).problems[0]?.code).toBe("unknown_asset");
    const first = (ctx.current as { clips: { asset_id: string }[] }).clips[0]!.asset_id;
    expect(validate({ ops: [{ op: "addClip", asset_id: first, index: 0 }] }).problems[0]?.code).toBe("duplicate_asset");
  }, 90_000);
});
