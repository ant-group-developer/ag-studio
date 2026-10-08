/**
 * Studio in-process stages for GĐ2 (series of episodes).
 *
 * Plan-run stages: studio-series-intake, studio-research, studio-catalog, studio-spawn-episodes.
 * Episode-run stages: episode-intake, build-timeline, studio-freeze-timeline, studio-episode-export.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import JSZip from "yazl";
import {
  HarnessError, MAX_RESEARCH_CHANNELS, SeriesPlanSchema, SpawnedEpisodesSchema, StudioBrandingSchema, StudioBriefSchema, StudioCatalogSchema,
  StudioEpisodeSchema, StudioExportSchema, StudioResearchSchema, StudioRndSchema, StudioSeedSchema, StudioWebFindsSchema, StudioYoutubeSchema, StoredTimelineSchema,
  TrendReportSchema, parseStoredYoutubeKit,
  type AssetHints, type ChannelRef, type ExecutorContext, type StageRequest, type StudioBrief, type StudioCatalog, type StudioExport,
  type StudioEpisode, type TrendReport, StudioThumbnailsSchema, THUMBNAIL_SIZES, type StudioThumbnails, type StoredTimeline,
} from "@harness/contracts";
import {
  buildEpisodeTimeline, effectiveBrief, formatChapters, frameCandidateTimes, inputPath, layoutTimeline, normalizeCatalogVideo,
  orientationFits, prefilterCatalog, STUDIO_TIMELINE_TYPES, STUDIO_TYPES, suggestionFrame, thumbnailStyle, thumbnailTextLines, timelineIssues, youtubeChapters,
  type AgGoFootageVideo,
} from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { productionKey, type StudioBucket } from "./bucket.js";
import { emptyResearch, type ResearchSource } from "./youtube-research.js";
import type { YtDlp } from "./yt-dlp.js";
import { mergeResearch } from "./research-merge.js";
import { episodeWorkflowFor, episodeWorkflowForPlan } from "./run-control.js";
import type { ThumbnailRenderer } from "./thumbnail-render.js";
import type { CutMediaDeps } from "./cut-stages.js";
import { insertThumbnail, listThumbnails, replaceRenderThumbnails } from "./thumbnails-db.js";
import { productionVoice } from "./voice.js";
import {
  activeProductionStyle, episodeForRun, getEpisode, getProduction, latestEpisodeRevision, listEpisodes, productionBranding, productionChannels, productionForRun,
  productionHints, productionMusic, productionOwner, productionRnd, productionSources, replaceEpisodes, saveEpisodeRevision, saveProductionDocument,
  saveTrendReport, updateEpisodeRunId, type ProductionRecord, type StudioDb,
} from "./studio-db.js";

/** What `studio-catalog` needs from ag-go (GĐ2 whole-asset). */
export interface FootageCatalogSource {
  getCatalog(actAsUserId: string, body: { folderIds: string[]; usableOnly?: boolean; limit?: number; cursor?: string }): Promise<{ items: AgGoFootageVideo[]; nextCursor: string | null }>;
}

export interface StudioStageDeps {
  db: StudioDb;
  bucket: StudioBucket;
  footage: FootageCatalogSource;
  /** Callback to start one episode run; wired by the worker. */
  /** Starts an episode's run on `workflow` (the release that goes with the plan release spawning it). */
  startEpisodeRun(episodeId: string, workflow: string): Promise<{ runId: string }>;
  /** YouTube research (GĐ5); absent when no YouTube API key is configured. */
  research?: ResearchSource;
  /** Whether a run can still do work (wired by the worker); spawn-episodes will not delete an episode that renders. */
  isRunActive?: (runId: string) => boolean;
  /** Cuts thumbnail frames and draws their words (ffmpeg on this node); absent = no ffmpeg configured. */
  thumbnails?: ThumbnailRenderer;
  /** What the shot-cut stages need (ffmpeg, ag-go resolve, downloads); absent = this worker cannot run them. */
  media?: CutMediaDeps;
  /**
   * yt-dlp: the real numbers of the links the web research found, and the reference videos of the style step; absent
   * = not installed (research keeps the numbers Claude read, the style step is skipped and says why).
   */
  ytdlp?: YtDlp;
  /** False when downloading reference videos is switched off (`STUDIO_REFERENCE_DOWNLOADS=0`). Default on. */
  referenceDownloads?: boolean;
}

export const DEFAULT_CANVAS = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 } } as const;
/** ag-go `/footage/catalog` answers at most 500 videos a page (a larger `limit` is a 400). */
export const CATALOG_PAGE_SIZE = 500;
/** 20 pages = 10 000 videos, far above the 300 kept after the pre-filter. */
const MAX_CATALOG_PAGES = 20;

export function readInput<T>(request: StageRequest, workspaceDir: string, type: string, parse: (v: unknown) => T): T {
  const p = inputPath({ request, workspaceDir }, type);
  if (!p || !existsSync(p)) throw new HarnessError("NOT_FOUND", `stage ${request.stage_key} has no ${type} input`, { type });
  return parse(JSON.parse(readFileSync(p, "utf8")));
}
/** The timeline input of a stage, v3 (`timeline_v3`) or v4 (`timeline_v4`), as stored. */
export function readTimelineInput(request: StageRequest, workspaceDir: string): StoredTimeline {
  const type = STUDIO_TIMELINE_TYPES.find((t) => request.inputs.some((i) => i.type === t)) ?? STUDIO_TYPES.timeline;
  return readInput(request, workspaceDir, type, (v) => StoredTimelineSchema.parse(v));
}
export const readBrief = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.brief, (v) => StudioBriefSchema.parse(v));
export const readCatalog = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.catalog, (v) => StudioCatalogSchema.parse(v));
export const readSeed = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.seed, (v) => StudioSeedSchema.parse(v));

