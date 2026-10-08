/**
 * A step's document read again after its approval, and edited (plan 2026-10-07 step history): the version in use
 * replaced where later steps read it, or the step reopened with the edit on show to approve again.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StudioRnd, TrendReport, YoutubeKit } from "@harness/contracts";
import {
  approveChatScope, chatThread, createStudioWorker, editStepDocument, episodeKit, getEpisode, getProduction, listEpisodes, listHumanEdits,
  readStageDocument, startPlanRun, stepDocument, StudioRunError, submitStudioGate,
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
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof StudioRunError ? (e.details as { code?: string } | undefined)?.code ?? e.code : String(e); }
  return null;
};
const waiting = (s: Setup, runId: string) => s.core.store.listStageRuns(runId).filter((x) => x.state === "WAITING_HUMAN").map((x) => x.stage_key);

describe("step documents", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  async function atTrend() {
    s = setup();
    const id = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
    s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở"]), id]);
    const { runId } = startPlanRun(s.core, s.db, id);
    await drain(s);
    return { id, runId };
  }

  it("an approved trend report reads again; before the episodes exist it only changes by reopening its step", async () => {
    const { id, runId } = await atTrend();
    expect(stepDocument(s.core, s.db, { productionId: id, kind: "trend_report" })).toMatchObject({ state: "waiting", document: null });
    expect(stepDocument(s.core, s.db, { productionId: id, kind: "rnd" }).state).toBe("not_yet");
    const proposed = readStageDocument(s.core, runId, "trend-report", "trend-report.json") as TrendReport;
    await submitStudioGate(s.core, s.db, runId, "approve-trend-report", proposed);
    await approvePlanGatesUntil(s, id, () => drain(s), "approve-rnd");
    expect(waiting(s, runId)).toEqual(["approve-rnd"]);

    const view = stepDocument(s.core, s.db, { productionId: id, kind: "trend_report" });
    expect(view).toMatchObject({ state: "approved", document: proposed, inUse: false });
    expect(view.edit).toMatchObject({ inPlace: false, inPlaceCode: "only_reopen", reopen: true, replacesEpisodes: false });
    expect(view.edit.reruns.slice(0, 2)).toEqual(["approve-trend-report", "rnd"]);

    const edited = { ...proposed, summary: "Tay." };
    expect(code(() => editStepDocument(s.core, s.db, { productionId: id, kind: "trend_report", document: edited, reopen: false, userId: "u" }))).toBe("only_reopen");
    expect(code(() => editStepDocument(s.core, s.db, { productionId: id, kind: "trend_report", document: { nope: 1 }, reopen: true, userId: "u" }))).toBe("rejected");

    // parked at the R&D with nothing working: that run goes, a new one waits at the trend report with the edit on show
    const out = editStepDocument(s.core, s.db, { productionId: id, kind: "trend_report", document: edited, reopen: true, userId: "u" });
    expect(out.mode).toBe("reopened");
    expect(s.core.store.getRun(runId)!.state).toBe("CANCELLED");
    expect(getProduction(s.db, id)!.run_id).toBe(out.runId);
    await drain(s);
    expect(waiting(s, out.runId!)).toEqual(["approve-trend-report"]);
    const thread = chatThread(s.core, s.db, id);
    expect(thread.current?.document).toMatchObject({ summary: "Tay." });
    await approveChatScope(s.core, s.db, { productionId: id, stageKey: "approve-trend-report", turnId: thread.current!.turnId, userId: "u" });
    expect(readStageDocument(s.core, out.runId!, "approve-trend-report", "trend-report.json")).toMatchObject({ summary: "Tay." });
    await drain(s);
    expect(waiting(s, out.runId!)).toEqual(["approve-rnd"]);
  }, 90_000);

  it("once the episodes exist: R&D and the trend report change in place, the plan only by reopening, not while an episode waits", async () => {
    const { id, runId } = await atTrend();
    await approvePlanGatesUntil(s, id, () => drain(s), null);
    await drain(s);
    const ep = listEpisodes(s.db, id)[0]!;
    expect(waiting(s, getEpisode(s.db, ep.id)!.run_id!)).toEqual(["approve-timeline"]);

    const rnd = stepDocument(s.core, s.db, { productionId: id, kind: "rnd" });
    expect(rnd.edit).toMatchObject({ inPlace: true, reopen: false, reopenCode: "episode_producing", replacesEpisodes: true });
    const edited = { ...(rnd.document as StudioRnd), summary: "R&D sửa tay." };
    expect(editStepDocument(s.core, s.db, { productionId: id, kind: "rnd", document: edited, reopen: false, userId: "u" }).mode).toBe("saved");
    expect(stepDocument(s.core, s.db, { productionId: id, kind: "rnd" })).toMatchObject({ inUse: true, document: { summary: "R&D sửa tay." } });
    expect(code(() => editStepDocument(s.core, s.db, { productionId: id, kind: "rnd", document: edited, reopen: true, userId: "u" }))).toBe("episode_producing");

    const trend = stepDocument(s.core, s.db, { productionId: id, kind: "trend_report" });
    expect(trend.edit.inPlace).toBe(true);
    editStepDocument(s.core, s.db, { productionId: id, kind: "trend_report", document: { ...(trend.document as TrendReport), summary: "Đổi." }, reopen: false, userId: "u" });
    expect(JSON.parse(getProduction(s.db, id)!.trend_report!)).toMatchObject({ summary: "Đổi." });

    const plan = stepDocument(s.core, s.db, { productionId: id, kind: "series_plan" });
    expect(plan.edit).toMatchObject({ inPlace: false, inPlaceCode: "only_reopen" });
    expect(code(() => stepDocument(s.core, s.db, { productionId: id, kind: "youtube_kit" }))).toBe("bad_kind");
    expect(stepDocument(s.core, s.db, { productionId: id, episodeId: ep.id, kind: "youtube_kit" }).state).toBe("not_yet");

    const kinds = listHumanEdits(s.db, { productionId: id, page: 1, pageSize: 20 }).items.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["rnd_edit", "trend_report"]));
    expect(chatThread(s.core, s.db, id).turns.map((x) => x.text)).toEqual(expect.arrayContaining(["Đã sửa tay R&D (bản đang dùng)."]));
  }, 90_000);

  it("an approved YouTube kit changes in place (the render reads it), never by reopening", async () => {
    const { id, runId } = await atTrend();
    await approvePlanGatesUntil(s, id, () => drain(s), null);
    await drain(s);
    const ep = listEpisodes(s.db, id)[0]!;
    const epRun = getEpisode(s.db, ep.id)!.run_id!;
    await submitStudioGate(s.core, s.db, epRun, "approve-timeline", readStageDocument(s.core, epRun, "build-timeline", "timeline.json"));
    await drain(s);
    const kit = { ...(readStageDocument(s.core, epRun, "youtube-kit", "youtube-kit.json") as YoutubeKit), description: "Bản đã duyệt." };
    await submitStudioGate(s.core, s.db, epRun, "approve-youtube-kit", kit);
    await drain(s);
    // the kit in use is the one approved (edited at the gate), not Claude's draft
    expect(episodeKit(s.core, getEpisode(s.db, ep.id)!)?.description).toBe("Bản đã duyệt.");

    const view = stepDocument(s.core, s.db, { productionId: id, episodeId: ep.id, kind: "youtube_kit" });
    expect(view).toMatchObject({ state: "approved", document: kit, edit: { inPlace: true, reopen: false, reopenCode: "render_again", reruns: [] } });
    const edited = { ...kit, description: "Mô tả mới." };
    editStepDocument(s.core, s.db, { productionId: id, episodeId: ep.id, kind: "youtube_kit", document: edited, reopen: false, userId: "u" });
    expect(JSON.parse(getEpisode(s.db, ep.id)!.youtube!)).toMatchObject({ description: "Mô tả mới." });
    expect(stepDocument(s.core, s.db, { productionId: id, episodeId: ep.id, kind: "youtube_kit" })).toMatchObject({ inUse: true });
    expect(episodeKit(s.core, getEpisode(s.db, ep.id)!)?.description).toBe("Mô tả mới.");
  }, 120_000);
});
