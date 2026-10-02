/**
 * What a person does with an episode's thumbnails (API): draw words on a picture (and see it first), capture any
 * moment of the final video, upload a picture, cut the frames of an episode rendered before 1.2.0, and the YouTube
 * pack — a zip built from the latest kit, title and pick when someone downloads it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "yazl";
import {
  readStoredYoutubeKit, StudioYoutubeSchema, THUMBNAIL_SIZES, THUMBNAIL_TEXT_MAX, ThumbnailStyleSchema, TimelineV3Schema,
  type StudioExport, type ThumbnailStyle, type TimelineV3, type YoutubeKit,
} from "@harness/contracts";
import { formatChapters, frameCandidateTimes, layoutTimeline, thumbnailTextLines, youtubeChapters } from "@harness/core";
import type { StudioBucket } from "./bucket.js";
import type { StudioEngineCore } from "./core.js";
import { episodeExport, EPISODE_RENDER_STAGE, readStageDocument, stageArtifactPath, StudioRunError } from "./run-control.js";
import { fileSlug } from "./stages.js";
import { getProduction, type EpisodeRecord, type StudioDb } from "./studio-db.js";
import type { ThumbnailRenderer, ThumbnailSize } from "./thumbnail-render.js";
import {
  backfillExportThumbnails, insertThumbnail, listThumbnails, requireThumbnail, selectedThumbnail, type EpisodeThumbnail,
} from "./thumbnails-db.js";

export interface ThumbnailActionDeps {
  core: StudioEngineCore;
  db: StudioDb;
  bucket: StudioBucket;
  /** Signed URL lifetime when ffmpeg reads the final video from the bucket (no local copy). */
  urlTtlSeconds?: number;
}

/** Words drawn on a picture: what the person typed and how it looks. */
export interface ThumbnailWords { baseId: string; text: string; style: ThumbnailStyle }

/** The thumbnail size of the episode's production (16:9 unless it is vertical). */
export function thumbnailSizeOf(db: StudioDb, ep: Pick<EpisodeRecord, "production_id">): ThumbnailSize {
  return THUMBNAIL_SIZES[getProduction(db, ep.production_id)?.aspect === "9:16" ? "9:16" : "16:9"];
}

/** Every thumbnail of the episode; an episode exported before 1.2.0 gets its 3 old pictures as rows first. */
export function episodeThumbnails(d: ThumbnailActionDeps, ep: EpisodeRecord): EpisodeThumbnail[] {
  backfillExportThumbnails(d.db, ep, episodeExport(d.core, ep), thumbnailSizeOf(d.db, ep));
  return listThumbnails(d.db, ep.id);
}

/** The kit the episode uses: the person's edits, else Claude's of the current run. */
export function episodeKit(core: StudioEngineCore, ep: EpisodeRecord): YoutubeKit | null {
  if (ep.youtube) return readStoredYoutubeKit(JSON.parse(ep.youtube));
  if (!ep.run_id) return null;
  try { return readStoredYoutubeKit(readStageDocument(core, ep.run_id, "youtube-kit", "youtube-kit.json")); } catch { return null; }
}

const userKey = (ep: EpisodeRecord, id: string) => `productions/${ep.production_id}/episodes/${ep.id}/thumbnails/mine/${id}.jpg`;

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "studio-thumb-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function requireExport(core: StudioEngineCore, ep: EpisodeRecord): StudioExport {
  const exp = episodeExport(core, ep);
  if (!exp) throw new StudioRunError("conflict", "tập chưa có video final", { code: "no_final_video" });
  return exp;
}

/** The timeline the final video was rendered from (kept with the export). */
async function renderedTimeline(d: ThumbnailActionDeps, exp: StudioExport): Promise<TimelineV3> {
  const f = exp.files.find((x) => x.kind === "timeline");
  if (!f) throw new StudioRunError("conflict", "bản export không có timeline", { code: "no_timeline" });
  return TimelineV3Schema.parse(JSON.parse((await d.bucket.get(f.key)).toString("utf8")));
}

/** The final video for ffmpeg: the render's copy on this machine, else a short-lived URL of the exported one. */
async function finalVideo(d: ThumbnailActionDeps, ep: EpisodeRecord, exp: StudioExport): Promise<string> {
  const local = ep.run_id ? stageArtifactPath(d.core, ep.run_id, EPISODE_RENDER_STAGE, "final.mp4") : null;
  if (local && existsSync(local)) return local;
  const mp4 = exp.files.find((x) => x.kind === "mp4");
  if (!mp4) throw new StudioRunError("conflict", "bản export không có video", { code: "no_final_video" });
  return d.bucket.signedGetUrl(mp4.key, d.urlTtlSeconds ?? 3600);
}