/** What research and the catalog work from: the seed of a research-first plan run, or the brief of an older one. */
interface PlanInputs {
  production_id: string; owner_user_id: string; folder_ids: string[]; aspect: StudioBrief["aspect"];
  title: string; description: string; goal: string; keywords: string[]; channels: ChannelRef[];
}
function readPlanInputs(r: StageRequest, ws: string): PlanInputs {
  const seedPath = inputPath({ request: r, workspaceDir: ws }, STUDIO_TYPES.seed);
  if (seedPath && existsSync(seedPath)) {
    const s = readSeed(r, ws);
    return {
      production_id: s.production_id, owner_user_id: s.owner_user_id, folder_ids: s.folder_ids, aspect: s.aspect, title: s.title,
      description: s.hints.description, goal: s.hints.goal, keywords: s.keywords, channels: s.channels,
    };
  }
  const b = readBrief(r, ws);
  return { ...b, channels: b.youtube_channels.map((url) => ({ url, role: "reference" as const })) };
}

/** What an episode's YouTube kit reads when the production has no trend report (research found nothing). */
const SKIPPED_TREND_REPORT: TrendReport = {
  schema_version: "studio.trend-report/v1", skipped: true, summary: "Không có dữ liệu nghiên cứu.",
  working_angles: [], title_patterns: [], hook_patterns: [], thumbnail_patterns: [],
  recommended_duration_s: null, posting_schedule: "", recommendations: [],
};

function requirePlanProduction(d: StudioStageDeps, runId: string): ProductionRecord {
  const p = productionForRun(d.db, runId);
  if (!p) throw new HarnessError("NOT_FOUND", `no production is linked to run ${runId}`, { run_id: runId });
  return p;
}

/**
 * The brief the planning reads: the seed's footage and frame, and the production's CURRENT R&D and branding (as
 * approved, or as a person edited them since: running this stage again re-reads them); with `withStyle`, its current
 * style too.
 */
async function finalizeBrief(d: StudioStageDeps, request: StageRequest, ctx: ExecutorContext, withStyle: boolean): Promise<void> {
  const seed = readSeed(request, ctx.workspaceDir);
  const p = requirePlanProduction(d, request.run_id);
  const rnd = productionRnd(p);
  const branding = productionBranding(p);
  if (!rnd || !branding) {
    throw new HarnessError("CONFIG_INVALID", "production chưa có R&D và branding đã duyệt", { production_id: p.id, rnd: !!rnd, branding: !!branding });
  }
  const brief = effectiveBrief({
    production_id: p.id, run_id: request.run_id, owner_user_id: seed.owner_user_id, title: p.title, folder_ids: seed.folder_ids,
    aspect: seed.aspect, canvas: seed.canvas, fps: seed.fps, language: seed.language, music: seed.music,
    youtube_channels: seed.channels.filter((c) => c.role === "reference").map((c) => c.url), keywords: seed.keywords,
  }, seed.hints, rnd);
  // whether the plan may narrate: read now, not frozen in the seed (the person may have declined since)
  const narration = productionVoice(p.voice).kind;
  brief.narration_voice = narration === "clone" ? "ready" : narration;
  writeOutput(ctx, "brief.json", toBuffer(StudioBriefSchema.parse(brief)));
  writeOutput(ctx, "rnd.json", toBuffer(rnd));
  writeOutput(ctx, "branding.json", toBuffer(branding));
  const style = withStyle ? activeProductionStyle(p) : null;
  if (style) writeOutput(ctx, "style.json", toBuffer(style));
}

export function writeOutput(ctx: ExecutorContext, name: string, body: string | Buffer): string {
  const path = join(ctx.workspaceDir, "output", name);
  mkdirSync(join(ctx.workspaceDir, "output"), { recursive: true });
  writeFileSync(path, body);
  return path;
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const toBuffer = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2), "utf8");

/** A file name from a title: ASCII, dashes, lower case (Vietnamese marks dropped). */
export function fileSlug(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "episode";
}

/**
 * The episode intake of `ag-studio-episode@1.1.0` and later (a shot-cut episode adds its sources): the brief with the
 * production's current R&D on top, the episode, and for the YouTube kit the production's branding (when it has one) and
 * its trend report (a skipped one when research found nothing) — read when the episode run starts, so later edits reach
 * later episodes.
 */
export function writeEpisodeIntake(d: Pick<StudioStageDeps, "db">, request: StageRequest, ctx: ExecutorContext): { brief: StudioBrief; episode: StudioEpisode } {
  const ep = episodeForRun(d.db, request.run_id);
  if (!ep) throw new HarnessError("NOT_FOUND", `no episode is linked to run ${request.run_id}`, { run_id: request.run_id });
  if (!ep.plan) throw new HarnessError("CONFIG_INVALID", `episode ${ep.id} has no plan`, { episode_id: ep.id });
  const episode = StudioEpisodeSchema.parse(JSON.parse(ep.plan));
  const prod = getProduction(d.db, episode.production_id);
  if (!prod) throw new HarnessError("NOT_FOUND", `production ${episode.production_id} not found`, {});
  const owner = productionOwner(d.db, prod);
  if (!owner) throw new HarnessError("CONFIG_INVALID", `production ${episode.production_id} has no owner`, {});
  const aspect = (prod.aspect ?? "16:9") as StudioBrief["aspect"];
  const hints = productionHints(prod);
  const brief = effectiveBrief({
    production_id: episode.production_id, run_id: request.run_id, owner_user_id: owner, title: prod.title,
    folder_ids: productionSources(d.db, episode.production_id), aspect, canvas: prod.canvas ? JSON.parse(prod.canvas) : DEFAULT_CANVAS[aspect],
    fps: 25, language: prod.language ?? "vi", music: productionMusic(prod),
    youtube_channels: productionChannels(prod).filter((c) => c.role === "reference").map((c) => c.url),
    keywords: prod.keywords ? (JSON.parse(prod.keywords) as string[]) : [],
  }, { ...hints, episode_target_seconds: hints.episode_target_seconds ?? episode.target_seconds, max_episodes: hints.max_episodes ?? 1 }, productionRnd(prod));
  writeOutput(ctx, "brief.json", toBuffer(brief));
  writeOutput(ctx, "episode.json", toBuffer(episode));
  const branding = productionBranding(prod);
  if (branding) writeOutput(ctx, "branding.json", toBuffer(branding));
  const trend = prod.trend_report ? TrendReportSchema.parse(JSON.parse(prod.trend_report)) : SKIPPED_TREND_REPORT;
  writeOutput(ctx, "trend-report.json", toBuffer(trend));
  return { brief, episode };
}

