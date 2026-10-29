/**
 * Preparing an ag-go video for a project (spec 2026-10-10 agent-workspace §4, job `prepare_asset`; plan 2026-10-13 P3):
 * what Claude needs to choose shots, written once per project into `inputs/<assetId>/` and read by every video of the
 * project:
 *
 *   README.md        what the video is, its shots, where the files are
 *   shots.json       shots found where the picture changes (Studio's `buildShots` rules, run by ag-go)
 *   frames/NNN.jpg   the middle frame of each shot
 *   sheets/NN.jpg    contact sheets of 16 shots
 *   transcript.json  what is said (WhisperX at ag-go, cleaned here), transcript.md the same to read
 *
 * ag-go prepares every video once, when it comes in (a farm `scan.prep`, then `studio.transcribe`), and keeps it: the
 * job asks for it, asks ag-go to run it now when it has none yet and waits, then downloads the frames and sheets and
 * writes the files in the formats video-index, fit and the shot-choosing skill read. Nothing is decoded here.
 *
 * Footage someone uploaded (`upload_asset`, `footage-upload.ts`) is prepared into the same files: by the same farm jobs
 * Studio sends itself for a video, here for a photo.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CUT_SHEET_SHOTS } from "@harness/contracts";
import { TRANSCRIBE_MANIFEST_SCHEMA, type TranscribeManifest } from "@ag-farm/protocol";
import { cleanTranscribeManifest } from "../transcript-clean.js";
import type { StudioDb } from "../studio-db.js";
import { DEFAULT_SITE_NAME } from "../site-name.js";
import { JobStopped } from "./farm.js";
import type { JobContext, JobOutcome } from "./job-runner.js";
import type { JobRecord } from "./jobs-db.js";
import { prepareUpload, type UploadPrepDeps } from "./footage-upload.js";
import { preparedElsewhere } from "./media-library.js";
import { agGoProjectIds, getPrepared, savePrepared, uploadedAsset, type SourceRecord } from "./sources-db.js";
import { writeVideoIndexesFor } from "./video-index.js";

/** Where the prep of one footage stands at ag-go (`POST /footage/assets/prep`, contract H2 of plan 2026-10-13). */
export interface AgGoPrepItem {
  assetId: string;
  state: "ready" | "running" | "missing" | "failed";
  phase: "queued" | "cutting" | "transcribing" | null;
  progress: number | null;
  error: string | null;
  prep: null | {
    prepId: string;
    preparedAt: string;
    durationS: number;
    width: number;
    height: number;
    fps: number | null;
    hasAudio: boolean;
    sourceKind: string;
    watermarked: boolean;
    scene: { threshold: number; minShotS: number; maxShotS: number };
    shots: { n: number; in: number; out: number; frame: string; url: string }[];
    sheets: { file: string; shots: number[]; url: string }[];
    transcriptStatus: "none" | "skipped" | "done" | "failed";
    transcript: null | {
      language: string | null;
      alignment: "word" | "segment";
      engine: string;
      segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; score?: number }[] }[];
    };
  };
}

/**
 * ag-go's preps in its trusted mode for Studio: only videos of `projectIds` (the ag-go projects added to the project),
 * whoever asks; another video is refused (404).
 */
export interface AgGoPreps {
  /** The prep of each footage, or how far it is. */
  read(projectIds: string[], assetIds: string[]): Promise<{ items: AgGoPrepItem[] }>;
  /** Runs missing or failed preps now, raises one waiting in a backfill; answers like `read`. `requestedBy`: who asked, for ag-go's record. */
  run(projectIds: string[], assetIds: string[], requestedBy?: string): Promise<{ items: AgGoPrepItem[] }>;
}

/** What preparing needs on the worker. */
export interface PrepareDeps {
  db: StudioDb;
  /** ag-go's preps (ag-go videos); absent: only uploaded footage is prepared here. */
  preps?: AgGoPreps;
  /** The bucket, the farm and ffmpeg (uploaded footage, `footage-upload.ts`); absent: only ag-go videos are prepared. */
  uploads?: Omit<UploadPrepDeps, "db">;
  /** Downloads a signed frame or sheet URL to `dest`; throws on any HTTP or network error. */
  download(url: string, dest: string, signal: AbortSignal): Promise<void>;
  /** What people call the footage library (ag-go's `siteName`), for job text and README; default "AG Go". */
  siteName?: () => string;
  /** How often a running prep is asked about again (default 5 s). */
  pollMs?: number;
  /** How long a prep is waited for at most (default 60 min). */
  maxWaitMs?: number;
  /** Waits before each new try of an ag-go call that answered 429/502/503/504 (default 2, 5 and 15 s). */
  retryDelaysMs?: readonly number[];
}

