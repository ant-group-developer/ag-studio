/**
 * Footage from someone's computer (feedback 2026-10-27 item 3): a video or a photo the browser puts straight on the bucket
 * (`library/studio/projects/<project>/footage/<id><ext>`, a link Studio signs), added to a video as a source of kind
 * `upload_asset` and prepared like an ag-go video into `inputs/<id>/` (the same `shots.json`, frames, sheets and
 * transcript), so choosing shots, the fit and the renders treat both alike (renders resolve `asset:<id>` to the file).
 *
 *   - a video is cut into shots on the farm (`scan.prep`, the job ag-go runs for its own videos, reading the file from
 *     Studio's bucket), and what it says is read there too (`studio.transcribe`);
 *   - a photo becomes a short clip with a slow push in (`IMAGE_CLIP_SECONDS`, made here: one ffmpeg of a few seconds),
 *     kept beside it and rendered instead of it: one shot, its frame the photo.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  SCAN_PREP_MANIFEST_PATH, ScanPrepManifestSchema, StudioTranscribePayloadSchema, TRANSCRIBE_MANIFEST_PATH, TranscribeManifestSchema,
  type ScanPrepManifest, type TranscribeManifest,
} from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import { grabFrame, probeMedia, runTool, tileSheet } from "../cut-ffmpeg.js";
import type { StudioDb } from "../studio-db.js";
import { StudioRunError } from "../errors.js";
import { ackFarmJob, runFarmStep, type ProjectFarm } from "./farm.js";
import type { JobContext } from "./job-runner.js";
import type { JobRecord } from "./jobs-db.js";
import { addSource, sourceView, type SourceRecord } from "./sources-db.js";

export const FOOTAGE_VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts"] as const;
export const FOOTAGE_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp"] as const;
/** The largest video one PUT takes (R2 takes 5 GB in one). */
export const FOOTAGE_VIDEO_MAX_BYTES = 4 * 1024 ** 3;
export const FOOTAGE_IMAGE_MAX_BYTES = 50 * 1024 ** 2;
/** How long the clip made of a photo plays: room for a 2–5 s shot. */
export const IMAGE_CLIP_SECONDS = 6;
/** The clip's long edge (px) and frame rate. */
const IMAGE_CLIP_EDGE = 1920;
const IMAGE_CLIP_FPS = 25;
/** How far the photo's clip pushes in by its end (1.1 = 10%). */
const IMAGE_CLIP_ZOOM = 0.1;
const IMAGE_CLIP_TIMEOUT_MS = 5 * 60_000;

export type FootageMedia = "video" | "image";

/** What an uploaded file is, by its extension; null for neither. */
export function footageMedia(name: string): FootageMedia | null {
  const ext = extname(name).toLowerCase();
  if ((FOOTAGE_VIDEO_EXTS as readonly string[]).includes(ext)) return "video";
  if ((FOOTAGE_IMAGE_EXTS as readonly string[]).includes(ext)) return "image";
  return null;
}

export const footagePrefix = (projectId: string) => `library/studio/projects/${projectId}/footage/`;

