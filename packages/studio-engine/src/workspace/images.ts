/**
 * Job `image` (plan 2026-11-03 codex-imagegen P3): pictures made by Codex's $imagegen on Studio's ChatGPT login
 * (`codex-image.ts`). Two targets: AI thumbnails of a video (`thumbnail`, the `thumbnail` job's own handler with the
 * imager) and the channel's art (`channel_art`): a logo or a picture as Codex makes it (PNG, transparent when asked),
 * a banner at YouTube's 2560×1440 and an avatar at 800×800 (JPEG), in `channel/art/` with a README of what was asked.
 * References are workspace pictures (the logo for a banner, a photo of the place), never paths outside it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StudioBucket } from "../bucket.js";
import { StudioRunError } from "../errors.js";
import type { CodexImager, CodexImageResult } from "../codex-image.js";
import type { StudioDb } from "../studio-db.js";
import type { ThumbnailRenderer, ThumbnailSize } from "../thumbnail-render.js";
import { accessFor, resolveInside, writeWorkspaceFile } from "./files.js";
import type { JobHandler } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import { requireProject } from "./project-db.js";
import { logImageCall, thumbnailHandler } from "./thumbnails.js";

export const CHANNEL_ART_DIR = "channel/art";
export const CHANNEL_ART_KINDS = ["logo", "banner", "avatar", "art"] as const;
export type ChannelArtKind = (typeof CHANNEL_ART_KINDS)[number];
/** At most this many references (Codex's tool takes five; one is plenty for a banner from a logo). */
export const CHANNEL_ART_MAX_REFERENCES = 3;
const PICTURE_EXT = /\.(jpe?g|png|webp)$/i;

/** The size a kind is cropped to (JPEG), or null: kept as Codex made it (PNG, may be transparent). */
const ART_SIZE: Record<ChannelArtKind, ThumbnailSize | null> = {
  logo: null, banner: { width: 2560, height: 1440 }, avatar: { width: 800, height: 800 }, art: null,
};

/** What Codex is told of the shape of each kind, before the prompt. */
const ART_SHAPE: Record<ChannelArtKind, string> = {
  logo: "A channel logo: a simple, bold mark that still reads at 64×64 pixels, centred with margin around it, square.",
  banner: "A YouTube channel banner, a wide 16:9 picture: everything that matters (name, mark, subject) inside the central band, about 1235×338 of 2560×1440, since TV, desktop and phone crop the rest.",
  avatar: "A YouTube channel avatar: square, the subject centred inside a circle (the corners are cut off), readable at 98×98 pixels.",
  art: "",
};

/** `request` of an `image` job for the channel's art. */
export interface ChannelArtJobRequest {
  target: "channel_art";
  kind: ChannelArtKind;
  prompt: string;
  /** Workspace paths of pictures to edit or follow. */
  references: string[];
  transparent: boolean;
}