/** `request` of a `prepare_asset` job. */
export interface PrepareRequest {
  asset_id: string;
  /** ag-go's name of the video, when known. */
  name?: string | null;
  duration_s?: number | null;
  /** Jobs queued together (`queuePrepare` of several videos): the thread hears once, when the last one ends. */
  batch_id?: string;
}

export const ASSET_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const inputDir = (assetId: string) => `inputs/${assetId}`;

export interface InputShot { n: number; in: number; out: number; frame: string }
export interface InputShots {
  schema_version: "studio.input-shots/v1";
  asset_id: string;
  name: string;
  duration_s: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  has_audio: boolean;
  /** The rendition ag-go cut the shots from (`original`, `proxy`, `preview`). */
  source: { kind: string; watermarked: boolean };
  scene: { threshold: number; min_shot_seconds: number; max_shot_seconds: number };
  shots: InputShot[];
  sheets: { file: string; shots: number[] }[];
}

export interface InputTranscript {
  schema_version: "studio.input-transcript/v1";
  asset_id: string;
  language: string | null;
  alignment: "word" | "segment";
  engine: string;
  segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; score?: number | undefined }[] }[];
  dropped: number;
}

/** `m:ss.s` */
export function clock(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Images downloaded at once. */
const DOWNLOAD_LANES = 8;
/** ag-go's answers that mean "busy, try again", not "no". */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 5000, 15_000];
const POLL_MS = 5000;
const MAX_WAIT_MS = 60 * 60_000;
/** A frame or sheet path as ag-go names them (`frames/001.jpg`, `sheets/01.jpg`): nothing else is written. */
const IMAGE_PATH = /^(frames|sheets)\/[A-Za-z0-9_-]{1,40}\.jpg$/;

/** Progress: asking and waiting for ag-go up to `wait`, the images up to `images`, then the files. */
const PHASE: Record<NonNullable<AgGoPrepItem["phase"]>, { text: string; from: number; to: number }> = {
  queued: { text: "Đang chờ máy", from: 0.02, to: 0.02 },
  cutting: { text: "Đang cắt cảnh", from: 0.05, to: 0.5 },
  transcribing: { text: "Đang đọc lời thoại", from: 0.5, to: 0.9 },
};
const IMAGES = { from: 0.9, to: 0.98 } as const;

/**
 * The `prepare_asset` handler, for an ag-go video or uploaded footage: a failure (not a stop) is recorded for the asset,
 * so its videos' index says why.
 */
export function prepareHandler(d: PrepareDeps): (job: JobRecord, ctx: JobContext) => Promise<JobOutcome> {
  return async (job, ctx) => {
    try {
      const req = job.request as PrepareRequest;
      const upload = ASSET_ID.test(req.asset_id) ? await uploadedAsset(d.db, job.project_id, req.asset_id) : undefined;
      return upload ? await prepareUploaded(d, job, ctx, upload) : await prepareAsset(d, job, ctx);
    } catch (e) {
      const req = job.request as PrepareRequest;
      if (!(e instanceof JobStopped) && !await ctx.stopRequested() && ASSET_ID.test(req.asset_id)) {
        await savePrepared(d.db, {
          project_id: job.project_id, asset_id: req.asset_id, status: "failed", name: req.name ?? null, duration_s: req.duration_s ?? null, width: null, height: null,
          has_audio: null, shots: null, transcript: false, source_kind: null, watermarked: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        }, ctx.now());
        await writeVideoIndexesFor(d.db, ctx.workspaceDir, job.project_id, req.asset_id);
      }
      throw e;
    }
  };
}