/** ag-go's AI description of each video, as the hints of a shot-cut episode. */
function assetHints(ids: string[], assets: Map<string, StudioCatalog["assets"][number]>): Record<string, AssetHints> {
  const out: Record<string, AssetHints> = {};
  for (const id of ids) {
    const a = assets.get(id);
    if (a) out[id] = { subjects: a.subjects, places: a.places, mood: a.mood, setting: a.setting, time_of_day: a.time_of_day, people_count: a.people_count, shot_variety: a.shot_variety, has_speech: a.has_speech };
  }
  return out;
}

/**
 * The episodes of an approved plan: their records (each with a snapshot of its plan and videos) and their runs. A retry
 * of the same plan run keeps the episodes it made and starts the runs still missing; any other episodes belong to an
 * earlier plan and are replaced, unless one is still producing.
 */
async function spawnEpisodes(d: StudioStageDeps, request: StageRequest, ctx: ExecutorContext, v2: boolean): Promise<void> {
  const ws = ctx.workspaceDir;
  const brief = readBrief(request, ws);
  const catalog = readCatalog(request, ws);
  const plan = readInput(request, ws, STUDIO_TYPES.seriesPlan, (v) => SeriesPlanSchema.parse(v));
  // Store the trend report in the production (if it was produced)
  const trendPath = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.trendReport);
  if (trendPath && existsSync(trendPath)) {
    const trendRaw = JSON.parse(readFileSync(trendPath, "utf8"));
    saveTrendReport(d.db, brief.production_id, trendRaw);
  }
  // Build asset lookup from catalog
  const assetMap = new Map(catalog.assets.map((a) => [a.asset_id, a]));
  // The episodes of this very plan run (a retry of this stage): keep them, start the runs still missing.
  // Any other episodes belong to an earlier plan: this plan replaces them, unless one is still producing.
  const existing = listEpisodes(d.db, brief.production_id);
  const { randomUUID } = await import("node:crypto");
  const episodeRows: { id: string; idx: number; title: string; hook: string; plan: string; edit_style: "whole" | "cut" }[] = [];
  const spawnedEpisodes: { episode_id: string; idx: number; run_id: string }[] = [];

  if (existing.length > 0 && existing.every((e) => e.plan_run_id === request.run_id)) {
    for (const e of existing) {
      let runId = e.run_id;
      if (!runId) {
        runId = (await d.startEpisodeRun(e.id, v2 ? episodeWorkflowFor(request.workflow.version, e.edit_style) : episodeWorkflowForPlan(request.workflow.version))).runId;
        updateEpisodeRunId(d.db, e.id, runId);
      }
      spawnedEpisodes.push({ episode_id: e.id, idx: e.idx, run_id: runId });
    }
  } else {
    const busy = existing.find((e) => e.run_id && d.isRunActive?.(e.run_id));
    if (busy) {
      throw new HarnessError("CONFIG_INVALID", `tập ${busy.idx} của kế hoạch cũ đang sản xuất; chờ xong hoặc huỷ rồi thử lại bước này`, { episode_id: busy.id });
    }
    for (const ep of plan.episodes) {
      // Build the StudioEpisode plan snapshot (assets from catalog)
      const episodeAssets: Record<string, { title: string; summary_vi: string; duration_s: number; orientation: string | null }> = {};
      for (const item of [...ep.items, ...(ep.alternates ?? [])]) {
        const a = assetMap.get(item.asset_id);
        if (a) episodeAssets[item.asset_id] = { title: a.title_vi || a.name, summary_vi: a.summary_vi, duration_s: a.duration_s, orientation: a.orientation };
      }
      const episodeId = randomUUID();
      const style = v2 && ep.edit_style === "cut" ? "cut" : "whole";
      episodeRows.push({
        id: episodeId, idx: ep.idx, title: ep.title, hook: ep.hook, edit_style: style,
        plan: JSON.stringify(StudioEpisodeSchema.parse({
          schema_version: "studio.episode/v1",
          production_id: brief.production_id, episode_id: episodeId,
          idx: ep.idx, title: ep.title, hook: ep.hook, logline: ep.logline,
          target_seconds: ep.target_seconds, items: ep.items, alternates: ep.alternates ?? [],
          texts_suggested: ep.texts_suggested ?? [], assets: episodeAssets,
          // v2: how the episode is edited, and for a shot-cut one ag-go's description of each video as a hint
          ...(v2 ? { edit_style: style } : {}),
          ...(style === "cut" ? { narration: ep.narration ?? "tts", asset_hints: assetHints(ep.items.map((i) => i.asset_id), assetMap) } : {}),
        })),
      });
    }
    replaceEpisodes(d.db, brief.production_id, episodeRows, request.run_id);
    // Start an episode run for each episode
    for (const row of episodeRows) {
      const { runId } = await d.startEpisodeRun(row.id, v2 ? episodeWorkflowFor(request.workflow.version, row.edit_style) : episodeWorkflowForPlan(request.workflow.version));
      updateEpisodeRunId(d.db, row.id, runId);
      const ep = plan.episodes.find((e) => e.idx === row.idx)!;
      spawnedEpisodes.push({ episode_id: row.id, idx: row.idx, run_id: runId });
      ctx.logger.info("episode spawned", { episode_id: row.id, idx: row.idx, run_id: runId });
      void ep; // used indirectly above
    }
  }
  const spawned = SpawnedEpisodesSchema.parse({
    schema_version: "studio.episodes/v1", production_id: brief.production_id, episodes: spawnedEpisodes,
  });
  writeOutput(ctx, "episodes.json", toBuffer(spawned));
}

