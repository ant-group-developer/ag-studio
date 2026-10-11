/**
 * Thumbnails of a project's video (spec 2026-10-10 agent-workspace §P6, job `thumbnail`): a frame cut from the video's
 * latest render (the final one when there is one, else the preview) with words drawn on it in the branding's look,
 * written to `videos/<id>/thumbnails/NN.jpg` with a README the agent and people read (and may ask to redo).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THUMBNAIL_SIZES, ThumbnailStyleSchema, type ThumbnailStyle } from "@harness/contracts";
import { thumbnailTextLines } from "@harness/core";
import type { StudioBucket } from "../bucket.js";
import type { StudioDb } from "../studio-db.js";
import type { ThumbnailRenderer } from "../thumbnail-render.js";
import { writeWorkspaceFile } from "./files.js";
import { readFrontmatter } from "./frontmatter.js";
import type { JobHandler } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import { requireProject, requireVideo } from "./project-db.js";
import { videoRenders } from "./renders.js";

export interface ThumbnailItem { text: string; at_seconds?: number | undefined }
/** `request` of a `thumbnail` job. */
export interface ThumbnailJobRequest { video_id: string; items: ThumbnailItem[]; style?: Partial<ThumbnailStyle> }

export const thumbnailsDir = (videoId: string) => `videos/${videoId}/thumbnails`;

/** How the words look, from the branding (`thumbnail` and `text_look` in `channel/branding.md`), with what was asked on top. */
export function thumbnailStyleOf(dir: string, over: Partial<ThumbnailStyle> = {}): ThumbnailStyle {
  const path = join(dir, "channel", "branding.md");
  const fm = existsSync(path) ? (readFrontmatter(readFileSync(path, "utf8")).data as Record<string, unknown>) : {};
  const look = (fm.text_look ?? {}) as { text_color?: string; outline_color?: string; box_color?: string | null };
  const thumb = (fm.thumbnail ?? {}) as { position?: string; text_case?: string };
  const base = {
    position: ["top", "center", "bottom", "left", "right"].includes(thumb.position ?? "") ? thumb.position : "bottom",
    size: "l", text_color: look.text_color ?? "#FFFFFF", outline_color: look.outline_color ?? "#000000", box_color: look.box_color ?? null,
    uppercase: thumb.text_case !== "sentence",
  };
  const parsed = ThumbnailStyleSchema.safeParse({ ...base, ...over });
  return parsed.success ? parsed.data : ThumbnailStyleSchema.parse(base);
}

export function queueThumbnails(db: StudioDb, p: {
  projectId: string; videoId: string; items: ThumbnailItem[]; style?: Partial<ThumbnailStyle>; threadId?: string | null; continueAgent?: boolean;
  createdBy: string; actorRole?: JobRecord["actor_role"];
}, now = new Date().toISOString()): JobRecord {
  const v = requireVideo(db, p.videoId);
  const request: ThumbnailJobRequest = { video_id: v.id, items: p.items.slice(0, 3), ...(p.style ? { style: p.style } : {}) };
  return createJob(db, {
    projectId: p.projectId, videoId: v.id, threadId: p.threadId ?? null, kind: "thumbnail", title: `Thumbnail: ${v.title}`, request,
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

export function thumbnailHandler(d: { db: StudioDb; bucket: StudioBucket; renderer: ThumbnailRenderer }): JobHandler {
  return async (job, ctx) => {
    const req = JSON.parse(job.request) as ThumbnailJobRequest;
    const video = requireVideo(d.db, req.video_id);
    const project = requireProject(d.db, job.project_id);
    const renders = videoRenders(d.db, project.id, video.id).filter((r) => r.kind !== "export_premiere");
    const source = renders.find((r) => r.kind === "render_final") ?? renders[0];
    if (!source) throw new Error("cần một bản render (xem trước hoặc bản cuối) để cắt khung: render_preview trước");
    ctx.report({ phase: "Đang lấy bản render", progress: 0.1 });
    const mp4 = join(ctx.tempDir, "video.mp4");
    writeFileSync(mp4, await d.bucket.get(source.key));
    const size = THUMBNAIL_SIZES[project.aspect];
    const style = thumbnailStyleOf(ctx.workspaceDir, req.style);
    const outDir = join(ctx.workspaceDir, thumbnailsDir(video.id));
    mkdirSync(outDir, { recursive: true });
    const taken = new Set(readdirSync(outDir));
    const made: { file: string; text: string; at: number }[] = [];
    for (const [i, item] of req.items.entries()) {
      ctx.checkpoint();
      ctx.report({ phase: `Đang làm thumbnail ${i + 1}/${req.items.length}`, progress: 0.2 + 0.7 * (i / req.items.length) });
      const at = Math.max(0, Math.min(item.at_seconds ?? (source.duration_s ?? 10) * (0.25 + 0.25 * i), Math.max(0, (source.duration_s ?? 1) - 0.1)));
      const frame = join(ctx.tempDir, `frame-${i}.jpg`);
      await d.renderer.extractFrame(mp4, at, frame, size);
      let n = 1;
      while (taken.has(`${String(n).padStart(2, "0")}.jpg`)) n += 1;
      const name = `${String(n).padStart(2, "0")}.jpg`;
      taken.add(name);
      const out = join(ctx.tempDir, name);
      await d.renderer.compose(frame, out, { lines: thumbnailTextLines(item.text, { ...size, style }), style, size });
      writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: `${thumbnailsDir(video.id)}/${name}`, content: readFileSync(out), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
      made.push({ file: name, text: item.text, at });
    }
    const readmePath = `${thumbnailsDir(video.id)}/README.md`;
    const old = existsSync(join(ctx.workspaceDir, readmePath)) ? readFileSync(join(ctx.workspaceDir, readmePath), "utf8").replace(/\s+$/, "") : `# Thumbnail · ${video.title}\n\nẢnh ${size.width}×${size.height}, chữ theo branding. Mở ảnh để xem; nhờ agent làm lại với chữ hoặc khung khác.\n`;
    const rows = made.map((m) => `- \`${m.file}\`: "${m.text}" · khung ở giây ${m.at.toFixed(1)} của ${source.kind === "render_final" ? "bản cuối" : "bản xem trước"} (timeline bản ${source.revision})`);
    writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: readmePath, content: `${old}\n${rows.join("\n")}\n`, author: { kind: "studio", id: null }, now: ctx.now() });
    return {
      result: { files: made.map((m) => `${thumbnailsDir(video.id)}/${m.file}`), from: source.kind, revision: source.revision },
      message: `Đã làm ${made.length} thumbnail cho **${video.title}**: ${made.map((m) => `\`${thumbnailsDir(video.id)}/${m.file}\``).join(", ")}.`,
    };
  };
}