export async function prepareAsset(d: PrepareDeps, job: JobRecord, ctx: JobContext): Promise<JobOutcome> {
  const req = job.request as PrepareRequest;
  const assetId = req.asset_id;
  const site = d.siteName?.() ?? DEFAULT_SITE_NAME;
  if (!ASSET_ID.test(assetId)) throw new Error(`id video ${site} không hợp lệ: ${assetId}`);
  if (!d.preps) throw new Error(`worker này không nối ${site} nên chưa chuẩn bị được video ${site}`);
  const projectIds = await agGoProjectIds(d.db, job.project_id);
  if (!projectIds.length) throw new Error(`dự án chưa có project ${site} nào: thêm project chứa video này ở tab Nguồn`);

  const prep = await readyPrep({ ...d, preps: d.preps }, ctx, { projectIds, requestedBy: job.created_by }, assetId, site, req.duration_s ?? null);
  const name = req.name?.trim() || assetId;
  const out = join(ctx.tempDir, "out");
  await downloadImages(d, ctx, prep, out, site);

  let transcript: InputTranscript | null = null;
  let note: string;
  if (prep.transcriptStatus === "done" && prep.transcript) {
    transcript = cleanTranscript(job.project_id, assetId, prep.transcript);
    note = transcriptNote(transcript);
  } else if (prep.transcriptStatus === "failed") {
    note = `${site} chưa đọc được (lời thoại là phần thêm: cảnh vẫn dùng được)`;
  } else if (prep.transcriptStatus === "skipped") {
    note = `${site} cho biết video không có lời nói`;
  } else {
    note = prep.hasAudio ? "không nghe thấy lời nói" : "video không có tiếng";
  }

  const shotsFile: InputShots = {
    schema_version: "studio.input-shots/v1", asset_id: assetId, name, duration_s: prep.durationS, width: prep.width || null, height: prep.height || null,
    fps: prep.fps, has_audio: prep.hasAudio, source: { kind: prep.sourceKind, watermarked: prep.watermarked },
    scene: { threshold: prep.scene.threshold, min_shot_seconds: prep.scene.minShotS, max_shot_seconds: prep.scene.maxShotS },
    shots: prep.shots.map((s) => ({ n: s.n, in: s.in, out: s.out, frame: s.frame })),
    sheets: prep.sheets.map((s) => ({ file: s.file, shots: s.shots })),
  };
  return writePrepared(d.db, job, ctx, out, shotsFile, transcript, note, site);
}

/** The footage someone uploaded (`footage-upload.ts`), prepared into the same files as an ag-go video. */
async function prepareUploaded(d: PrepareDeps, job: JobRecord, ctx: JobContext, src: SourceRecord): Promise<JobOutcome> {
  const copied = src.media_id ? await copyPrepared(d.db, job, ctx, src) : null;
  if (copied) return copied;
  if (!d.uploads) throw new Error("worker này chưa chuẩn bị được footage tải lên (thiếu kho hoặc farm)");
  const site = d.siteName?.() ?? DEFAULT_SITE_NAME;
  const out = join(ctx.tempDir, "out");
  mkdirSync(join(out, "frames"), { recursive: true });
  mkdirSync(join(out, "sheets"), { recursive: true });
  const prep = await prepareUpload({ ...d.uploads, db: d.db }, job, ctx, src, out);
  let transcript: InputTranscript | null = null;
  let note: string;
  if ("manifest" in prep.transcript) {
    transcript = cleanManifest(src.ref, prep.transcript.manifest);
    note = transcriptNote(transcript);
  } else if (prep.transcript.none === "failed") {
    note = "chưa đọc được (lời thoại là phần thêm: cảnh vẫn dùng được)";
    ctx.logger.warn("upload transcript failed", { asset_id: src.ref, error: prep.transcript.error });
  } else {
    note = src.media_type === "image" ? "ảnh không có tiếng" : "video không có tiếng";
  }
  const shotsFile: InputShots = {
    schema_version: "studio.input-shots/v1", asset_id: src.ref, name: src.label, duration_s: prep.durationS, width: prep.width, height: prep.height,
    fps: prep.fps, has_audio: prep.hasAudio, source: { kind: src.media_type === "image" ? "upload_image" : "upload", watermarked: false },
    scene: { threshold: prep.scene.threshold, min_shot_seconds: prep.scene.minShotS, max_shot_seconds: prep.scene.maxShotS },
    shots: prep.shots, sheets: prep.sheets,
  };
  return writePrepared(d.db, job, ctx, out, shotsFile, transcript, note, site);
}

/**
 * An item of someone's library another project already prepared (plan 2026-10-29): its `inputs/<id>/` copied from that
 * project's workspace (the workspaces sit side by side), no farm job. Null when there is none to copy.
 */
