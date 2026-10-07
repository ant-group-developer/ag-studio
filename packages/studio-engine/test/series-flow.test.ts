/**
 * The series end to end in-process (fake Claude, fake ag-go, fake farm): plan run -> approve-plan -> spawn-episodes
 * -> every episode run renders and exports on its own (no gate) -> "Render lại" renders the latest revision, and a
 * timeline the render cannot play parks at freeze-timeline until the person fixes it.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildYoutubePack, captureThumbnail, composeThumbnail, createStudioWorker, cutEpisodeFrames, deleteThumbnail, episodeExport, episodeRunView,
  episodeState, episodeThumbnails, getEpisode, insertThumbnail, latestEpisodeRevision, listEpisodes, listThumbnails, previewThumbnail, uploadThumbnail,
  planRunView, readStageDocument, rerenderEpisode, resumePlanRunFrom, saveEpisodeRevision, startEpisodeRun, startPlanRun,
  selectThumbnail, StudioRunError, studioResearchCache, submitStudioGate, type ResearchSource,
} from "../src/index.js";
import { StudioResearchSchema, StudioYoutubeSchema, TrendReportSchema, SeriesPlanSchema, type StudioResearch, type TimelineV3 } from "@harness/contracts";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, readStoredZip, seedProduction, world, ROOT } from "./helpers.js";

type Worker = ReturnType<typeof createStudioWorker>;

/** This file keeps covering the plan release before the research-first flow (runs of it may still be in flight). */
const PLAN_V1 = "ag-studio-series-plan@1.0.0";
/** …whose episodes run on the release without gates (episode 1.3.0 has its own test). */
const EPISODE_V12 = "ag-studio-episode@1.2.0";

async function drain(worker: Worker, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if ((await worker.runOnce()) === "idle") return;
  }
  throw new Error(`worker still busy after ${maxTicks} ticks`);
}

function setup(assets = 8, seconds = 30, research?: ResearchSource) {
  const w = world();
  const farm = fakeFarm(w.bucket);
  const thumbnails = fakeThumbnails();
  const worker = createStudioWorker({
    ...(research ? { research } : {}),
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(assets, seconds), farm: farm as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "auth0|owner", thumbnails,
  });
  return { ...w, farm, worker, thumbnails };
}

/** Plan -> approve as proposed -> spawn; returns once every episode run has finished. */
async function produceSeries(s: ReturnType<typeof setup>, prodId: string) {
  const { runId } = startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V1 });
  await drain(s.worker);
  const waiting = planRunView(s.core, s.db, prodId);
  expect(waiting.waiting_gate).toBe("approve-plan");
  const plan = SeriesPlanSchema.parse(readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
  await submitStudioGate(s.core, s.db, runId, "approve-plan", plan);
  await drain(s.worker);
  return { runId, plan };
}

