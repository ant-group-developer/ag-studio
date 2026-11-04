/**
 * Thumbnails of a project's video (spec 2026-10-10 agent-workspace §P6, job `thumbnail`): a frame cut from the video's
 * latest render (the final one when there is one, else the preview) with words drawn on it in the branding's look,
 * written to `videos/<id>/thumbnails/NN.jpg` with a README the agent and people read (and may ask to redo).
 *
 * The same job also cuts plain frames for the agent to look at (`render_frames`, plan 2026-10-15 feedback-vps §2.3):
 * no words, the render's own aspect, into `videos/<id>/renders/frames/`.
 *
 * An item with a `prompt` (plan 2026-11-03 codex-imagegen P3) is an AI thumbnail: the frame goes to Codex's $imagegen
 * as the picture to edit (the video's own place, so the thumbnail promises nothing the video lacks), the picture that
 * comes back is cropped to the thumbnail's size and the words are drawn on it here as on any frame. Such a job is of
 * kind `image`, which only a worker with Studio's Codex takes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { THUMBNAIL_SIZES, ThumbnailStyleSchema, type ProjectAspect, type TextLook, type ThumbnailStyle } from "@harness/contracts";
import { thumbnailTextLines } from "@harness/core";
import type { StudioBucket } from "../bucket.js";
import type { CodexImager, CodexImageResult } from "../codex-image.js";
import type { StudioDb } from "../studio-db.js";
import type { ThumbnailRenderer, ThumbnailSize } from "../thumbnail-render.js";
import { writeWorkspaceFile } from "./files.js";
import { readFrontmatter } from "./frontmatter.js";
import type { JobHandler } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import { pickedLook, requireProject, requireVideo } from "./project-db.js";
import { videoRenders, type RenderResult } from "./renders.js";

/** `prompt`: an AI thumbnail, the frame edited by Codex's $imagegen this way (the words still drawn by Studio). */
export interface ThumbnailItem { text: string; at_seconds?: number | undefined; prompt?: string | undefined }
/** `request` of a `thumbnail` job; with `frames` it cuts plain frames at those seconds instead (`queueRenderFrames`). */
export interface ThumbnailJobRequest { video_id: string; items: ThumbnailItem[]; style?: Partial<ThumbnailStyle>; frames?: number[]; target?: "thumbnail" }

/** The model behind Codex's image tool (fixed by Codex), as `llm_calls` records it. */
export const CODEX_IMAGE_MODEL = "gpt-image-2";

/** One picture Codex made (or failed to make), in `llm_calls` (source `codex-image`) beside the agent's turns. */
export async function logImageCall(db: StudioDb, p: {
  job: JobRecord; teamId: string; skill: "thumbnail" | "channel_art"; round: number; outcome: "ok" | "failed";
  result?: CodexImageResult | null; wallSeconds: number; error?: string | null; now: string;
}): Promise<void> {
  const u = p.result?.usage ?? null;
  await db.run(
    `INSERT INTO llm_calls (id, created_at, source, production_id, episode_id, run_id, stage_key, attempt_id, skill, model, round, outcome,
       problems, input_tokens, output_tokens, cache_read_tokens, cost_usd, wall_seconds, user_id, team_id)
     VALUES (?, ?, 'codex-image', ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [randomUUID(), p.now, p.job.project_id, p.job.video_id, p.job.id, p.result?.threadId ?? `${p.job.id}#${p.round}`, p.skill, CODEX_IMAGE_MODEL, p.round, p.outcome,
      JSON.stringify(p.error ? [p.error] : []), u?.input_tokens ?? null, u?.output_tokens ?? null, u?.cached_input_tokens ?? null,
      p.wallSeconds, p.job.created_by, p.teamId],
  );
}

const SPACE_WORDS: Record<ThumbnailStyle["position"], string> = {
  top: "top third", center: "middle band", bottom: "bottom third", left: "left third", right: "right third",
};