function checkWords(p: ThumbnailWords): { text: string; style: ThumbnailStyle } {
  const text = p.text.trim();
  if (!text || [...text].length > THUMBNAIL_TEXT_MAX) {
    throw new StudioRunError("invalid", `chữ trên thumbnail cần 1–${THUMBNAIL_TEXT_MAX} ký tự`, { code: "text_length" });
  }
  const style = ThumbnailStyleSchema.safeParse(p.style);
  if (!style.success) throw new StudioRunError("invalid", "kiểu chữ không hợp lệ", { code: "style_invalid" });
  return { text, style: style.data };
}

/** Draw the words on the clean picture under `baseId` (a suggestion's frame, never its drawn words) into `out`. */
async function drawWords(
  d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord, p: ThumbnailWords, size: ThumbnailSize, dir: string,
): Promise<{ base: EpisodeThumbnail; baseKey: string; text: string; style: ThumbnailStyle; out: string }> {
  const { text, style } = checkWords(p);
  const base = requireThumbnail(d.db, ep.id, p.baseId);
  const baseKey = base.base_key ?? base.image_key;
  const basePath = join(dir, "base.jpg");
  writeFileSync(basePath, await d.bucket.get(baseKey));
  const out = join(dir, "out.jpg");
  await renderer.compose(basePath, out, { lines: thumbnailTextLines(text, { ...size, style }), style, size });
  return { base, baseKey, text, style, out };
}

/** How the words would look, at half size (the layout scales with the picture, so it matches the saved one). */
export async function previewThumbnail(d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord, p: ThumbnailWords): Promise<Buffer> {
  const full = thumbnailSizeOf(d.db, ep);
  const size = { width: full.width / 2, height: full.height / 2 };
  return inTemp(async (dir) => readFileSync((await drawWords(d, renderer, ep, p, size, dir)).out));
}

/** The words drawn on the picture, kept as a new picture of the person's. */
export async function composeThumbnail(
  d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord, p: ThumbnailWords, userId: string,
): Promise<EpisodeThumbnail> {
  const size = thumbnailSizeOf(d.db, ep);
  return inTemp(async (dir) => {
    const w = await drawWords(d, renderer, ep, p, size, dir);
    const id = randomUUID();
    const data = readFileSync(w.out);
    await d.bucket.put(userKey(ep, id), data, "image/jpeg");
    return insertThumbnail(d.db, {
      id, episode_id: ep.id, kind: "composed", source_run_id: w.base.source_run_id, parent_id: w.base.id, t_s: w.base.t_s,
      asset_id: w.base.asset_id, base_key: w.baseKey, image_key: userKey(ep, id), text: w.text, style: w.style,
      width: size.width, height: size.height, size_bytes: data.length, created_by: userId,
    });
  });
}

/** A clean frame of the final video at `t_s`, kept as the person's (a new render keeps it). */
export async function captureThumbnail(
  d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord, t_s: number, userId: string,
): Promise<EpisodeThumbnail> {
  const exp = requireExport(d.core, ep);
  const layout = layoutTimeline(await renderedTimeline(d, exp));
  const at = Math.round(Math.min(Math.max(0, t_s), Math.max(0, layout.duration - 0.05)) * 1000) / 1000;
  const clip = layout.clips.find((c) => at >= c.start && at < c.end) ?? null;
  const size = thumbnailSizeOf(d.db, ep);
  const video = await finalVideo(d, ep, exp);
  return inTemp(async (dir) => {
    const out = join(dir, "frame.jpg");
    await renderer.extractFrame(video, at, out, size);
    const id = randomUUID();
    const data = readFileSync(out);
    await d.bucket.put(userKey(ep, id), data, "image/jpeg");
    return insertThumbnail(d.db, {
      id, episode_id: ep.id, kind: "frame", source_run_id: exp.run_id, parent_id: null, t_s: at, asset_id: clip?.asset_id ?? null,
      base_key: userKey(ep, id), image_key: userKey(ep, id), text: null, style: null,
      width: size.width, height: size.height, size_bytes: data.length, created_by: userId,
    });
  });
}

/** A picture the person brings (JPEG/PNG/WebP), filled to the thumbnail size as a JPEG of at most 2 MB. */
export async function uploadThumbnail(
  d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord, data: Buffer, userId: string,
  kind: "upload" | "canva" = "upload", parentId: string | null = null,
): Promise<EpisodeThumbnail> {
  const size = thumbnailSizeOf(d.db, ep);
  return inTemp(async (dir) => {
    const input = join(dir, "in");
    const out = join(dir, "out.jpg");
    writeFileSync(input, data);
    await renderer.normalize(input, out, size);
    const id = randomUUID();
    const jpeg = readFileSync(out);
    await d.bucket.put(userKey(ep, id), jpeg, "image/jpeg");
    return insertThumbnail(d.db, {
      id, episode_id: ep.id, kind, source_run_id: null, parent_id: parentId, t_s: null, asset_id: null,
      base_key: userKey(ep, id), image_key: userKey(ep, id), text: null, style: null,
      width: size.width, height: size.height, size_bytes: jpeg.length, created_by: userId,
    });
  });
}

