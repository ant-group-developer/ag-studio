/**
 * Phase 5 acceptance in process (plan 2026-10-06-ag-studio-phase-5-cut, I1): a shot-cut episode from three videos, the
 * worker pool running in the background with the fake Claude and the fake farm, ffmpeg making the proxies' shots and
 * frames. The test acts like a person through the functions the API routes call:
 *   plan 3.1.0 (the episode cut shot by shot, with narration, 4K) → scene selection: chat "giữ lại s000-000", Duyệt →
 *   edit plan: Duyệt → the farm reads every line → run again from the edit plan: chat "câu L002 ngắn lại", Duyệt →
 *   the farm reads only that line → timeline v4: chat trims a clip, Áp dụng, Duyệt → kit on a machine with NVENC →
 *   the final render's composition: 3840×2160, pieces with in > 0, a dissolve, the narration, caption cues.
 * Skipped without ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH may point at any build).
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompositionSchema, EditPlanSchema, StudioSurveySchema, TimelineV4Schema } from "@harness/contracts";
import {
  applyChatProposal, approveChatScope, chatScopeFor, createStudioWorkerPool, episodeRunView, episodeShots, episodeState, getTurn,
  latestEpisodeRevision, listEpisodes, planRunView, readStageDocument, rerunEpisodeFrom, sendChatMessage, startPlanRun,
  type CutMediaDeps, type StudioWorkerPool, type SurveyProposal, type TimelineProposal,
} from "@ag-studio/engine";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "../../packages/studio-engine/test/helpers.js";
import { hasFfmpeg, makeSceneClip } from "../media.js";

const USER = "auth0|owner";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

async function until<T>(what: string, f: () => T | undefined | null | false, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasFfmpeg())("a shot-cut episode, three videos, chat at every gate, rendered in 4K (needs ffmpeg + ffprobe)", () => {
  const w = world();
  const farm = fakeFarm(w.bucket);
  const clips = mkdtempSync(join(tmpdir(), "ag-go-cut-"));
  const media: CutMediaDeps = {
    ffmpeg: FFMPEG, ffprobe: FFPROBE, voiceDir: join(w.dir, "voice"),
    // ag-go: each video 20 s of four solid colours (four shots of 5 s), with sound
    resolveAssets: async (_actAs, ids) => ({
      items: ids.map((id) => {
        const path = join(clips, `${id}.mp4`);
        makeSceneClip(path, { seconds: 20, colors: ["black", "white", "gray", "navy"] });
        return { assetId: id, url: path, sourceKind: "proxy" as const, watermarked: false };
      }),
      missing: [],
    }),
    download: async (url, dest) => { copyFileSync(url, dest); },
  };
  let pool: StudioWorkerPool;
  const ac = new AbortController();
  let running: Promise<void>;
  let prod = "";
  let episodeId = "";
  const prevMode = process.env.FAKE_STUDIO_MODE;
  const tts = () => [...farm.jobs.values()].filter((j) => j.type === "studio.tts");
  const waitingAt = (gate: string) => () => episodeRunView(w.core, w.db, episodeId).waiting_gate === gate;
  /** A message to the episode's chat, answered by the pool's chat runner. */
  async function say(text: string) {
    const { assistant } = sendChatMessage(w.core, w.db, { productionId: prod, episodeId, text, userId: USER });
    return until(`Claude's reply to "${text}"`, () => { const t = getTurn(w.db, assistant!.id)!; return t.status === "done" || t.status === "failed" ? t : undefined; });
  }

  beforeAll(() => {
    process.env.FAKE_STUDIO_MODE = "plan-cut";
    pool = createStudioWorkerPool({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(3, 20), farm: farm as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "cut-episode", thumbnails: fakeThumbnails(), logger: quiet, claudeMaxConcurrent: 4, chatPollMs: 50, farmPollMs: 20, media,
    });
    running = pool.runForever(ac.signal);
  });
  afterAll(async () => {
    ac.abort();
    await running;
    w.core.close();
    if (prevMode === undefined) delete process.env.FAKE_STUDIO_MODE; else process.env.FAKE_STUDIO_MODE = prevMode;
  });

  it("plan 3.1.0 cuts the episode shot by shot from three videos", async () => {
    prod = seedProduction(w.db, { episode_target_seconds: 40, max_episodes: 1 });
    w.db.run("UPDATE productions SET keywords = ?, canvas = ?, voice = ? WHERE id = ?", [
      JSON.stringify(["phố cổ"]), JSON.stringify({ width: 3840, height: 2160 }),
      JSON.stringify({ reference: "library:voices/mai.wav", reference_text: "Xin chào, tôi là Mai.", speed: 1 }), prod,
    ]);
    startPlanRun(w.core, w.db, prod);
    for (const gate of ["approve-trend-report", "approve-rnd", "approve-branding", "approve-plan"]) {
      await until(`the plan at ${gate}`, () => planRunView(w.core, w.db, prod).waiting_gate === gate);
      await approveChatScope(w.core, w.db, { productionId: prod, stageKey: gate, turnId: null, userId: USER });
    }
    const ep = await until("the episode at approve-survey", () => {
      const e = listEpisodes(w.db, prod)[0];
      return e?.run_id && episodeRunView(w.core, w.db, e.id).waiting_gate === "approve-survey" ? e : undefined;
    });
    episodeId = ep.id;
    expect(ep.edit_style).toBe("cut");
    const shots = episodeShots(w.core, w.db, episodeId);
    expect(new Set(shots.shots.map((x) => x.source_id)).size).toBe(3);
    expect(shots.shots).toHaveLength(12);
  });

  it("scene selection: the chat keeps the shot Claude dropped, approved as shown", async () => {
    const reply = await say("Giữ lại s000-000, rung nhẹ thôi");
    expect(reply).toMatchObject({ status: "done", action: "revise", problems: [] });
    expect((reply.proposal as SurveyProposal).ops).toEqual([expect.objectContaining({ op: "keep", shot_id: "s000-000" })]);
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-survey", turnId: reply.id, userId: USER });
    await until("the edit plan waiting", waitingAt("approve-edit-plan"));
    const runId = listEpisodes(w.db, prod)[0]!.run_id!;
    expect(StudioSurveySchema.parse(readStageDocument(w.core, runId, "approve-survey", "survey.json")).shots[0]).toMatchObject({ shot_id: "s000-000", usable: true });
    const plan = EditPlanSchema.parse(readStageDocument(w.core, runId, "plan-edit", "edit-plan.json"));
    expect(plan.shots[0]!.shot_id).toBe("s000-000");
  });

  it("edit plan approved: the farm reads every line once", async () => {
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-edit-plan", turnId: null, userId: USER });
    await until("the timeline waiting", waitingAt("approve-timeline"));
    const runId = listEpisodes(w.db, prod)[0]!.run_id!;
    const plan = EditPlanSchema.parse(readStageDocument(w.core, runId, "approve-edit-plan", "edit-plan.json"));
    expect(plan.lines.length).toBeGreaterThanOrEqual(3);
    expect(tts()).toHaveLength(1);
    expect((tts()[0]!.payload.lines as unknown[]).length).toBe(plan.lines.length);
  });

  it("run again from the edit plan, one line shortened in the chat: the farm reads only that line", async () => {
    const before = listEpisodes(w.db, prod)[0]!.run_id!;
    const again = rerunEpisodeFrom(w.core, w.db, episodeId, "approve-edit-plan");
    expect(again.runId).not.toBe(before);
    await until("the edit plan waiting again", waitingAt("approve-edit-plan"));
    expect(chatScopeFor(w.core, w.db, prod, episodeId)).toMatchObject({ stageKey: "approve-edit-plan", runId: again.runId });
    const reply = await say("câu L002 ngắn lại");
    expect(reply).toMatchObject({ status: "done", action: "revise", problems: [] });
    const old = EditPlanSchema.parse(readStageDocument(w.core, again.runId, "plan-edit", "edit-plan.json"));
    const revised = EditPlanSchema.parse(reply.proposal);
    const l2 = revised.lines.find((l) => l.line_id === "L002")!;
    expect(l2.text.length).toBeLessThan(old.lines.find((l) => l.line_id === "L002")!.text.length);
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-edit-plan", turnId: reply.id, userId: USER });
    await until("the timeline waiting again", waitingAt("approve-timeline"));
    expect(tts()).toHaveLength(2);
    expect(tts()[1]!.payload.lines).toEqual([expect.objectContaining({ line_id: "L002", text: l2.text })]);
  });

  it("timeline v4: the chat trims the first clip, applied as a revision, approved", async () => {
    const reply = await say("Ngắn lại clip đầu");
    const p = reply.proposal as TimelineProposal;
    expect(p.ops.map((o) => o.op)).toEqual(["trimClip"]);
    const { revision } = applyChatProposal(w.core, w.db, { productionId: prod, turnId: reply.id, userId: USER });
    const saved = TimelineV4Schema.parse(latestEpisodeRevision(w.db, episodeId)!.data);
    expect(latestEpisodeRevision(w.db, episodeId)!.revision).toBe(revision);
    expect(saved.clips[0]!.out! - saved.clips[0]!.in).toBeCloseTo(1.5, 3);
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-timeline", userId: USER });
    await until("the kit waiting", waitingAt("approve-youtube-kit"));
  });

  it("kit approved on a machine with NVENC: the 4K render of the cut, with narration, a dissolve and captions", async () => {
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-youtube-kit", userId: USER, renderMachine: "nvenc" });
    await until("the episode ready", () => episodeState(w.core, w.db, listEpisodes(w.db, prod)[0]!).status === "ready");
    const render = [...farm.jobs.values()].filter((j) => j.type === "studio.render_final");
    expect(render).toHaveLength(1);
    expect(render[0]!.requirements).toEqual({ nvenc: true });
    const runId = listEpisodes(w.db, prod)[0]!.run_id!;
    expect(JSON.parse(w.db.get<{ requirements: string }>(
      "SELECT requirements FROM studio_farm_jobs WHERE run_id = ? AND stage_key = 'render-final'", [runId])!.requirements)).toEqual({ nvenc: true });

    const key = [...w.bucket.objects.keys()].find((k) => k.includes("/jobs/render-final/") && k.endsWith("/in/composition.json"))!;
    const c = CompositionSchema.parse(JSON.parse(w.bucket.objects.get(key)!.toString("utf8")));
    expect(c.output).toMatchObject({ width: 3840, height: 2160 });
    expect(c.segments.some((s) => s.in > 0)).toBe(true);
    expect(c.transitions.applied).toBeGreaterThanOrEqual(1);
    expect(c.segments.some((s) => s.transition_out.kind === "dissolve")).toBe(true);
    const timeline = TimelineV4Schema.parse(latestEpisodeRevision(w.db, episodeId)!.data);
    expect(c.voice).toBe("tts");
    expect(c.narration.map((n) => n.line_id)).toEqual(timeline.narration.lines.map((l) => l.line_id));
    expect(c.narration.length).toBeGreaterThanOrEqual(3);
    expect(c.captions.mode).toBe("burn-in");
    expect(c.captions.cues.length).toBeGreaterThan(0);
  });
});