/** Where a new upload goes: a fresh id (a uuid: the farm's `scan.prep` takes no other) and the file's own extension. */
export function newFootageKey(projectId: string, name: string): { assetId: string; key: string } {
  const assetId = randomUUID();
  return { assetId, key: `${footagePrefix(projectId)}${assetId}${extname(name).toLowerCase()}` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id and kind of the upload at `key`, when it is one of this project's (a key from a browser is checked first). */
export function footageAt(projectId: string, key: string): { assetId: string; media: FootageMedia } | null {
  const prefix = footagePrefix(projectId);
  if (!key.startsWith(prefix)) return null;
  const file = key.slice(prefix.length);
  const ext = extname(file);
  const assetId = file.slice(0, file.length - ext.length);
  const media = footageMedia(file);
  return UUID.test(assetId) && media && ext === ext.toLowerCase() ? { assetId, media } : null;
}

/** `meta` of an `upload_asset` source: the file on the bucket, and the clip rendered instead of a photo once made. */
export interface UploadMeta {
  key: string;
  bytes: number;
  /** A photo's clip (`<id>.mp4` beside it), once prepared. */
  clip_key?: string;
}

export function uploadMeta(s: Pick<SourceRecord, "meta">): UploadMeta | null {
  const m = sourceView(s as SourceRecord).meta;
  return typeof m.key === "string" && typeof m.bytes === "number" ? (m as unknown as UploadMeta) : null;
}

/** The file a render reads for an uploaded footage: a photo's clip, else the file itself. */
export const renderKey = (m: UploadMeta) => m.clip_key ?? m.key;

/** Adds the file a browser put at `key` to a video (or the project) as footage. */
export async function addUploadedFootage(db: StudioDb, bucket: StudioBucket, p: {
  projectId: string; videoId: string | null; key: string; name: string; addedBy: string;
}, now?: string): Promise<SourceRecord> {
  const at = footageAt(p.projectId, p.key);
  if (!at) throw new StudioRunError("invalid", "Mã tải lên không hợp lệ", { code: "upload_key" });
  const head = await bucket.exists(p.key);
  if (!head) throw new StudioRunError("not_found", "Không thấy file đã tải lên: tải lại", { code: "upload_missing" });
  const max = at.media === "video" ? FOOTAGE_VIDEO_MAX_BYTES : FOOTAGE_IMAGE_MAX_BYTES;
  if (head.size > max) {
    await bucket.deleteMany([p.key]).catch(() => undefined);
    throw new StudioRunError("invalid", `File lớn hơn ${Math.round(max / 1024 ** 2)} MB`, { code: "file_too_large" });
  }
  const meta: UploadMeta = { key: p.key, bytes: head.size };
  return addSource(db, {
    projectId: p.projectId, videoId: p.videoId, kind: "upload_asset", ref: at.assetId, mediaType: at.media, label: p.name,
    meta: meta as unknown as Record<string, unknown>, addedBy: p.addedBy,
  }, now);
}

/** What preparing an upload needs on the worker. */
export interface UploadPrepDeps {
  db: StudioDb;
  bucket: StudioBucket;
  farm: ProjectFarm | null;
  /** ffmpeg and ffprobe of the worker: a photo's clip, its frame and sheet. */
  ffmpeg?: string;
  ffprobe?: string;
  pollMs?: number;
  queueTimeoutMs?: number;
}

/** What `prepareUpload` found, for `prepare.ts` to write as it writes an ag-go video's prep. */
export interface UploadPrep {
  durationS: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  scene: { threshold: number; minShotS: number; maxShotS: number };
  shots: { n: number; in: number; out: number; frame: string }[];
  sheets: { file: string; shots: number[] }[];
  /** What is said (the farm's raw WhisperX manifest), or why there is none. */
  transcript: { manifest: TranscribeManifest } | { none: "no_audio" | "no_farm" | "failed"; error?: string };
}

/** ffmpeg argv of a photo's clip: `seconds` long, the long edge `IMAGE_CLIP_EDGE`, pushing in slowly on its middle. */
export function photoClipArgs(src: string, dest: string, size: { width: number; height: number }): string[] {
  const scale = IMAGE_CLIP_EDGE / Math.max(size.width, size.height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const w = even(size.width * scale);
  const h = even(size.height * scale);
  const frames = IMAGE_CLIP_SECONDS * IMAGE_CLIP_FPS;
  // twice the size first: zoompan moves in whole pixels, which judders on a picture only as large as the frame
  const vf = [
    `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w * 2}:${h * 2}`,
    `zoompan=z='1+${IMAGE_CLIP_ZOOM}*on/${frames - 1}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${IMAGE_CLIP_FPS}`,
    "format=yuv420p",
  ].join(",");
  return ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(IMAGE_CLIP_FPS), "-i", src, "-vf", vf,
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", dest];
}

/**
 * Prepares the uploaded footage `src` into `out/` (frames, sheets): a photo here, a video on the farm. Answers what the
 * prep files say about it; a photo's clip is put on the bucket and recorded on every source of it.
 */
export async function prepareUpload(d: UploadPrepDeps, job: JobRecord, ctx: JobContext, src: SourceRecord, out: string): Promise<UploadPrep> {
  const meta = uploadMeta(src);
  if (!meta) throw new Error("footage tải lên thiếu thông tin file: xoá rồi tải lại");
  if (!await d.bucket.exists(meta.key)) throw new Error("không còn file trên kho: xoá rồi tải lại");
  return src.media_type === "image" ? preparePhoto(d, job, ctx, src, meta, out) : prepareVideo(d, job, ctx, src, meta, out);
}

async function preparePhoto(d: UploadPrepDeps, job: JobRecord, ctx: JobContext, src: SourceRecord, meta: UploadMeta, out: string): Promise<UploadPrep> {
  if (!d.ffmpeg || !d.ffprobe) throw new Error("worker này không có ffmpeg nên chưa làm được clip từ ảnh");
  await ctx.report({ phase: "Đang tải ảnh", progress: 0.05 });
  const photo = join(ctx.tempDir, `photo${extname(meta.key)}`);
  await d.bucket.getFile(meta.key, photo);
  const facts = await probeMedia(d.ffprobe, photo);
  if (!facts?.width || !facts.height) throw new Error("không đọc được ảnh này");
  await ctx.checkpoint();
  await ctx.report({ phase: "Đang làm clip từ ảnh", progress: 0.3 });
  const clip = join(ctx.tempDir, "clip.mp4");
  const r = await runTool(d.ffmpeg, photoClipArgs(photo, clip, { width: facts.width, height: facts.height }), { timeoutMs: IMAGE_CLIP_TIMEOUT_MS, signal: ctx.signal });
  if (r.timedOut || r.code !== 0) throw new Error(`không làm được clip từ ảnh: ${r.stderr.slice(-300)}`);
  const made = await probeMedia(d.ffprobe, clip);
  await ctx.checkpoint();
  await ctx.report({ phase: "Đang lưu clip", progress: 0.7 });
  const clipKey = `${footagePrefix(job.project_id)}${src.ref}.mp4`;
  await d.bucket.putFile(clipKey, clip, "video/mp4");
  await d.db.run(
    "UPDATE project_sources SET meta = ? WHERE project_id = ? AND kind = 'upload_asset' AND ref = ?",
    [JSON.stringify({ ...meta, clip_key: clipKey }), job.project_id, src.ref],
  );
  const seconds = made?.duration_s ?? IMAGE_CLIP_SECONDS;
  // the shot's middle frame, from the clip (ffmpeg seeking into a still image writes nothing)
  const frame = "frames/001.jpg";
  await grabFrame(d.ffmpeg, clip, seconds / 2, join(out, frame), 480);
  const sheet = "sheets/01.jpg";
  mkdirSync(dirname(join(out, sheet)), { recursive: true });
  await tileSheet(d.ffmpeg, [join(out, frame)], 1, join(out, sheet));
  return {
    durationS: seconds, width: made?.width ?? null, height: made?.height ?? null, fps: made?.fps ?? IMAGE_CLIP_FPS, hasAudio: false,
    scene: { threshold: 0, minShotS: seconds, maxShotS: seconds },
    shots: [{ n: 1, in: 0, out: seconds, frame }], sheets: [{ file: sheet, shots: [1] }], transcript: { none: "no_audio" },
  };
}

async function prepareVideo(d: UploadPrepDeps, job: JobRecord, ctx: JobContext, src: SourceRecord, meta: UploadMeta, out: string): Promise<UploadPrep> {
  if (!d.farm) throw new Error("worker này không nối farm nên chưa cắt cảnh được video tải lên");
  const farmDeps = { db: d.db, bucket: d.bucket, farm: d.farm, ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.queueTimeoutMs ? { queueTimeoutMs: d.queueTimeoutMs } : {}), now: ctx.now };
  const watch = (what: string, from: number, to: number) => ({
    onUpdate: (u: { phase: string; progress: number | null; node: string | null; farmJobId: string; waiting: boolean }) =>
      ctx.report({ phase: `${u.phase} · ${what}`, progress: from + (to - from) * (u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
    stopRequested: ctx.stopRequested,
  });

  // shots, frames, sheets and the sound, by the farm's scan.prep from the file on the bucket
  let scan: Awaited<ReturnType<typeof runFarmStep>>;
  try {
    scan = await runFarmStep(farmDeps, job, {
      type: "scan.prep", stageKey: "prep", attemptId: job.id,
      payload: { asset_id: src.ref, source: `library:${meta.key.slice("library/".length)}` },
    }, watch("cắt cảnh", 0.02, 0.6));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/not allowed|allowed_types|forbidden|403/i.test(message)) {
      throw new Error(`farm chưa cho Studio gửi việc cắt cảnh (scan.prep): thêm scan.prep vào loại việc của chủ job studio trên trang quản trị farm (${message})`);
    }
    throw e;
  }
  const manifest: ScanPrepManifest = ScanPrepManifestSchema.parse(JSON.parse((await d.bucket.get(`${scan.outputPrefix}${SCAN_PREP_MANIFEST_PATH}`)).toString("utf8")));
  await ctx.report({ phase: "Đang tải khung hình", progress: 0.62, waiting: false });
  for (const f of [...manifest.shots.map((s) => s.frame), ...manifest.sheets.map((s) => s.file)]) {
    if (!/^(frames|sheets)\/[A-Za-z0-9_-]{1,40}\.jpg$/.test(f)) throw new Error(`máy farm trả về đường dẫn ảnh lạ: ${f}`);
    await ctx.checkpoint();
    await d.bucket.getFile(`${scan.outputPrefix}${f}`, join(out, f));
  }
  const audio = manifest.audio ? join(ctx.tempDir, "audio.wav") : null;
  if (audio) await d.bucket.getFile(`${scan.outputPrefix}${manifest.audio}`, audio);
  await ackFarmJob(d.farm, scan.farmJob.id);

  // what is said: read on a farm machine with a GPU (a failure leaves the shots usable)
  let transcript: UploadPrep["transcript"] = { none: "no_audio" };
  if (audio) {
    try {
      const payload = StudioTranscribePayloadSchema.parse({
        production_id: job.project_id, sources: [{ source_id: src.ref, audio: `stage:audio/${src.ref}.wav`, language: null }],
      });
      const read = await runFarmStep(farmDeps, job, {
        type: "studio.transcribe", payload, stageKey: "transcribe", attemptId: job.id,
        uploads: [{ localPath: audio, relPath: `audio/${src.ref}.wav` }], requirements: { gpu: true, python: true },
      }, watch("đọc lời thoại", 0.65, 0.95));
      const m = TranscribeManifestSchema.parse(JSON.parse((await d.bucket.get(`${read.outputPrefix}${TRANSCRIBE_MANIFEST_PATH}`)).toString("utf8")));
      await ackFarmJob(d.farm, read.farmJob.id);
      transcript = { manifest: m };
    } catch (e) {
      if (await ctx.stopRequested()) throw e;
      transcript = { none: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }
  const media = manifest.media;
  return {
    durationS: media.duration_s, width: media.width || null, height: media.height || null, fps: media.fps, hasAudio: media.has_audio,
    scene: { threshold: manifest.scene.threshold, minShotS: manifest.scene.min_shot_s, maxShotS: manifest.scene.max_shot_s },
    shots: manifest.shots, sheets: manifest.sheets, transcript,
  };
}