async function copyPrepared(db: StudioDb, job: JobRecord, ctx: JobContext, src: SourceRecord): Promise<JobOutcome | null> {
  const other = await preparedElsewhere(db, src.ref, job.project_id);
  if (!other) return null;
  const from = join(dirname(ctx.workspaceDir), other, inputDir(src.ref));
  const row = await getPrepared(db, other, src.ref);
  if (!row || !existsSync(join(from, "shots.json"))) return null;
  await ctx.report({ phase: "Đang chép bản đã chuẩn bị ở dự án khác", progress: 0.5 });
  const dest = join(ctx.workspaceDir, inputDir(src.ref));
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(ctx.workspaceDir, "inputs"), { recursive: true });
  cpSync(from, dest, { recursive: true });
  const { prepared_at: _at, project_id: _p, ...same } = row;
  await savePrepared(db, { ...same, project_id: job.project_id }, ctx.now());
  await writeVideoIndexesFor(db, ctx.workspaceDir, job.project_id, src.ref);
  await ctx.report({ progress: 1 });
  const name = row.name ?? src.label;
  return {
    result: { asset_id: src.ref, name, shots: row.shots ?? 0, duration_s: row.duration_s, copied_from: other, folder: `${inputDir(src.ref)}/` },
    message: `Đã có **${name}** từ dự án khác (${row.shots ?? 0} cảnh), không phải chuẩn bị lại. Xem \`${inputDir(src.ref)}/README.md\`.`,
  };
}

function transcriptNote(t: InputTranscript): string {
  return t.segments.length ? `${t.segments.length} câu, ngôn ngữ ${t.language ?? "?"}` : "không nghe thấy lời nói";
}

/** The prep's files from `out/` into `inputs/<id>/`, the asset marked ready and its videos' indexes written again. */
async function writePrepared(
  db: StudioDb, job: JobRecord, ctx: JobContext, out: string, shotsFile: InputShots, transcript: InputTranscript | null, note: string, site: string,
): Promise<JobOutcome> {
  const { asset_id: assetId, name } = shotsFile;
  await ctx.checkpoint();
  await ctx.report({ phase: "Đang ghi vào inputs/", progress: IMAGES.to, waiting: false });
  writeFileSync(join(out, "shots.json"), JSON.stringify(shotsFile, null, 2));
  if (transcript) {
    writeFileSync(join(out, "transcript.json"), JSON.stringify(transcript, null, 2));
    writeFileSync(join(out, "transcript.md"), transcriptMarkdown(name, transcript));
  }
  writeFileSync(join(out, "README.md"), inputReadme(shotsFile, transcript, note, ctx.now(), site));

  const dest = join(ctx.workspaceDir, inputDir(assetId));
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(ctx.workspaceDir, "inputs"), { recursive: true });
  cpSync(out, dest, { recursive: true });
  const shots = shotsFile.shots.length;
  await savePrepared(db, {
    project_id: job.project_id, asset_id: assetId, status: "ready", name, duration_s: shotsFile.duration_s, width: shotsFile.width, height: shotsFile.height,
    has_audio: shotsFile.has_audio, shots, transcript: !!transcript && transcript.segments.length > 0,
    source_kind: shotsFile.source.kind, watermarked: shotsFile.source.watermarked, error: null,
  }, ctx.now());
  await writeVideoIndexesFor(db, ctx.workspaceDir, job.project_id, assetId);
  await ctx.report({ progress: 1 });
  return {
    result: { asset_id: assetId, name, shots, duration_s: shotsFile.duration_s, transcript: note, folder: `${inputDir(assetId)}/` },
    message: `Đã chuẩn bị **${name}** (${clock(shotsFile.duration_s)}): ${shots} cảnh, lời thoại: ${note}. Xem \`${inputDir(assetId)}/README.md\`.`,
  };
}

/**
 * The ready prep of the asset: read from ag-go; when it has none yet (or is behind a backfill) ag-go is asked once to
 * run it now, then asked again every `pollMs` until it is ready, failed, or `maxWaitMs` passed.
 */
