/**
 * The series end to end in-process (fake Claude, fake ag-go, fake farm): plan run -> approve-plan -> spawn-episodes
 * -> every episode run renders and exports on its own (no gate) -> "Render lại" renders the latest revision, and a
 * timeline the render cannot play parks at freeze-timeline until the person fixes it.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioWorker, episodeExport, episodeRunView, episodeState, latestEpisodeRevision, listEpisodes,
  planRunView, readStageDocument, rerenderEpisode, saveEpisodeRevision, startEpisodeRun, startPlanRun, STUDIO_WORKFLOWS,
  StudioRunError, submitStudioGate,
} from "../src/index.js";
import { StudioYoutubeSchema, TrendReportSchema, SeriesPlanSchema, type TimelineV3 } from "@harness/contracts";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, seedProduction, world, ROOT } from "./helpers.js";

type Worker = ReturnType<typeof createStudioWorker>;

async function drain(worker: Worker, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if ((await worker.runOnce()) === "idle") return;
  }
  throw new Error(`worker still busy after ${maxTicks} ticks`);
}

function setup(assets = 8, seconds = 30) {
  const w = world();
  const farm = fakeFarm(w.bucket);
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(assets, seconds), farm: farm as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "auth0|owner",
  });
  return { ...w, farm, worker };
}

/** Plan -> approve as proposed -> spawn; returns once every episode run has finished. */
async function produceSeries(s: ReturnType<typeof setup>, prodId: string) {
  const { runId } = startPlanRun(s.core, s.db, prodId);
  await drain(s.worker);
  const waiting = planRunView(s.core, s.db, prodId);
  expect(waiting.waiting_gate).toBe("approve-plan");
  const plan = SeriesPlanSchema.parse(readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
  await submitStudioGate(s.core, s.db, runId, "approve-plan", plan);
  await drain(s.worker);
  return { runId, plan };
}

describe(`${STUDIO_WORKFLOWS.plan.workflow} + ${STUDIO_WORKFLOWS.episode.workflow}`, () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => s?.core.close());

  it("plans, spawns and produces every episode without a gate: video, 3 thumbnails, youtube.json, pack", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    const { runId, plan } = await produceSeries(s, prodId);

    // no channels/keywords: research skipped, so the trend report is written without Claude
    const trend = TrendReportSchema.parse(readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    expect(trend.skipped).toBe(true);
    expect(planRunView(s.core, s.db, prodId).state).toBe("SUCCEEDED");
    expect(plan.episodes).toHaveLength(2);

    const episodes = listEpisodes(s.db, prodId);
    expect(episodes.map((e) => e.idx)).toEqual([1, 2]);
    for (const ep of episodes) {
      expect(episodeState(s.core, s.db, ep)).toMatchObject({ status: "ready", current_stage: null });
      const view = episodeRunView(s.core, s.db, ep.id);
      expect(view.stages.map((x) => x.key)).toEqual(["episode-intake", "build-timeline", "youtube-kit", "freeze-timeline", "render-final", "export"]);
      expect(view.waiting_gate).toBeNull();
      const exp = episodeExport(s.core, ep)!;
      expect(exp.files.map((f) => f.kind).sort()).toEqual(["mp4", "pack", "thumbnail", "thumbnail", "thumbnail", "timeline", "youtube"]);
      for (const f of exp.files) expect(s.bucket.objects.has(f.key)).toBe(true);
      const yt = StudioYoutubeSchema.parse(JSON.parse(s.bucket.objects.get(exp.files.find((f) => f.kind === "youtube")!.key)!.toString("utf8")));
      expect(yt.episode_id).toBe(ep.id);
      expect(yt.thumbnail_key).toBe(exp.files.filter((f) => f.kind === "thumbnail").map((f) => f.key).sort()[0]);
      expect(latestEpisodeRevision(s.db, ep.id)?.revision).toBe(1);
    }
    // each render asked for 3 thumbnails inside the episode
    const renders = [...s.farm.jobs.values()].filter((j) => j.type === "studio.render_final");
    expect(renders).toHaveLength(2);
    for (const r of renders) {
      const thumbs = r.payload.thumbnails as { t_s: number; text: string }[];
      expect(thumbs).toHaveLength(3);
      for (const t of thumbs) expect(t.t_s).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it("Render lại renders the latest revision and keeps Claude's YouTube kit", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const ep = listEpisodes(s.db, prodId)[0]!;
    const before = latestEpisodeRevision(s.db, ep.id)!;
    // three sections of 30 s each -> YouTube chapters
    const edited: TimelineV3 = {
      ...before.data,
      clips: before.data.clips.map((c, i) => ({ ...c, section_title: i < 3 ? `Chương ${i + 1}` : null })),
    };
    const { revision } = saveEpisodeRevision(s.db, ep.id, { baseRevision: before.revision, data: edited, authorId: "editor-1" });
    const oldRun = ep.run_id!;

    const { runId, reused } = rerenderEpisode(s.core, s.db, ep.id);
    expect(runId).not.toBe(oldRun);
    expect(reused.sort()).toEqual(["build-timeline", "episode-intake", "youtube-kit"]);
    await drain(s.worker);

    const after = listEpisodes(s.db, prodId).find((e) => e.id === ep.id)!;
    expect(after.run_id).toBe(runId);
    expect(episodeState(s.core, s.db, after).status).toBe("ready");
    const lastRender = [...s.farm.jobs.values()].filter((j) => j.type === "studio.render_final").at(-1)!;
    expect(lastRender.payload.revision).toBe(revision);
    const exp = episodeExport(s.core, after)!;
    const yt = StudioYoutubeSchema.parse(JSON.parse(s.bucket.objects.get(exp.files.find((f) => f.kind === "youtube")!.key)!.toString("utf8")));
    expect(yt.chapters.map((c) => c.title)).toEqual(["Chương 1", "Chương 2", "Chương 3"]);
    expect(yt.description).toContain("0:00 Chương 1");
  }, 60_000);

  it("a timeline the render cannot play parks at freeze-timeline; fixing it and Render lại finishes the episode", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const ep = listEpisodes(s.db, prodId)[1]!;
    const good = latestEpisodeRevision(s.db, ep.id)!;
    const broken: TimelineV3 = { ...good.data, clips: [...good.data.clips, { clip_id: "C900", asset_id: "missing-asset", section_title: null }] };
    const r2 = saveEpisodeRevision(s.db, ep.id, { baseRevision: good.revision, data: broken, authorId: "editor-1" });

    const { runId } = rerenderEpisode(s.core, s.db, ep.id);
    await drain(s.worker);
    const parked = episodeRunView(s.core, s.db, ep.id);
    expect(parked.run_id).toBe(runId);
    const freeze = parked.stages.find((x) => x.key === "freeze-timeline")!;
    expect(["WAITING_HUMAN", "FAILED"]).toContain(freeze.state);
    expect(freeze.error).toContain("missing-asset");
    expect(parked.stages.find((x) => x.key === "render-final")!.state).not.toBe("SUCCEEDED");

    saveEpisodeRevision(s.db, ep.id, { baseRevision: r2.revision, data: good.data, authorId: "editor-1" });
    const again = rerenderEpisode(s.core, s.db, ep.id);
    expect(again.runId).toBe(runId); // the parked run carries on from freeze-timeline
    await drain(s.worker);
    expect(episodeState(s.core, s.db, listEpisodes(s.db, prodId)[1]!).status).toBe("ready");
  }, 60_000);

  it("refuses to re-plan while an episode is producing, and a running episode cannot be re-rendered", async () => {
    s = setup(4);
    const prodId = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
    const now = new Date().toISOString();
    s.db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES ('ep-x', ?, 1, 'T', 'h', '{}', ?, ?)", [prodId, now, now]);
    startEpisodeRun(s.core, s.db, "ep-x");
    const replan = (() => { try { startPlanRun(s.core, s.db, prodId); } catch (e) { return e; } return null; })();
    expect(replan).toBeInstanceOf(StudioRunError);
    expect((replan as StudioRunError).details.code).toBe("episode_producing");
    const rerender = (() => { try { rerenderEpisode(s.core, s.db, "ep-x"); } catch (e) { return e; } return null; })();
    expect((rerender as StudioRunError).details.code).toBe("episode_running");
  });
});