/**
 * Clean frames for an episode rendered before 1.2.0 (its render drew no frame): the same moments the `thumbnails`
 * stage picks, from the exported video. Nothing when the current render already has them. Returns how many were cut.
 */
export async function cutEpisodeFrames(d: ThumbnailActionDeps, renderer: ThumbnailRenderer, ep: EpisodeRecord): Promise<number> {
  const exp = requireExport(d.core, ep);
  if (episodeThumbnails(d, ep).some((t) => t.kind === "frame" && t.created_by === "system" && t.source_run_id === exp.run_id)) return 0;
  const layout = layoutTimeline(await renderedTimeline(d, exp));
  const kit = episodeKit(d.core, ep);
  const times = frameCandidateTimes(layout, { kitAssetIds: kit?.thumbnails.map((t) => t.asset_id) ?? [] });
  const size = thumbnailSizeOf(d.db, ep);
  const video = await finalVideo(d, ep, exp);
  const prefix = `productions/${ep.production_id}/episodes/${ep.id}/thumbnails/${exp.run_id}`;
  return inTemp(async (dir) => {
    for (const [i, t] of times.entries()) {
      const file = `frame-${String(i + 1).padStart(3, "0")}.jpg`;
      await renderer.extractFrame(video, t.t_s, join(dir, file), size);
      const data = readFileSync(join(dir, file));
      await d.bucket.put(`${prefix}/${file}`, data, "image/jpeg");
      insertThumbnail(d.db, {
        episode_id: ep.id, kind: "frame", source_run_id: exp.run_id, parent_id: null, t_s: t.t_s, asset_id: t.asset_id,
        base_key: `${prefix}/${file}`, image_key: `${prefix}/${file}`, text: null, style: null,
        width: size.width, height: size.height, size_bytes: data.length, created_by: "system",
      });
    }
    return times.length;
  });
}

function zipBuffers(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
  const zip = new JSZip.ZipFile();
  // stored: the picture is a JPEG already and the texts are small
  for (const e of entries) zip.addBuffer(e.data, e.name, { mtime: new Date(0), compress: false });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
  });
}

/**
 * The YouTube pack of the episode as it is now: the picked thumbnail, `youtube.json`, `title.txt`,
 * `description.txt` (with the chapters of the rendered video) and `tags.txt` — no video (downloaded on its own).
 * Stored once per content, so downloading twice uploads nothing new.
 */
export async function buildYoutubePack(d: ThumbnailActionDeps, ep: EpisodeRecord): Promise<{ key: string; name: string; size_bytes: number }> {
  const exp = requireExport(d.core, ep);
  const kit = episodeKit(d.core, ep);
  if (!kit) throw new StudioRunError("conflict", "tập chưa có gói YouTube", { code: "no_youtube_kit" });
  const selected = ep.selected_title ?? 0;
  const title = kit.titles[selected] ?? kit.titles[0]!;
  const chapters = youtubeChapters(layoutTimeline(await renderedTimeline(d, exp)));
  const body = kit.description.slice(0, 4000);
  const description = (chapters.length >= 3 ? `${body}\n\n${formatChapters(chapters)}` : body).slice(0, 5000);
  episodeThumbnails(d, ep);
  const picked = selectedThumbnail(d.db, ep);
  const youtube = StudioYoutubeSchema.parse({
    schema_version: "studio.youtube/v1", production_id: ep.production_id, episode_id: ep.id, title,
    alt_titles: kit.titles.filter((_, i) => i !== selected), description, tags: kit.tags, hashtags: kit.hashtags, playlist: kit.playlist,
    chapters: chapters.length >= 3 ? chapters : [], thumbnail_key: picked?.image_key ?? null,
  });
  const zip = await zipBuffers([
    ...(picked ? [{ name: "thumbnail.jpg", data: await d.bucket.get(picked.image_key) }] : []),
    { name: "youtube.json", data: Buffer.from(JSON.stringify(youtube, null, 2), "utf8") },
    { name: "title.txt", data: Buffer.from(title, "utf8") },
    { name: "description.txt", data: Buffer.from(description, "utf8") },
    { name: "tags.txt", data: Buffer.from(kit.tags.join("\n"), "utf8") },
  ]);
  const key = `productions/${ep.production_id}/episodes/${ep.id}/packs/${createHash("sha256").update(zip).digest("hex").slice(0, 24)}.zip`;
  if (!(await d.bucket.exists(key))) await d.bucket.put(key, zip, "application/zip");
  return { key, name: `${fileSlug(title)}-youtube.zip`, size_bytes: zip.length };
}