async function readyPrep(
  d: PrepareDeps & { preps: AgGoPreps }, ctx: JobContext, from: { projectIds: string[]; requestedBy: string }, assetId: string, site: string, durationS: number | null,
): Promise<NonNullable<AgGoPrepItem["prep"]>> {
  await ctx.report({ phase: `Đang hỏi ${site}`, progress: 0 });
  const pick = (r: { items: AgGoPrepItem[] }): AgGoPrepItem => {
    const item = r.items.find((i) => i.assetId === assetId);
    if (!item) throw new Error(`${site} không trả lời về video này`);
    return item;
  };
  const ask = async (how: "read" | "run"): Promise<AgGoPrepItem> => {
    try {
      const call = () => (how === "read" ? d.preps.read(from.projectIds, [assetId]) : d.preps.run(from.projectIds, [assetId], from.requestedBy));
      return pick(await retryBusy(call, ctx.signal, d.retryDelaysMs));
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw new Error(`video không thuộc project ${site} nào của dự án (hoặc không còn trên ${site}): thêm project chứa nó ở tab Nguồn`);
      throw e;
    }
  };
  let item = await ask("read");
  let asked = false;
  const until = Date.now() + (d.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    await ctx.checkpoint();
    if (item.state === "ready" && item.prep) return item.prep;
    if (!asked) {
      // a prep that has to run first: its length gives the time left until ag-go reports progress
      asked = true;
      if (durationS) await ctx.setUnits(durationS);
      item = await ask("run");
      continue;
    }
    if (item.state === "failed") throw new Error(`${site} không chuẩn bị được video này${item.error ? `: ${item.error}` : ""}`);
    if (item.state === "missing") throw new Error(`${site} chưa nhận chuẩn bị video này; thử lại sau`);
    const phase = PHASE[item.phase ?? "queued"];
    await ctx.report({
      phase: phase.text, progress: phase.from + (phase.to - phase.from) * Math.max(0, Math.min(1, item.progress ?? 0)),
      waiting: (item.phase ?? "queued") === "queued",
    });
    if (Date.now() >= until) throw new Error(`${site} chưa chuẩn bị xong video này sau ${Math.round((d.maxWaitMs ?? MAX_WAIT_MS) / 60_000)} phút; thử lại sau`);
    await pause(d.pollMs ?? POLL_MS, ctx.signal);
    await ctx.checkpoint();
    item = await ask("read");
  }
}

/**
 * `fn`, tried again after each of `delays` while it fails with an HTTP status ag-go answers when it is busy (the
 * error's `status`: 429, 502, 503, 504). Any other failure, a stopped job, or the last try's failure is thrown. On
 * prod several prepares at once, eight image downloads each, drew 503s that failed the whole prepare.
 */
export async function retryBusy<T>(fn: () => Promise<T>, signal: AbortSignal, delays: readonly number[] = RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (typeof status !== "number" || !RETRY_STATUS.has(status) || attempt >= delays.length || signal.aborted) throw e;
      await pause(delays[attempt]!, signal);
      if (signal.aborted) throw e;
    }
  }
}

/** Waits `ms`, less when the job is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(() => { signal.removeEventListener("abort", stop); res(); }, ms);
    const stop = () => { clearTimeout(t); res(); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The frames and sheets of the prep into `out/`, `DOWNLOAD_LANES` at once from their signed URLs. */
async function downloadImages(d: PrepareDeps, ctx: JobContext, prep: NonNullable<AgGoPrepItem["prep"]>, out: string, site: string): Promise<void> {
  const images = [...prep.shots.map((s) => ({ path: s.frame, url: s.url })), ...prep.sheets.map((s) => ({ path: s.file, url: s.url }))];
  for (const i of images) if (!IMAGE_PATH.test(i.path)) throw new Error(`${site} trả về đường dẫn ảnh lạ: ${i.path}`);
  mkdirSync(join(out, "frames"), { recursive: true });
  mkdirSync(join(out, "sheets"), { recursive: true });
  await ctx.report({ phase: "Đang tải khung hình", progress: IMAGES.from, waiting: false });
  let next = 0;
  let done = 0;
  let broken = false;
  let lastShown = 0;
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(DOWNLOAD_LANES, images.length) }, async () => {
    while (!broken && next < images.length) {
      const img = images[next++]!;
      try {
        await ctx.checkpoint();
        const dest = join(out, img.path);
        mkdirSync(dirname(dest), { recursive: true });
        await retryBusy(() => d.download(img.url, dest, ctx.signal), ctx.signal, d.retryDelaysMs);
      } catch (e) {
        broken = true;
        throw e;
      }
      done++;
      if (Date.now() - lastShown >= 500 || done === images.length) {
        lastShown = Date.now();
        await ctx.report({ phase: `Đang tải khung hình (${done}/${images.length})`, progress: IMAGES.from + (IMAGES.to - IMAGES.from) * (done / images.length) });
      }
    }
  }));
  const failed = lanes.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await ctx.checkpoint();
    throw failed.reason;
  }
}