/** What Codex is asked for an AI thumbnail: the person's (or agent's) words inside Studio's rules. */
export function thumbnailAiPrompt(p: { prompt: string; position: ThumbnailStyle["position"]; aspect: ProjectAspect }): string {
  const shape = p.aspect === "9:16" ? "a tall 9:16 portrait picture" : "a wide 16:9 landscape picture";
  return [
    `Edit the attached frame of a video into a YouTube thumbnail, ${shape}.`,
    p.prompt.trim(),
    "Keep the real place, people and things of the frame (it is the video's own footage): do not add landmarks, people or objects that are not there.",
    "No text, letters, numbers, logos or watermarks anywhere in the picture.",
    `Keep the ${SPACE_WORDS[p.position]} calm and uncluttered: a title is drawn there afterwards.`,
  ].join(" ");
}

export const thumbnailsDir = (videoId: string) => `videos/${videoId}/thumbnails`;
/** Where `render_frames` puts the frames it cuts from a render. */
export const renderFramesDir = (videoId: string) => `videos/${videoId}/renders/frames`;
/** At most this many frames per `render_frames` call. */
export const MAX_RENDER_FRAMES = 12;
/** Width of a frame cut to look at; the height keeps the render's aspect. */
const FRAME_WIDTH = 960;

function clockOf(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * How the words look, from the branding (`thumbnail` and `text_look` in `channel/branding.md`), the video's own
 * colours (`own`, its Style tab) over the branding's, with what was asked on top.
 */
export function thumbnailStyleOf(dir: string, over: Partial<ThumbnailStyle> = {}, own: TextLook | null = null): ThumbnailStyle {
  const path = join(dir, "channel", "branding.md");
  const fm = existsSync(path) ? (readFrontmatter(readFileSync(path, "utf8")).data as Record<string, unknown>) : {};
  const look = (own ?? fm.text_look ?? {}) as { text_color?: string; outline_color?: string; box_color?: string | null };
  const thumb = (fm.thumbnail ?? {}) as { position?: string; text_case?: string };
  const base = {
    position: ["top", "center", "bottom", "left", "right"].includes(thumb.position ?? "") ? thumb.position : "bottom",
    size: "l", text_color: look.text_color ?? "#FFFFFF", outline_color: look.outline_color ?? "#000000", box_color: look.box_color ?? null,
    uppercase: thumb.text_case !== "sentence",
  };
  const parsed = ThumbnailStyleSchema.safeParse({ ...base, ...over });
  return parsed.success ? parsed.data : ThumbnailStyleSchema.parse(base);
}

export async function queueThumbnails(db: StudioDb, p: {
  projectId: string; videoId: string; items: ThumbnailItem[]; style?: Partial<ThumbnailStyle>; threadId?: string | null; continueAgent?: boolean;
  createdBy: string; actorRole?: JobRecord["actor_role"];
}, now = new Date().toISOString()): Promise<JobRecord> {
  const v = await requireVideo(db, p.videoId);
  const items: ThumbnailItem[] = p.items.slice(0, 3).map((i) => (i.prompt?.trim() ? { ...i, prompt: i.prompt.trim() } : { text: i.text, ...(i.at_seconds !== undefined ? { at_seconds: i.at_seconds } : {}) }));
  const ai = items.some((i) => i.prompt);
  const request: ThumbnailJobRequest = { video_id: v.id, items, ...(p.style ? { style: p.style } : {}), ...(ai ? { target: "thumbnail" as const } : {}) };
  return createJob(db, {
    projectId: p.projectId, videoId: v.id, threadId: p.threadId ?? null, kind: ai ? "image" : "thumbnail", title: `${ai ? "Thumbnail AI" : "Thumbnail"}: ${v.title}`, request,
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** Queues plain frames of the video's newest render at `atSeconds` (at most `MAX_RENDER_FRAMES`), for the agent to open. */
export async function queueRenderFrames(db: StudioDb, p: {
  projectId: string; videoId: string; atSeconds: number[]; threadId?: string | null; continueAgent?: boolean;
  createdBy: string; actorRole?: JobRecord["actor_role"];
}, now = new Date().toISOString()): Promise<JobRecord> {
  const v = await requireVideo(db, p.videoId);
  const frames = [...new Set(p.atSeconds.map((t) => Math.round(Math.max(0, t) * 10) / 10))].slice(0, MAX_RENDER_FRAMES);
  const request: ThumbnailJobRequest = { video_id: v.id, items: [], frames };
  return createJob(db, {
    projectId: p.projectId, videoId: v.id, threadId: p.threadId ?? null, kind: "thumbnail", title: `Khung hình bản render: ${v.title}`, request,
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** The size of a frame to look at: `FRAME_WIDTH` wide, the render's aspect (else the project's). */
function frameSize(r: RenderResult, fallback: ThumbnailSize): ThumbnailSize {
  const w = r.width && r.width > 0 ? r.width : fallback.width;
  const h = r.height && r.height > 0 ? r.height : fallback.height;
  return { width: FRAME_WIDTH, height: Math.max(2, 2 * Math.round((FRAME_WIDTH * h) / w / 2)) };
}

/** `imager`: Studio's Codex, for the items with a `prompt` (job `image`); without it such an item fails saying so. */
export function thumbnailHandler(d: { db: StudioDb; bucket: StudioBucket; renderer: ThumbnailRenderer; imager?: CodexImager }): JobHandler {
  return async (job, ctx) => {
    const req = job.request as ThumbnailJobRequest;
    const video = await requireVideo(d.db, req.video_id);
    const project = await requireProject(d.db, job.project_id);
    const renders = (await videoRenders(d.db, project.id, video.id)).filter((r) => r.kind !== "export_premiere");
    // frames to look at come from the newest render (what was just made); a thumbnail from the final one when there is one
    const source = req.frames ? renders[0] : renders.find((r) => r.kind === "render_final") ?? renders[0];
    if (!source) throw new Error("cần một bản render (xem trước hoặc bản cuối) để cắt khung: render_preview trước");
    await ctx.report({ phase: "Đang lấy bản render", progress: 0.1 });
    const mp4 = join(ctx.tempDir, "video.mp4");
    // streamed to disk: a final render may be gigabytes
    await d.bucket.getFile(source.key, mp4);
    const from = source.kind === "render_final" ? "bản cuối" : "bản xem trước";
    if (req.frames) {
      const size = frameSize(source, THUMBNAIL_SIZES[project.aspect]);
      const dir = renderFramesDir(video.id);
      mkdirSync(join(ctx.workspaceDir, dir), { recursive: true });
      const cut: { path: string; at: number }[] = [];
      // seconds past the end all land on the last frame: cut it once
      const ats = [...new Set(req.frames.map((wanted) => Math.round(10 * Math.min(wanted, Math.max(0, (source.duration_s ?? wanted + 0.1) - 0.1))) / 10))];
      for (const [i, at] of ats.entries()) {
        await ctx.checkpoint();
        await ctx.report({ phase: `Đang cắt khung ${i + 1}/${ats.length}`, progress: 0.2 + 0.75 * (i / ats.length) });
        const name = `r${source.revision}-${at.toFixed(1).padStart(6, "0")}s.jpg`;
        const out = join(ctx.tempDir, name);
        await d.renderer.extractFrame(mp4, at, out, size);
        // the same second of the same timeline revision again (from a newer render of it) replaces the older frame
        await writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: `${dir}/${name}`, content: readFileSync(out), author: { kind: "studio", id: null }, now: ctx.now() });
        cut.push({ path: `${dir}/${name}`, at });
      }
      return {
        result: { files: cut.map((c) => c.path), from: source.kind, revision: source.revision },
        message: `Đã cắt ${cut.length} khung từ ${from} (timeline bản ${source.revision}) của **${video.title}**, mở bằng Read để xem: ${cut.map((c) => `\`${c.path}\` (${clockOf(c.at)})`).join(", ")}.`,
      };
    }
    const size = THUMBNAIL_SIZES[project.aspect];
    const style = thumbnailStyleOf(ctx.workspaceDir, req.style, (await pickedLook(d.db, video.id)).text_look);
    const outDir = join(ctx.workspaceDir, thumbnailsDir(video.id));
    mkdirSync(outDir, { recursive: true });
    const taken = new Set(readdirSync(outDir));
    const made: { file: string; text: string; at: number; prompt?: string }[] = [];
    for (const [i, item] of req.items.entries()) {
      await ctx.checkpoint();
      const step = (phase: string, part = 0) => ctx.report({ phase, progress: 0.2 + 0.7 * ((i + part) / req.items.length) });
      await step(`Đang làm thumbnail ${i + 1}/${req.items.length}`);
      const at = Math.max(0, Math.min(item.at_seconds ?? (source.duration_s ?? 10) * (0.25 + 0.25 * i), Math.max(0, (source.duration_s ?? 1) - 0.1)));
      let frame = join(ctx.tempDir, `frame-${i}.jpg`);
      await d.renderer.extractFrame(mp4, at, frame, size);
      if (item.prompt) {
        if (!d.imager) throw new Error("worker này không có Codex của Studio (STUDIO_CODEX_HOME) để làm thumbnail AI");
        await step(`Đang tạo ảnh AI cho thumbnail ${i + 1}/${req.items.length} (ChatGPT, 1–4 phút)`, 0.1);
        const ai = join(ctx.tempDir, `ai-${i}.png`);
        const started = Date.now();
        let pic: CodexImageResult;
        try {
          pic = await d.imager.generate({ prompt: thumbnailAiPrompt({ prompt: item.prompt, position: style.position, aspect: project.aspect }), references: [frame], out: ai, signal: ctx.signal });
        } catch (e) {
          await logImageCall(d.db, { job, teamId: project.team_id, skill: "thumbnail", round: i + 1, outcome: "failed", wallSeconds: (Date.now() - started) / 1000, error: e instanceof Error ? e.message : String(e), now: ctx.now() });
          throw e;
        }
        await logImageCall(d.db, { job, teamId: project.team_id, skill: "thumbnail", round: i + 1, outcome: "ok", result: pic, wallSeconds: pic.seconds, now: ctx.now() });
        frame = join(ctx.tempDir, `ai-${i}.jpg`);
        await d.renderer.normalize(ai, frame, size);
      }
      let n = 1;
      while (taken.has(`${String(n).padStart(2, "0")}.jpg`)) n += 1;
      const name = `${String(n).padStart(2, "0")}.jpg`;
      taken.add(name);
      const out = join(ctx.tempDir, name);
      await d.renderer.compose(frame, out, { lines: thumbnailTextLines(item.text, { ...size, style }), style, size });
      await writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: `${thumbnailsDir(video.id)}/${name}`, content: readFileSync(out), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
      made.push({ file: name, text: item.text, at, ...(item.prompt ? { prompt: item.prompt } : {}) });
    }
    const readmePath = `${thumbnailsDir(video.id)}/README.md`;
    const old = existsSync(join(ctx.workspaceDir, readmePath)) ? readFileSync(join(ctx.workspaceDir, readmePath), "utf8").replace(/\s+$/, "") : `# Thumbnail · ${video.title}\n\nẢnh ${size.width}×${size.height}, chữ theo branding. Mở ảnh để xem; nhờ agent làm lại với chữ hoặc khung khác.\n`;
    const rows = made.map((m) => `- \`${m.file}\`: "${m.text}" · ${m.prompt ? "ảnh AI (ChatGPT) sửa từ khung" : "khung"} ở giây ${m.at.toFixed(1)} của ${source.kind === "render_final" ? "bản cuối" : "bản xem trước"} (timeline bản ${source.revision})${m.prompt ? ` · prompt: "${m.prompt.replace(/\s+/g, " ")}"` : ""}`);
    await writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: readmePath, content: `${old}\n${rows.join("\n")}\n`, author: { kind: "studio", id: null }, now: ctx.now() });
    return {
      result: { files: made.map((m) => `${thumbnailsDir(video.id)}/${m.file}`), from: source.kind, revision: source.revision },
      message: `Đã làm ${made.length} thumbnail cho **${video.title}**: ${made.map((m) => `\`${thumbnailsDir(video.id)}/${m.file}\``).join(", ")}.`,
    };
  };
}