describe(`${PLAN_V1} + ${EPISODE_V12}`, () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => s?.core.close());

  it("plans, spawns and produces every episode without a gate: video, clean frames + 3 suggestions recorded as thumbnails, youtube.json", async () => {
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
      expect(view.stages.map((x) => x.key)).toEqual(["episode-intake", "build-timeline", "youtube-kit", "freeze-timeline", "render-final", "thumbnails", "export"]);
      expect(view.waiting_gate).toBeNull();
      const exp = episodeExport(s.core, ep)!;
      expect(exp.files.map((f) => f.kind).sort()).toEqual(["mp4", "thumbnail", "thumbnail", "thumbnail", "timeline", "youtube"]);
      for (const f of exp.files) expect(s.bucket.objects.has(f.key)).toBe(true);
      // every frame and suggestion is a thumbnail of the episode, in the bucket; the first suggestion is the pick
      const thumbs = listThumbnails(s.db, ep.id);
      const frames = thumbs.filter((t) => t.kind === "frame");
      const suggestions = thumbs.filter((t) => t.kind === "suggestion");
      expect(frames.length).toBeGreaterThan(0);
      expect(suggestions).toHaveLength(3);
      for (const t of thumbs) expect(s.bucket.objects.has(t.image_key)).toBe(true);
      expect(suggestions.every((t) => t.base_key && frames.some((f) => f.image_key === t.base_key) && t.text && t.style)).toBe(true);
      const current = getEpisode(s.db, ep.id)!;
      expect(current.selected_thumbnail_id).toBe(suggestions[0]!.id);
      const yt = StudioYoutubeSchema.parse(JSON.parse(s.bucket.objects.get(exp.files.find((f) => f.kind === "youtube")!.key)!.toString("utf8")));
      expect(yt.episode_id).toBe(ep.id);
      expect(yt.thumbnail_key).toBe(suggestions[0]!.image_key);
      expect(latestEpisodeRevision(s.db, ep.id)?.revision).toBe(1);
    }
    // the render worker draws no thumbnail any more: Studio cuts them from the final video
    const renders = [...s.farm.jobs.values()].filter((j) => j.type === "studio.render_final");
    expect(renders).toHaveLength(2);
    for (const r of renders) expect(r.payload.thumbnails).toEqual([]);
    expect(s.thumbnails.calls.filter((c) => c.startsWith("compose"))).toHaveLength(6);
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

  it("Render lại brings new frames and suggestions; pictures a person made, and the pick of one, stay", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const [mine, auto] = listEpisodes(s.db, prodId);
    // episode 1: a person drew words on a frame and uses it; episode 2: a person picked the 2nd suggestion
    const frame = listThumbnails(s.db, mine!.id).find((t) => t.kind === "frame")!;
    const drawn = insertThumbnail(s.db, {
      episode_id: mine!.id, kind: "composed", source_run_id: null, parent_id: frame.id, t_s: frame.t_s, asset_id: frame.asset_id,
      base_key: frame.image_key, image_key: `${frame.image_key}.mine.jpg`, text: "Chữ của tôi", style: null,
      width: 1280, height: 720, size_bytes: 10, created_by: "editor-1",
    });
    selectThumbnail(s.db, mine!.id, drawn.id);
    selectThumbnail(s.db, auto!.id, listThumbnails(s.db, auto!.id).filter((t) => t.kind === "suggestion")[1]!.id);

    for (const ep of [mine!, auto!]) {
      const { runId } = rerenderEpisode(s.core, s.db, ep.id);
      await drain(s.worker);
      const system = listThumbnails(s.db, ep.id).filter((t) => t.kind === "frame" || t.kind === "suggestion");
      expect(system.length).toBeGreaterThan(3);
      expect(system.every((t) => t.source_run_id === runId)).toBe(true);
    }
    const kept = listThumbnails(s.db, mine!.id).find((t) => t.id === drawn.id)!;
    expect(kept.parent_id).toBeNull();
    expect(kept.base_key).toBe(frame.image_key);
    expect(getEpisode(s.db, mine!.id)!.selected_thumbnail_id).toBe(drawn.id);
    const fresh = listThumbnails(s.db, auto!.id).filter((t) => t.kind === "suggestion");
    expect(getEpisode(s.db, auto!.id)!.selected_thumbnail_id).toBe(fresh[0]!.id);
  }, 90_000);

  it("a person draws words on a clean frame, captures a moment, uploads a picture, and downloads the YouTube pack as it is now", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const ep = listEpisodes(s.db, prodId)[0]!;
    const d = { core: s.core, db: s.db, bucket: s.bucket };
    const style = { position: "bottom", size: "l", text_color: "#FFFFFF", outline_color: "#000000", box_color: null, uppercase: true } as const;
    const suggestion = episodeThumbnails(d, ep).find((t) => t.kind === "suggestion")!;

    // words go on the suggestion's clean frame, never on top of its drawn words
    const preview = await previewThumbnail(d, s.thumbnails, ep, { baseId: suggestion.id, text: "Phở sáng", style });
    expect(preview.toString("utf8")).toContain("PHỞ SÁNG");
    const drawn = await composeThumbnail(d, s.thumbnails, ep, { baseId: suggestion.id, text: "Phở sáng", style }, "editor-1");
    expect(drawn).toMatchObject({ kind: "composed", parent_id: suggestion.id, base_key: suggestion.base_key, text: "Phở sáng", created_by: "editor-1" });
    const drawnBytes = s.bucket.objects.get(drawn.image_key)!;
    expect(drawnBytes.subarray(0, s.bucket.objects.get(suggestion.base_key!)!.length)).toEqual(s.bucket.objects.get(suggestion.base_key!));
    await expect(composeThumbnail(d, s.thumbnails, ep, { baseId: suggestion.id, text: "x".repeat(61), style }, "editor-1")).rejects.toBeInstanceOf(StudioRunError);

    const captured = await captureThumbnail(d, s.thumbnails, ep, 5, "editor-1");
    expect(captured).toMatchObject({ kind: "frame", t_s: 5, created_by: "editor-1", asset_id: latestEpisodeRevision(s.db, ep.id)!.data.clips[0]!.asset_id });
    const uploaded = await uploadThumbnail(d, s.thumbnails, ep, Buffer.from("png bytes"), "editor-1");
    expect(uploaded.kind).toBe("upload");
    expect(s.thumbnails.calls).toContain("normalize");
    // a person deletes what they made, not the render's frames
    deleteThumbnail(s.db, ep.id, captured.id);
    expect(() => deleteThumbnail(s.db, ep.id, suggestion.id)).toThrow(StudioRunError);

    // the pack follows the latest pick and title; the same pack twice is stored once
    selectThumbnail(s.db, ep.id, drawn.id);
    s.db.run("UPDATE episodes SET selected_title = 1 WHERE id = ?", [ep.id]);
    const now = getEpisode(s.db, ep.id)!;
    const pack = await buildYoutubePack(d, now);
    const files = readStoredZip(s.bucket.objects.get(pack.key)!);
    expect([...files.keys()]).toEqual(["thumbnail.jpg", "youtube.json", "title.txt", "description.txt", "tags.txt"]);
    expect(files.get("thumbnail.jpg")).toEqual(drawnBytes);
    const yt = StudioYoutubeSchema.parse(JSON.parse(files.get("youtube.json")!.toString("utf8")));
    expect(yt.thumbnail_key).toBe(drawn.image_key);
    expect(files.get("title.txt")!.toString("utf8")).toBe(yt.title);
    // the second title is the one picked: the first is now an alternative
    expect(yt.alt_titles).toHaveLength(2);
    expect(yt.alt_titles[0]).not.toBe(yt.title);
    expect(pack.name).toMatch(/-youtube\.zip$/);
    const objects = s.bucket.objects.size;
    expect((await buildYoutubePack(d, now)).key).toBe(pack.key);
    expect(s.bucket.objects.size).toBe(objects);
  }, 60_000);

  it("an episode rendered before 1.2.0 gets its old pictures as suggestions, and clean frames cut once on demand", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const ep = listEpisodes(s.db, prodId)[0]!;
    const d = { core: s.core, db: s.db, bucket: s.bucket };
    // as if exported by 1.1.0: no rows yet, its 3 pictures only in export.json
    s.db.run("DELETE FROM episode_thumbnails WHERE episode_id = ?", [ep.id]);
    s.db.run("UPDATE episodes SET selected_thumbnail_id = NULL, selected_thumbnail = 2 WHERE id = ?", [ep.id]);
    const old = getEpisode(s.db, ep.id)!;
    const rows = episodeThumbnails(d, old);
    expect(rows.map((t) => t.kind)).toEqual(["suggestion", "suggestion", "suggestion"]);
    expect(getEpisode(s.db, ep.id)!.selected_thumbnail_id).toBe(rows[2]!.id);

    const cut = await cutEpisodeFrames(d, s.thumbnails, old);
    expect(cut).toBeGreaterThan(0);
    expect(listThumbnails(s.db, ep.id).filter((t) => t.kind === "frame")).toHaveLength(cut);
    expect(await cutEpisodeFrames(d, s.thumbnails, old)).toBe(0);
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
    startEpisodeRun(s.core, s.db, "ep-x", { workflow: EPISODE_V12 });
    const replan = (() => { try { startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V1 }); } catch (e) { return e; } return null; })();
    expect(replan).toBeInstanceOf(StudioRunError);
    expect((replan as StudioRunError).details.code).toBe("episode_producing");
    const rerender = (() => { try { rerenderEpisode(s.core, s.db, "ep-x"); } catch (e) { return e; } return null; })();
    expect((rerender as StudioRunError).details.code).toBe("episode_running");
  });

  it("a re-plan replaces the previous plan's episodes with the new plan's", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    const first = await produceSeries(s, prodId);
    const before = listEpisodes(s.db, prodId);
    expect(before.map((e) => e.plan_run_id)).toEqual([first.runId, first.runId]);

    const { runId } = resumePlanRunFrom(s.core, s.db, prodId, "plan-episodes");
    await drain(s.worker);
    const plan = SeriesPlanSchema.parse(readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-plan", { ...plan, episodes: plan.episodes.slice(0, 1) });
    await drain(s.worker);

    const after = listEpisodes(s.db, prodId);
    expect(after).toHaveLength(1);
    expect(after[0]!.plan_run_id).toBe(runId);
    expect(before.map((e) => e.id)).not.toContain(after[0]!.id);
    expect(episodeState(s.core, s.db, after[0]!).status).toBe("ready");
  }, 60_000);

  it("refuses to resume the plan while an episode is producing", async () => {
    s = setup();
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    await produceSeries(s, prodId);
    const ep = listEpisodes(s.db, prodId)[0]!;
    rerenderEpisode(s.core, s.db, ep.id);
    const resumed = (() => { try { resumePlanRunFrom(s.core, s.db, prodId, "plan-episodes"); } catch (e) { return e; } return null; })();
    expect(resumed).toBeInstanceOf(StudioRunError);
    expect((resumed as StudioRunError).details.code).toBe("episode_producing");
  }, 60_000);

  it("researches the channels and keywords, and the trend report is then written by Claude", async () => {
    const asked: string[][] = [];
    const research: ResearchSource = {
      async research(q): Promise<StudioResearch> {
        asked.push([...q.channels.map((c) => c.url), ...q.keywords]);
        const video = { video_id: "v1", channel_id: "UC1", channel_title: "Kênh A", title: "Phở bò Hà Nội", published_at: "2026-09-01T00:00:00Z",
          duration_s: 480, views: 90000, likes: 900, comments: 50, tags: ["phở"], views_per_day: 3000, outlier: true };
        return {
          schema_version: "studio.research/v1", production_id: q.production_id, fetched_at: "2026-09-30T00:00:00Z", quota_units: 204,
          skipped_reason: null, channels: [], keywords: [{ keyword: "phở", error: null, videos: [video] }],
          insights: { top_title_terms: [], top_tags: [], duration_buckets: [{ bucket: "5-10m", count: 1 }], frequent_channels: [] },
        };
      },
    };
    s = setup(8, 30, research);
    const prodId = seedProduction(s.db, { episode_target_seconds: 120, max_episodes: 2 });
    s.db.run("UPDATE productions SET keywords = ?, youtube_channels = ? WHERE id = ?", [JSON.stringify(["phở"]), JSON.stringify(["@kenhA"]), prodId]);
    const { runId } = startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V1 });
    await drain(s.worker);
    expect(asked).toEqual([["@kenhA", "phở"]]);
    const doc = StudioResearchSchema.parse(readStageDocument(s.core, runId, "research", "research.json"));
    expect(doc.quota_units).toBe(204);
    const trend = TrendReportSchema.parse(readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    expect(trend.skipped).toBe(false);
  }, 60_000);

  it("keeps YouTube answers in studio.db", async () => {
    s = setup();
    const cache = studioResearchCache(s.db);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", "{\"a\":1}", "2026-09-30T00:00:00Z");
    await cache.set("k", "{\"a\":2}", "2026-09-30T01:00:00Z");
    expect(await cache.get("k")).toEqual({ body: "{\"a\":2}", fetchedAt: "2026-09-30T01:00:00Z" });
  });
});