export function studioStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return {

    // -------------------------------------------------------------------------
    // Plan-run stages
    // -------------------------------------------------------------------------

    "studio-series-intake": async (request, ctx) => {
      const p = productionForRun(d.db, request.run_id);
      if (!p) throw new HarnessError("NOT_FOUND", `no production is linked to run ${request.run_id}`, { run_id: request.run_id });
      const owner = productionOwner(d.db, p);
      if (!owner) throw new HarnessError("CONFIG_INVALID", `production ${p.id} has no owner`, { production_id: p.id });
      const folders = productionSources(d.db, p.id);
      if (!folders.length) throw new HarnessError("CONFIG_INVALID", "chọn ít nhất một folder nguồn trước khi chạy", { production_id: p.id });
      if (!p.episode_target_seconds) throw new HarnessError("CONFIG_INVALID", "đặt episode_target_seconds trước khi chạy", { production_id: p.id });
      if (!p.max_episodes) throw new HarnessError("CONFIG_INVALID", "đặt max_episodes trước khi chạy", { production_id: p.id });
      const aspect = (p.aspect ?? "16:9") as StudioBrief["aspect"];
      const brief = StudioBriefSchema.parse({
        schema_version: "studio.brief/v2",
        production_id: p.id, run_id: request.run_id, owner_user_id: owner,
        title: p.title,
        description: p.brief?.trim() || p.title,
        goal: p.goal ?? "",
        audience: p.audience ?? "",
        tone: p.tone ?? "",
        notes: p.notes ?? "",
        folder_ids: folders,
        episode_target_seconds: p.episode_target_seconds,
        max_episodes: p.max_episodes,
        aspect,
        canvas: p.canvas ? JSON.parse(p.canvas) : DEFAULT_CANVAS[aspect],
        fps: 25,
        language: p.language ?? "vi",
        music: productionMusic(p),
        youtube_channels: p.youtube_channels ? JSON.parse(p.youtube_channels) : [],
        keywords: p.keywords ? JSON.parse(p.keywords) : [],
      });
      writeOutput(ctx, "brief.json", toBuffer(brief));
    },

    "studio-research": async (request, ctx) => {
      const q = readPlanInputs(request, ctx.workspaceDir);
      const research = !q.channels.length && !q.keywords.length
        ? emptyResearch(q.production_id, "Chưa nhập kênh YouTube hoặc từ khoá")
        : d.research
          ? await d.research.research({ production_id: q.production_id, channels: q.channels, keywords: q.keywords })
          : emptyResearch(q.production_id, "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker");
      StudioResearchSchema.parse(research);
      writeOutput(ctx, "research.json", toBuffer(research));
      ctx.logger.info("research done", {
        quota_units: research.quota_units, skipped: research.skipped_reason,
        channel_errors: research.channels.filter((c) => c.error).length, keyword_errors: research.keywords.filter((k) => k.error).length,
      });
    },

    // plan 3.2.0: the API's research, with what it could not answer filled from the web (links Claude found, yt-dlp's numbers)
    "studio-research-merge": async (request, ctx) => {
      const q = readPlanInputs(request, ctx.workspaceDir);
      const api = readInput(request, ctx.workspaceDir, STUDIO_TYPES.researchApi, (v) => StudioResearchSchema.parse(v));
      const finds = readInput(request, ctx.workspaceDir, STUDIO_TYPES.webFinds, (v) => StudioWebFindsSchema.parse(v));
      const research = await mergeResearch({
        api, finds, query: { channels: q.channels, keywords: q.keywords }, ytdlp: d.ytdlp ?? null, now: new Date(ctx.clock.now()),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      StudioResearchSchema.parse(research);
      writeOutput(ctx, "research.json", toBuffer(research));
      ctx.logger.info("research merged", {
        source: research.source ?? "youtube_api", skipped: research.skipped_reason, ytdlp: !!d.ytdlp,
        estimated: [...research.channels.flatMap((c) => c.videos), ...research.keywords.flatMap((k) => k.videos)].filter((v) => v.estimated).length,
      });
    },

    "studio-catalog": async (request, ctx) => {
      const brief = readPlanInputs(request, ctx.workspaceDir);
      const items: AgGoFootageVideo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const res = await d.footage.getCatalog(brief.owner_user_id, {
          folderIds: brief.folder_ids, usableOnly: true, limit: CATALOG_PAGE_SIZE, ...(cursor ? { cursor } : {}),
        });
        items.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      const all = items.map(normalizeCatalogVideo);
      const { assets, truncated } = prefilterCatalog(
        all.filter((a) => a.usable && a.duration_s > 0 && orientationFits(a.orientation, brief.aspect)),
        brief,
      );
      if (!assets.length) throw new HarnessError("CONFIG_INVALID", "the chosen folders have no usable analysed footage for this frame", { folder_ids: brief.folder_ids });
      const catalog: StudioCatalog = StudioCatalogSchema.parse({
        schema_version: "studio.catalog/v2", production_id: brief.production_id,
        folder_ids: brief.folder_ids, total_available: all.length, truncated, assets,
      });
      ctx.logger.info("catalog built (v3)", { returned: all.length, kept: assets.length, truncated });
      writeOutput(ctx, "catalog.json", toBuffer(catalog));
    },

    // ---- Research first (ag-studio-series-plan@2.0.0) ----------------------

    /** `seed.json`: what the person gave (footage, own and reference channels, keywords, hints), frozen for the run. */
    "studio-series-seed": async (request, ctx) => {
      const p = requirePlanProduction(d, request.run_id);
      const owner = productionOwner(d.db, p);
      if (!owner) throw new HarnessError("CONFIG_INVALID", `production ${p.id} has no owner`, { production_id: p.id });
      const folders = productionSources(d.db, p.id);
      if (!folders.length) throw new HarnessError("CONFIG_INVALID", "chọn ít nhất một folder nguồn trước khi chạy", { production_id: p.id });
      const channels = productionChannels(p).slice(0, MAX_RESEARCH_CHANNELS);
      const keywords = p.keywords ? (JSON.parse(p.keywords) as string[]) : [];
      if (!channels.length && !keywords.length) {
        throw new HarnessError("CONFIG_INVALID", "nhập ít nhất một kênh YouTube hoặc một từ khoá để nghiên cứu", { production_id: p.id });
      }
      const aspect = (p.aspect ?? "16:9") as StudioBrief["aspect"];
      const seed = StudioSeedSchema.parse({
        schema_version: "studio.seed/v1", production_id: p.id, run_id: request.run_id, owner_user_id: owner, title: p.title,
        folder_ids: folders, channels, keywords, aspect, canvas: p.canvas ? JSON.parse(p.canvas) : DEFAULT_CANVAS[aspect], fps: 25,
        language: p.language ?? "vi", music: productionMusic(p), hints: productionHints(p),
      });
      writeOutput(ctx, "seed.json", toBuffer(seed));
    },

    /** The R&D the person approved becomes the production's (later AI steps read it from there). */
    "studio-apply-rnd": async (request, ctx) => {
      const rnd = readInput(request, ctx.workspaceDir, STUDIO_TYPES.rnd, (v) => StudioRndSchema.parse(v));
      const p = requirePlanProduction(d, request.run_id);
      saveProductionDocument(d.db, p.id, "rnd", rnd, `gate:${request.run_id}`);
      ctx.logger.info("approved R&D applied to the production", { production_id: p.id });
    },

    /** The branding the person approved becomes the production's. */
    "studio-apply-branding": async (request, ctx) => {
      const branding = readInput(request, ctx.workspaceDir, STUDIO_TYPES.branding, (v) => StudioBrandingSchema.parse(v));
      const p = requirePlanProduction(d, request.run_id);
      saveProductionDocument(d.db, p.id, "branding", branding, `gate:${request.run_id}`);
      ctx.logger.info("approved branding applied to the production", { production_id: p.id });
    },

    /** The brief the planning reads (`finalizeBrief`). */
    "studio-finalize-brief": async (request, ctx) => finalizeBrief(d, request, ctx, false),
    /** Plan 3.2.0: also the production's current style (`style.json`), when it has one that was not skipped. */
    "studio-finalize-brief-v2": async (request, ctx) => finalizeBrief(d, request, ctx, true),

    /** Plans 2.0.0 and 3.0.0: every episode whole videos on the plan's episode release. */
    "studio-spawn-episodes": async (request, ctx) => spawnEpisodes(d, request, ctx, false),
    /** Plan 3.1.0: each episode on the release of its edit style (`episodeWorkflowFor`), the style recorded. */
    "studio-spawn-episodes-v2": async (request, ctx) => spawnEpisodes(d, request, ctx, true),

    // -------------------------------------------------------------------------
    // Episode-run stages
    // -------------------------------------------------------------------------

    "episode-intake": async (request, ctx) => {
      const ep = episodeForRun(d.db, request.run_id);
      if (!ep) throw new HarnessError("NOT_FOUND", `no episode is linked to run ${request.run_id}`, { run_id: request.run_id });
      if (!ep.plan) throw new HarnessError("CONFIG_INVALID", `episode ${ep.id} has no plan`, { episode_id: ep.id });
      const episode = StudioEpisodeSchema.parse(JSON.parse(ep.plan));
      const prod = getProduction(d.db, episode.production_id);
      if (!prod) throw new HarnessError("NOT_FOUND", `production ${episode.production_id} not found`, {});
      const owner = productionOwner(d.db, prod);
      if (!owner) throw new HarnessError("CONFIG_INVALID", `production ${episode.production_id} has no owner`, {});
      const aspect = (prod.aspect ?? "16:9") as StudioBrief["aspect"];
      const brief = StudioBriefSchema.parse({
        schema_version: "studio.brief/v2",
        production_id: episode.production_id, run_id: request.run_id, owner_user_id: owner,
        title: prod.title, description: prod.brief?.trim() || prod.title,
        goal: prod.goal ?? "", audience: prod.audience ?? "", tone: prod.tone ?? "", notes: prod.notes ?? "",
        folder_ids: productionSources(d.db, episode.production_id),
        episode_target_seconds: prod.episode_target_seconds ?? episode.target_seconds,
        max_episodes: prod.max_episodes ?? 1,
        aspect, canvas: prod.canvas ? JSON.parse(prod.canvas) : DEFAULT_CANVAS[aspect],
        fps: 25, language: prod.language ?? "vi",
        music: productionMusic(prod),
        youtube_channels: prod.youtube_channels ? JSON.parse(prod.youtube_channels) : [],
        keywords: prod.keywords ? JSON.parse(prod.keywords) : [],
      });
      writeOutput(ctx, "brief.json", toBuffer(brief));
      writeOutput(ctx, "episode.json", toBuffer(episode));
    },

    /**
     * Episode intake of `ag-studio-episode@1.1.0`: the brief with the production's current R&D on top, and for the
     * YouTube kit the production's branding (when it has one) and its trend report (a skipped one when research
     * found nothing) — read when the episode run starts, so later edits reach later episodes.
     */
    "studio-episode-intake-v2": async (request, ctx) => {
      writeEpisodeIntake(d, request, ctx);
    },

    "build-timeline": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const episode = readInput(request, ws, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      if (!getEpisode(d.db, episode.episode_id)) throw new HarnessError("NOT_FOUND", `episode ${episode.episode_id} not found`, {});
      // The draft becomes revision 1, the editor's starting point; once a revision exists (a person edited, or
      // this run is a re-run) it is what the episode is, and the plan is not rebuilt over it.
      let latest = latestEpisodeRevision(d.db, episode.episode_id);
      if (!latest) {
        const draft = buildEpisodeTimeline({ brief, episode });
        saveEpisodeRevision(d.db, episode.episode_id, { baseRevision: 0, data: draft, authorId: "system", label: `build-timeline ${request.run_id}` });
        latest = latestEpisodeRevision(d.db, episode.episode_id)!;
      }
      writeOutput(ctx, "timeline.json", toBuffer(latest.data));
      ctx.logger.info("timeline ready", { revision: latest.revision, clips: latest.data.clips.length, episode_id: episode.episode_id });
    },

    /**
     * The timeline the render uses: the episode's LATEST revision at this moment, so whatever a person saved in the
     * editor (before this run got here, or before "Render lại") is what gets rendered. A timeline the render
     * cannot play fails here with the problems listed; the person fixes it in the editor and renders again.
     */
    "studio-freeze-timeline": async (request, ctx) => {
      const episode = readInput(request, ctx.workspaceDir, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const latest = latestEpisodeRevision(d.db, episode.episode_id);
      if (!latest) throw new HarnessError("NOT_FOUND", `episode ${episode.episode_id} has no timeline revision`, { episode_id: episode.episode_id });
      const errors = timelineIssues(latest.data).filter((i) => i.severity === "error");
      if (errors.length) {
        throw new HarnessError("SCHEMA_INVALID", `timeline revision ${latest.revision}: ${errors.map((e) => e.message).join("; ")}`, { revision: latest.revision, problems: errors });
      }
      writeOutput(ctx, "timeline.json", toBuffer(latest.data));
      ctx.logger.info("timeline frozen for the render", { revision: latest.revision, episode_id: episode.episode_id });
    },

    /**
     * Episode 1.3.0: the timeline the render uses is the one the person APPROVED at approve-timeline (its input), not
     * the latest revision: an edit made after approving is not rendered until it is approved too.
     */
    "studio-freeze-timeline-v2": async (request, ctx) => {
      const timeline = readTimelineInput(request, ctx.workspaceDir);
      const errors = timelineIssues(timeline).filter((i) => i.severity === "error");
      if (errors.length) {
        throw new HarnessError("SCHEMA_INVALID", `approved timeline: ${errors.map((e) => e.message).join("; ")}`, { problems: errors });
      }
      writeOutput(ctx, "timeline.json", toBuffer(timeline));
      ctx.logger.info("approved timeline frozen for the render", { episode_id: timeline.episode_id });
    },

    "studio-episode-export": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const episode = readInput(request, ws, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readTimelineInput(request, ws);
      const kitRaw = readInput(request, ws, STUDIO_TYPES.youtubeKit, parseStoredYoutubeKit);
      const videoPath = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.finalVideo);
      const manifest = readInput(request, ws, STUDIO_TYPES.renderManifest, (v) => v as { watermarked?: boolean; duration_s?: number; thumbnails?: unknown[] });
      if (!videoPath || !existsSync(videoPath)) throw new HarnessError("NOT_FOUND", "export has no final video input", {});

      // Resolve effective youtube kit: episodes.youtube override if set
      const ep = getEpisode(d.db, episode.episode_id);
      const effectiveKit = (ep?.youtube ? parseStoredYoutubeKit(JSON.parse(ep.youtube)) : kitRaw);
      const selectedTitle = ep?.selected_title ?? 0;
      const selectedThumb = ep?.selected_thumbnail ?? 0;

      const title = effectiveKit.titles[selectedTitle] ?? effectiveKit.titles[0]!;
      const altTitles = effectiveKit.titles.filter((_, i) => i !== selectedTitle);
      const layout = layoutTimeline(timeline);
      const chapters = youtubeChapters(layout);
      const chaptersText = chapters.length >= 3 ? formatChapters(chapters) : "";
      const descriptionBody = effectiveKit.description.slice(0, 4000);
      const fullDescription = chaptersText
        ? `${descriptionBody}\n\n${chaptersText}`.slice(0, 5000)
        : descriptionBody.slice(0, 5000);

      const prefix = `productions/${brief.production_id}/episodes/${episode.episode_id}/exports/${request.run_id}`;
      const videoSlug = fileSlug(title);
      const files: StudioExport["files"] = [];

      const upload = async (kind: StudioExport["files"][number]["kind"], name: string, body: Buffer, type: string) => {
        const key = `${prefix}/${name}`;
        await d.bucket.put(key, body, type);
        files.push({ kind, key, size_bytes: body.length, checksum: `sha256:${sha256(body)}` });
      };
      // The video and the pack are streamed from disk: an episode can be gigabytes.
      const uploadFile = async (kind: StudioExport["files"][number]["kind"], name: string, path: string, type: string) => {
        const key = `${prefix}/${name}`;
        await d.bucket.putFile(key, path, type);
        files.push({ kind, key, size_bytes: statSync(path).size, checksum: `sha256:${await sha256File(path)}` });
      };

      await uploadFile("mp4", `${videoSlug}.mp4`, videoPath, "video/mp4");

      // Thumbnails: all inputs of type `thumbnail` from the render stage
      // thumb-1..3 in order: the index a person picked must stay the same picture
      const thumbInputs = request.inputs.filter((x) => x.type === STUDIO_TYPES.thumbnail).sort((a, b) => a.path.localeCompare(b.path));
      const thumbFilesLocal = thumbInputs.map((t) => join(ws, t.path)).filter((p) => existsSync(p));
      for (let i = 0; i < thumbFilesLocal.length; i++) {
        await upload("thumbnail", `thumb-${i + 1}.jpg`, readFileSync(thumbFilesLocal[i]!), "image/jpeg");
      }

      // youtube.json
      const thumbFiles = files.filter((f) => f.kind === "thumbnail");
      const chosenThumbKey = thumbFiles[selectedThumb]?.key ?? thumbFiles[0]?.key ?? null;
      const youtubeDoc = StudioYoutubeSchema.parse({
        schema_version: "studio.youtube/v1",
        production_id: brief.production_id,
        episode_id: episode.episode_id,
        title,
        alt_titles: altTitles,
        description: fullDescription,
        tags: effectiveKit.tags,
        hashtags: effectiveKit.hashtags,
        playlist: effectiveKit.playlist,
        chapters: chapters.length >= 3 ? chapters : [],
        thumbnail_key: chosenThumbKey,
      });
      const youtubeBuf = toBuffer(youtubeDoc);
      await upload("youtube", "youtube.json", youtubeBuf, "application/json");

      // timeline.json
      await upload("timeline", "timeline.json", toBuffer(timeline), "application/json");

      // ZIP pack: mp4 + thumbnails + youtube.json + description.txt + tags.txt
      const packPath = join(ws, "output", `${videoSlug}-youtube.zip`);
      await writeZip(packPath, [
        { name: `${videoSlug}.mp4`, path: videoPath },
        ...thumbFilesLocal.map((t, i) => ({ name: `thumb-${i + 1}.jpg`, path: t })),
        { name: "youtube.json", data: youtubeBuf },
        { name: "description.txt", data: Buffer.from(fullDescription, "utf8") },
        { name: "tags.txt", data: Buffer.from(effectiveKit.tags.join("\n"), "utf8") },
      ]);
      await uploadFile("pack", `${videoSlug}-youtube.zip`, packPath, "application/zip");

      const exp: StudioExport = StudioExportSchema.parse({
        schema_version: "studio.export/v2",
        production_id: brief.production_id,
        episode_id: episode.episode_id,
        run_id: request.run_id,
        duration_seconds: (manifest as { duration_s?: number }).duration_s ?? layout.duration,
        files,
        watermarked: (manifest as { watermarked?: boolean }).watermarked === true,
      });
      writeOutput(ctx, "export.json", toBuffer(exp));
      writeOutput(ctx, "youtube.json", youtubeBuf);
      ctx.logger.info("episode export uploaded", {
        episode_id: episode.episode_id, files: files.map((f) => f.key), bytes: statSync(videoPath).size,
      });
    },

    // ---- Thumbnails cut from the final video (ag-studio-episode@1.2.0) --------------------------------------

    /**
     * Clean candidate frames of the final video (away from on-screen words and clip edges) and the YouTube kit's 3
     * suggestions drawn on them in the production's branding style. Files only: the export uploads and records them.
     */
    "studio-episode-thumbnails": async (request, ctx) => {
      if (!d.thumbnails) throw new HarnessError("CONFIG_INVALID", "Studio worker không có ffmpeg (STUDIO_FFMPEG_PATH) để cắt thumbnail", {});
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const episode = readInput(request, ws, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readTimelineInput(request, ws);
      const ep = getEpisode(d.db, episode.episode_id);
      const kit = ep?.youtube ? parseStoredYoutubeKit(JSON.parse(ep.youtube)) : readInput(request, ws, STUDIO_TYPES.youtubeKit, parseStoredYoutubeKit);
      const brandingPath = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.branding);
      const branding = brandingPath && existsSync(brandingPath) ? StudioBrandingSchema.parse(JSON.parse(readFileSync(brandingPath, "utf8"))) : null;
      const video = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.finalVideo);
      if (!video || !existsSync(video)) throw new HarnessError("NOT_FOUND", "thumbnails has no final video input", {});

      const size = THUMBNAIL_SIZES[brief.aspect];
      const layout = layoutTimeline(timeline);
      const times = frameCandidateTimes(layout, { kitAssetIds: kit.thumbnails.map((t) => t.asset_id) });
      const dir = join(ws, "output", "thumbnails");
      mkdirSync(dir, { recursive: true });
      const frames: StudioThumbnails["frames"] = [];
      for (const [i, t] of times.entries()) {
        const file = `frame-${String(i + 1).padStart(3, "0")}.jpg`;
        await d.thumbnails.extractFrame(video, t.t_s, join(dir, file), size);
        frames.push({ file, t_s: t.t_s, clip_id: t.clip_id, asset_id: t.asset_id });
      }
      const style = thumbnailStyle(branding);
      const suggestions: StudioThumbnails["suggestions"] = [];
      for (const [i, th] of kit.thumbnails.entries()) {
        const at = suggestionFrame(layout, times, th.asset_id) ?? times[i % Math.max(1, times.length)];
        const frame = at ? frames.find((f) => f.t_s === at.t_s) : undefined;
        if (!frame) continue;
        const file = `suggestion-${i + 1}.jpg`;
        await d.thumbnails.compose(join(dir, frame.file), join(dir, file), { lines: thumbnailTextLines(th.text, { ...size, style }), style, size });
        suggestions.push({ file, frame: frame.file, t_s: frame.t_s, asset_id: frame.asset_id, text: th.text, style });
      }
      const manifest = StudioThumbnailsSchema.parse({
        schema_version: "studio.thumbnails/v1", production_id: brief.production_id, episode_id: episode.episode_id, run_id: request.run_id,
        width: size.width, height: size.height, frames, suggestions,
      });
      writeOutput(ctx, "thumbnails.json", toBuffer(manifest));
      ctx.logger.info("thumbnails cut", { frames: frames.length, suggestions: suggestions.length, episode_id: episode.episode_id });
    },

    /**
     * Export of ag-studio-episode@1.2.0: the video, `youtube.json` and `timeline.json` in the bucket, the render's
     * frames and suggestions uploaded and recorded as the episode's thumbnails (the first suggestion is the pick
     * unless a person picked one). No zip: the YouTube pack is built when someone downloads it, from the latest kit
     * and pick.
     */
    "studio-episode-export-v2": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const episode = readInput(request, ws, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readTimelineInput(request, ws);
      const kitRaw = readInput(request, ws, STUDIO_TYPES.youtubeKit, parseStoredYoutubeKit);
      const thumbs = readInput(request, ws, STUDIO_TYPES.thumbnails, (v) => StudioThumbnailsSchema.parse(v));
      const thumbDir = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.thumbnailSet);
      const videoPath = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.finalVideo);
      const manifest = readInput(request, ws, STUDIO_TYPES.renderManifest, (v) => v as { watermarked?: boolean; duration_s?: number });
      if (!videoPath || !existsSync(videoPath)) throw new HarnessError("NOT_FOUND", "export has no final video input", {});
      if (!thumbDir || !existsSync(thumbDir)) throw new HarnessError("NOT_FOUND", "export has no thumbnails input", {});

      const ep = getEpisode(d.db, episode.episode_id);
      const kit = ep?.youtube ? parseStoredYoutubeKit(JSON.parse(ep.youtube)) : kitRaw;
      const selectedTitle = ep?.selected_title ?? 0;
      const title = kit.titles[selectedTitle] ?? kit.titles[0]!;
      const layout = layoutTimeline(timeline);
      const chapters = youtubeChapters(layout);
      const chaptersText = chapters.length >= 3 ? formatChapters(chapters) : "";
      const body = kit.description.slice(0, 4000);
      const description = (chaptersText ? `${body}\n\n${chaptersText}` : body).slice(0, 5000);

      const prefix = `productions/${brief.production_id}/episodes/${episode.episode_id}`;
      const files: StudioExport["files"] = [];
      const upload = async (kind: StudioExport["files"][number]["kind"], key: string, data: Buffer, type: string) => {
        await d.bucket.put(key, data, type);
        files.push({ kind, key, size_bytes: data.length, checksum: `sha256:${sha256(data)}` });
      };
      const videoKey = `${prefix}/exports/${request.run_id}/${fileSlug(title)}.mp4`;
      await d.bucket.putFile(videoKey, videoPath, "video/mp4");
      files.push({ kind: "mp4", key: videoKey, size_bytes: statSync(videoPath).size, checksum: `sha256:${await sha256File(videoPath)}` });

      // Thumbnails: frames, then suggestions over them (each recorded once: the image key is unique)
      const thumbPrefix = `${prefix}/thumbnails/${request.run_id}`;
      const frameKeys = new Map<string, string>();
      for (const f of thumbs.frames) {
        const data = readFileSync(join(thumbDir, f.file));
        const key = `${thumbPrefix}/${f.file}`;
        await d.bucket.put(key, data, "image/jpeg");
        frameKeys.set(f.file, key);
        insertThumbnail(d.db, {
          episode_id: episode.episode_id, kind: "frame", source_run_id: request.run_id, parent_id: null, t_s: f.t_s, asset_id: f.asset_id,
          base_key: key, image_key: key, text: null, style: null, width: thumbs.width, height: thumbs.height, size_bytes: data.length, created_by: "system",
        });
      }
      const suggestionIds: string[] = [];
      for (const sug of thumbs.suggestions) {
        const data = readFileSync(join(thumbDir, sug.file));
        const key = `${thumbPrefix}/${sug.file}`;
        await upload("thumbnail", key, data, "image/jpeg");
        const row = insertThumbnail(d.db, {
          episode_id: episode.episode_id, kind: "suggestion", source_run_id: request.run_id, parent_id: null, t_s: sug.t_s, asset_id: sug.asset_id,
          base_key: frameKeys.get(sug.frame) ?? null, image_key: key, text: sug.text, style: sug.style,
          width: thumbs.width, height: thumbs.height, size_bytes: data.length, created_by: "system",
        });
        suggestionIds.push(row.id);
      }
      replaceRenderThumbnails(d.db, episode.episode_id, request.run_id, suggestionIds[0] ?? null);
      const picked = listThumbnails(d.db, episode.episode_id).find((t) => t.id === getEpisode(d.db, episode.episode_id)?.selected_thumbnail_id);

      const youtubeDoc = StudioYoutubeSchema.parse({
        schema_version: "studio.youtube/v1", production_id: brief.production_id, episode_id: episode.episode_id,
        title, alt_titles: kit.titles.filter((_, i) => i !== selectedTitle), description, tags: kit.tags, hashtags: kit.hashtags,
        playlist: kit.playlist, chapters: chapters.length >= 3 ? chapters : [], thumbnail_key: picked?.image_key ?? null,
      });
      const youtubeBuf = toBuffer(youtubeDoc);
      await upload("youtube", `${prefix}/exports/${request.run_id}/youtube.json`, youtubeBuf, "application/json");
      await upload("timeline", `${prefix}/exports/${request.run_id}/timeline.json`, toBuffer(timeline), "application/json");

      const exp: StudioExport = StudioExportSchema.parse({
        schema_version: "studio.export/v2", production_id: brief.production_id, episode_id: episode.episode_id, run_id: request.run_id,
        duration_seconds: manifest.duration_s ?? layout.duration, files, watermarked: manifest.watermarked === true,
      });
      writeOutput(ctx, "export.json", toBuffer(exp));
      writeOutput(ctx, "youtube.json", youtubeBuf);
      ctx.logger.info("episode export uploaded", { episode_id: episode.episode_id, frames: thumbs.frames.length, suggestions: thumbs.suggestions.length });
    },
  };
}

/** Zip64-capable archive written straight to `dest`: files are streamed (the video is stored, not re-compressed). */
async function writeZip(dest: string, entries: ({ name: string; path: string } | { name: string; data: Buffer })[]): Promise<void> {
  const zip = new JSZip.ZipFile();
  for (const e of entries) {
    if ("path" in e) zip.addFile(e.path, e.name, { mtime: new Date(0), compress: false });
    else zip.addBuffer(e.data, e.name, { mtime: new Date(0) });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(dest));
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