/** ag-go's raw WhisperX transcript, cleaned of what nobody said (`transcript-clean.ts`), as `transcript.json`. */
function cleanTranscript(projectId: string, assetId: string, t: NonNullable<NonNullable<AgGoPrepItem["prep"]>["transcript"]>): InputTranscript {
  return cleanManifest(assetId, {
    schema: TRANSCRIBE_MANIFEST_SCHEMA, production_id: projectId, engine: { name: t.engine, version: null },
    sources: [{
      source_id: assetId, language: t.language, alignment: t.alignment,
      segments: t.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words ?? [] })),
    }],
  });
}

/** A farm transcript of one footage (its source `assetId`), cleaned, as `transcript.json`. */
function cleanManifest(assetId: string, manifest: TranscribeManifest): InputTranscript {
  const one = { ...manifest, sources: manifest.sources.filter((s) => s.source_id === assetId) };
  if (!one.sources.length) throw new Error("máy farm không trả lời thoại của video này");
  const { manifest: clean, report } = cleanTranscribeManifest(one);
  const src = clean.sources[0]!;
  return {
    schema_version: "studio.input-transcript/v1", asset_id: assetId, language: src.language, alignment: src.alignment,
    engine: clean.engine.name, segments: src.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words })),
    dropped: report.dropped.length,
  };
}

export function transcriptMarkdown(name: string, t: InputTranscript): string {
  const lines = [`# Lời thoại — ${name}`, "", `Ngôn ngữ: ${t.language ?? "?"} · căn theo ${t.alignment === "word" ? "từng từ" : "câu"} · ${t.engine}${t.dropped ? ` · bỏ ${t.dropped} câu nghe nhầm` : ""}`, ""];
  for (const g of t.segments) lines.push(`- [${clock(g.start)}–${clock(g.end)}] ${g.text.trim()}`);
  if (!t.segments.length) lines.push("_Không nghe thấy lời nói._");
  return lines.join("\n") + "\n";
}

export function inputReadme(s: InputShots, t: InputTranscript | null, transcriptNote: string, now: string, siteName: string = DEFAULT_SITE_NAME): string {
  const size = s.width && s.height ? `${s.width}×${s.height}` : "?";
  const source = s.source.kind === "original" ? "bản gốc" : s.source.kind === "proxy" ? "bản proxy" : "bản xem trước";
  const uploaded = s.source.kind === "upload" || s.source.kind === "upload_image";
  const what = s.source.kind === "upload_image" ? "Ảnh tải từ máy" : uploaded ? "Video tải từ máy" : `Video ${siteName}`;
  const lines = [
    `# ${s.name}`,
    "",
    `${what} \`${s.asset_id}\`, Studio chuẩn bị ${now.slice(0, 16).replace("T", " ")} UTC. Thư mục này chỉ đọc; chuẩn bị lại để cập nhật.`,
    "",
    `- Dài ${clock(s.duration_s)} · ${size}${s.fps ? ` · ${s.fps} fps` : ""} · ${s.has_audio ? "có tiếng" : "không tiếng"}`,
    s.source.kind === "upload_image"
      ? `- Studio làm từ ảnh một clip ${clock(s.duration_s)} đẩy vào chậm (một cảnh): dùng như một shot ngắn 2–5 s, đừng để ảnh tĩnh đứng lâu.`
      : uploaded
        ? "- Máy farm cắt cảnh, lấy khung hình và đọc lời thoại từ chính file tải lên; bản render dùng file đó."
        : `- Cảnh, khung hình và lời thoại do ${siteName} chuẩn bị sẵn từ ${source}${s.source.watermarked ? " (có watermark)" : ""} — chỉ để chọn cảnh; bản cuối render từ bản gốc.`,
    `- ${s.shots.length} cảnh (\`shots.json\`): khung giữa mỗi cảnh \`frames/NNN.jpg\`, tờ ghép ${CUT_SHEET_SHOTS} cảnh \`sheets/NN.jpg\`.`,
    `- Lời thoại: ${t ? `\`transcript.md\` (${transcriptNote})` : transcriptNote}.`,
    "",
    "## Cảnh",
    "",
    "| # | Từ | Đến | Dài | Khung |",
    "|---|---|---|---|---|",
    ...s.shots.map((x) => `| ${x.n} | ${clock(x.in)} | ${clock(x.out)} | ${(x.out - x.in).toFixed(1)} s | ${x.frame} |`),
    "",
    "## Tờ ghép",
    "",
    ...s.sheets.map((x) => `- \`${x.file}\`: cảnh ${x.shots[0]}–${x.shots[x.shots.length - 1]}`),
    "",
  ];
  return lines.join("\n");
}