export async function queueChannelArt(db: StudioDb, p: {
  projectId: string; workspaceDir: string; kind: ChannelArtKind; prompt: string; references?: string[]; transparent?: boolean;
  threadId?: string | null; continueAgent?: boolean; createdBy: string; actorRole?: JobRecord["actor_role"];
}, now = new Date().toISOString()): Promise<JobRecord> {
  const references = [...new Set(p.references ?? [])];
  if (references.length > CHANNEL_ART_MAX_REFERENCES) throw new StudioRunError("invalid", `tối đa ${CHANNEL_ART_MAX_REFERENCES} ảnh tham chiếu`);
  for (const ref of references) {
    if (!PICTURE_EXT.test(ref)) throw new StudioRunError("invalid", `${ref}: ảnh tham chiếu phải là .jpg, .png hoặc .webp`);
    if (accessFor(ref, "agent") === "none") throw new StudioRunError("invalid", `${ref}: không đọc được file này`);
    if (!existsSync(resolveInside(p.workspaceDir, ref).abs)) throw new StudioRunError("invalid", `${ref}: không có file này trong dự án`);
  }
  // only a logo or free art can be transparent: a banner or an avatar is cropped to a JPEG
  const transparent = !!p.transparent && ART_SIZE[p.kind] === null;
  const request: ChannelArtJobRequest = { target: "channel_art", kind: p.kind, prompt: p.prompt.trim(), references, transparent };
  return createJob(db, {
    projectId: p.projectId, videoId: null, threadId: p.threadId ?? null, kind: "image", title: `Ảnh kênh (${p.kind})`, request,
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** What Codex is asked for the channel's art: the shape of the kind, then the words asked. */
export function channelArtPrompt(r: Pick<ChannelArtJobRequest, "kind" | "prompt" | "references">): string {
  return [
    ART_SHAPE[r.kind],
    r.prompt,
    r.references.length ? "Follow the attached picture(s): keep their mark, colours and style unless the words above say otherwise." : "",
  ].filter(Boolean).join(" ");
}

function channelArtHandler(d: { db: StudioDb; renderer: ThumbnailRenderer; imager: CodexImager }): JobHandler {
  return async (job, ctx) => {
    const req = job.request as ChannelArtJobRequest;
    const project = await requireProject(d.db, job.project_id);
    const refs = req.references.map((r) => resolveInside(ctx.workspaceDir, r).abs);
    await ctx.report({ phase: "Đang tạo ảnh bằng ChatGPT (1–4 phút)", progress: 0.1 });
    const png = join(ctx.tempDir, "art.png");
    const started = Date.now();
    let pic: CodexImageResult;
    try {
      pic = await d.imager.generate({ prompt: channelArtPrompt(req), references: refs, transparentBackground: req.transparent, out: png, signal: ctx.signal });
    } catch (e) {
      await logImageCall(d.db, { job, teamId: project.team_id, skill: "channel_art", round: 1, outcome: "failed", wallSeconds: (Date.now() - started) / 1000, error: e instanceof Error ? e.message : String(e), now: ctx.now() });
      throw e;
    }
    await logImageCall(d.db, { job, teamId: project.team_id, skill: "channel_art", round: 1, outcome: "ok", result: pic, wallSeconds: pic.seconds, now: ctx.now() });
    await ctx.checkpoint();
    await ctx.report({ phase: "Đang lưu ảnh", progress: 0.9 });
    const size = ART_SIZE[req.kind];
    const ext = size ? ".jpg" : ".png";
    const file = size ? join(ctx.tempDir, "art.jpg") : png;
    if (size) await d.renderer.normalize(png, file, size);
    const outDir = join(ctx.workspaceDir, CHANNEL_ART_DIR);
    mkdirSync(outDir, { recursive: true });
    const taken = new Set(readdirSync(outDir));
    let n = 1;
    while (taken.has(`${req.kind}-${String(n).padStart(2, "0")}${ext}`)) n += 1;
    const name = `${req.kind}-${String(n).padStart(2, "0")}${ext}`;
    const path = `${CHANNEL_ART_DIR}/${name}`;
    await writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path, content: readFileSync(file), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
    const readmePath = `${CHANNEL_ART_DIR}/README.md`;
    const old = existsSync(join(ctx.workspaceDir, readmePath))
      ? readFileSync(join(ctx.workspaceDir, readmePath), "utf8").replace(/\s+$/, "")
      : "# Ảnh kênh\n\nLogo, banner (2560×1440), avatar (800×800) và ảnh khác tạo bằng ChatGPT. Mở ảnh để xem; nhờ agent làm lại với lời khác.\n";
    const shape = size ? `${size.width}×${size.height}` : req.transparent ? "PNG nền trong suốt" : "PNG";
    const followed = req.references.length ? ` · theo ${req.references.map((r) => `\`${r}\``).join(", ")}` : "";
    const row = `- \`${name}\` (${req.kind}, ${shape})${followed} · prompt: "${req.prompt.replace(/\s+/g, " ")}"`;
    await writeWorkspaceFile(d.db, { projectId: project.id, dir: ctx.workspaceDir, path: readmePath, content: `${old}\n${row}\n`, author: { kind: "studio", id: null }, now: ctx.now() });
    return {
      result: { files: [path], kind: req.kind, seconds: pic.seconds },
      message: `Đã tạo ảnh kênh (${req.kind}): \`${path}\`, mở bằng Read để xem.`,
    };
  };
}

/** Job `image`: an AI thumbnail of a video or the channel's art, by its `target`. */
export function imageHandler(d: { db: StudioDb; bucket: StudioBucket; renderer: ThumbnailRenderer; imager: CodexImager }): JobHandler {
  const thumbnails = thumbnailHandler(d);
  const art = channelArtHandler(d);
  return (job, ctx) => ((job.request as { target?: string }).target === "channel_art" ? art(job, ctx) : thumbnails(job, ctx));
}
