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
  HarnessError, SeriesPlanSchema, SpawnedEpisodesSchema, StudioBriefSchema, StudioCatalogSchema,
  StudioEpisodeSchema, StudioExportSchema, StudioResearchSchema, StudioYoutubeSchema, TimelineV3Schema, parseStoredYoutubeKit,
  type ExecutorContext, type StageRequest, type StudioBrief, type StudioCatalog, type StudioExport,
  type StudioEpisode,
} from "@harness/contracts";
import {
  buildEpisodeTimeline, formatChapters, inputPath, layoutTimeline, normalizeCatalogVideo,
  orientationFits, prefilterCatalog, STUDIO_TYPES, timelineIssues, youtubeChapters, type AgGoFootageVideo,
} from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { productionKey, type StudioBucket } from "./bucket.js";
import { emptyResearch, researchQueryOfBrief, type ResearchSource } from "./youtube-research.js";
import {
  episodeForRun, getEpisode, getProduction, latestEpisodeRevision, listEpisodes, productionForRun, productionOwner, productionSources,
  replaceEpisodes, saveEpisodeRevision, saveTrendReport, updateEpisodeRunId, type StudioDb,
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
  startEpisodeRun(episodeId: string): Promise<{ runId: string }>;
  /** YouTube research (GĐ5); absent when no YouTube API key is configured. */
  research?: ResearchSource;
  /** Whether a run can still do work (wired by the worker); spawn-episodes will not delete an episode that renders. */
  isRunActive?: (runId: string) => boolean;
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
export const readBrief = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.brief, (v) => StudioBriefSchema.parse(v));
export const readCatalog = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.catalog, (v) => StudioCatalogSchema.parse(v));

function writeOutput(ctx: ExecutorContext, name: string, body: string | Buffer): string {
  const path = join(ctx.workspaceDir, "output", name);
  mkdirSync(join(ctx.workspaceDir, "output"), { recursive: true });
  writeFileSync(path, body);
  return path;
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const toBuffer = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2), "utf8");

function slug(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "episode";
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
        music: p.music ? JSON.parse(p.music) : null,
        youtube_channels: p.youtube_channels ? JSON.parse(p.youtube_channels) : [],
        keywords: p.keywords ? JSON.parse(p.keywords) : [],
      });
      writeOutput(ctx, "brief.json", toBuffer(brief));
    },

    "studio-research": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const research = !brief.youtube_channels.length && !brief.keywords.length
        ? emptyResearch(brief.production_id, "Chưa nhập kênh YouTube hoặc từ khoá")
        : d.research
          ? await d.research.research(researchQueryOfBrief(brief))
          : emptyResearch(brief.production_id, "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker");
      StudioResearchSchema.parse(research);
      writeOutput(ctx, "research.json", toBuffer(research));
      ctx.logger.info("research done", {
        quota_units: research.quota_units, skipped: research.skipped_reason,
        channel_errors: research.channels.filter((c) => c.error).length, keyword_errors: research.keywords.filter((k) => k.error).length,
      });
    },

    "studio-catalog": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
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

    "studio-spawn-episodes": async (request, ctx) => {
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
      const episodeRows: { id: string; idx: number; title: string; hook: string; plan: string }[] = [];
      const spawnedEpisodes: { episode_id: string; idx: number; run_id: string }[] = [];

      if (existing.length > 0 && existing.every((e) => e.plan_run_id === request.run_id)) {
        for (const e of existing) {
          let runId = e.run_id;
          if (!runId) {
            runId = (await d.startEpisodeRun(e.id)).runId;
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
          episodeRows.push({
            id: episodeId, idx: ep.idx, title: ep.title, hook: ep.hook,
            plan: JSON.stringify(StudioEpisodeSchema.parse({
              schema_version: "studio.episode/v1",
              production_id: brief.production_id, episode_id: episodeId,
              idx: ep.idx, title: ep.title, hook: ep.hook, logline: ep.logline,
              target_seconds: ep.target_seconds, items: ep.items, alternates: ep.alternates ?? [],
              texts_suggested: ep.texts_suggested ?? [], assets: episodeAssets,
            })),
          });
        }
        replaceEpisodes(d.db, brief.production_id, episodeRows, request.run_id);
        // Start an episode run for each episode
        for (const row of episodeRows) {
          const { runId } = await d.startEpisodeRun(row.id);
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
    },

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
        music: prod.music ? JSON.parse(prod.music) : null,
        youtube_channels: prod.youtube_channels ? JSON.parse(prod.youtube_channels) : [],
        keywords: prod.keywords ? JSON.parse(prod.keywords) : [],
      });
      writeOutput(ctx, "brief.json", toBuffer(brief));
      writeOutput(ctx, "episode.json", toBuffer(episode));
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

    "studio-episode-export": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const episode = readInput(request, ws, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readInput(request, ws, STUDIO_TYPES.timeline, (v) => TimelineV3Schema.parse(v));
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
      const videoSlug = slug(title);
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
