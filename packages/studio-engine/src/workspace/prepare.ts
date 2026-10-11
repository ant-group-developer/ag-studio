/**
 * Preparing an ag-go video for a project (spec 2026-10-10 agent-workspace §4, job `prepare_asset`): what Claude needs
 * to choose shots, written once per project into `inputs/<assetId>/` and read by every video of the project:
 *
 *   README.md        what the video is, its shots, where the files are
 *   shots.json       shots found where the picture changes (`buildShots`, the shot-cut defaults)
 *   frames/NNN.jpg   the middle frame of each shot
 *   sheets/NN.jpg    contact sheets of 16 shots
 *   transcript.json  what is said (farm `studio.transcribe`, cleaned), transcript.md the same to read
 *
 * The video is fetched as ag-go serves it for previews (a clean 480p rendition preferred, else the nearest), looked at
 * here with ffmpeg and deleted: the final render reads the original through `/farm/sign`.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUT_FRAME_WIDTH, CUT_SHEET_COLS, CUT_SHEET_SHOTS } from "@harness/contracts";
import { StudioTranscribePayloadSchema, TRANSCRIBE_MANIFEST_PATH, TranscribeManifestSchema, type TranscribeManifest } from "@ag-farm/protocol";
import { buildShots, studioSourceId } from "@harness/core";
import type { StudioBucket } from "../bucket.js";
import { CUT_SCENE, CUT_TRANSCRIBE_MODEL, type ResolvedFootage } from "../media-deps.js";
import { detectCuts, extractAudio16k, grabFrame, probeMedia, tileSheet, type MediaFacts } from "../cut-ffmpeg.js";
import { cleanTranscribeManifest } from "../transcript-clean.js";
import type { StudioDb } from "../studio-db.js";
import { ackFarmJob, JobStopped, runFarmStep, type ProjectFarm } from "./farm.js";
import type { JobContext, JobOutcome } from "./job-runner.js";
import type { JobRecord } from "./jobs-db.js";
import { projectActAs, savePrepared } from "./sources-db.js";
import { writeVideoIndexesFor } from "./video-index.js";

/** What a preview fetch asks ag-go for (P7); an ag-go without it serves its default preview. */
export const PREVIEW_PREFER = { short_edge: 480, clean: true } as const;

/** What preparing needs on the worker. */
export interface PrepareDeps {
  db: StudioDb;
  ffmpeg: string;
  ffprobe: string;
  /** ag-go resolve for previews, acting as `actAs` (the project's owner). */
  resolve(actAs: string, assetIds: string[]): Promise<{ items: ResolvedFootage[]; missing: string[] }>;
  download(url: string, dest: string, signal: AbortSignal, onBytes: (received: number, total: number | null) => void): Promise<void>;
  /** The farm reads what is said; without it there is no transcript (README says so). */
  farm?: { client: ProjectFarm; bucket: StudioBucket; pollMs?: number; queueTimeoutMs?: number };
}

/** `request` of a `prepare_asset` job. */
export interface PrepareRequest {
  asset_id: string;
  /** ag-go's name of the video, when known. */
  name?: string | null;
  /** ag-go says whether people speak in it: `false` skips the transcription. */
  has_speech?: boolean | null;
  duration_s?: number | null;
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
  source: { kind: ResolvedFootage["sourceKind"]; watermarked: boolean };
  scene: typeof CUT_SCENE;
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

const pad3 = (n: number) => String(n).padStart(3, "0");
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Progress of the steps, so a job without a transcription still ends at 1. */
const SPAN = { resolve: [0, 0.02], download: [0.02, 0.15], scenes: [0.15, 0.4], frames: [0.4, 0.6], sheets: [0.6, 0.65], audio: [0.65, 0.68], farm: [0.68, 0.97], write: [0.97, 1] } as const;
const at = (step: keyof typeof SPAN, f: number) => SPAN[step][0] + (SPAN[step][1] - SPAN[step][0]) * Math.max(0, Math.min(1, f));

/** The `prepare_asset` handler: a failure (not a stop) is recorded for the asset, so its videos' index says why. */
export function prepareHandler(d: PrepareDeps): (job: JobRecord, ctx: JobContext) => Promise<JobOutcome> {
  return async (job, ctx) => {
    try {
      return await prepareAsset(d, job, ctx);
    } catch (e) {
      const req = JSON.parse(job.request) as PrepareRequest;
      if (!(e instanceof JobStopped) && !ctx.stopRequested() && ASSET_ID.test(req.asset_id)) {
        savePrepared(d.db, {
          project_id: job.project_id, asset_id: req.asset_id, status: "failed", name: req.name ?? null, duration_s: req.duration_s ?? null, width: null, height: null,
          has_audio: null, shots: null, transcript: 0, source_kind: null, watermarked: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        }, ctx.now());
        writeVideoIndexesFor(d.db, ctx.workspaceDir, job.project_id, req.asset_id);
      }
      throw e;
    }
  };
}

export async function prepareAsset(d: PrepareDeps, job: JobRecord, ctx: JobContext): Promise<JobOutcome> {
  const req = JSON.parse(job.request) as PrepareRequest;
  const assetId = req.asset_id;
  if (!ASSET_ID.test(assetId)) throw new Error(`id video ag-go không hợp lệ: ${assetId}`);
  const actAs = projectActAs(d.db, job.project_id);
  if (!actAs) throw new Error("dự án chưa có chủ để hỏi ag-go");
  if (req.duration_s) ctx.setUnits(req.duration_s);

  ctx.report({ phase: "Lấy link video từ ag-go", progress: at("resolve", 0) });
  const resolved = await d.resolve(actAs, [assetId]);
  const item = resolved.items.find((i) => i.assetId === assetId);
  if (!item || resolved.missing.includes(assetId)) throw new Error("ag-go không trả được video này cho chủ dự án (không có quyền hoặc chưa có bản xem)");
  ctx.checkpoint();

  const proxy = join(ctx.tempDir, "video.mp4");
  let lastShown = 0;
  ctx.report({ phase: "Đang tải video", progress: at("download", 0) });
  await d.download(item.url, proxy, ctx.signal, (got, total) => {
    if (Date.now() - lastShown < 500) return;
    lastShown = Date.now();
    const mb = (got / 1_048_576).toFixed(1);
    ctx.report({ phase: total ? `Đang tải video (${mb}/${(total / 1_048_576).toFixed(1)} MB)` : `Đang tải video (${mb} MB)`, progress: total ? at("download", got / total) : null });
  });
  ctx.checkpoint();

  const facts: MediaFacts | null = await probeMedia(d.ffprobe, proxy);
  if (!facts || facts.duration_s === null) throw new Error("không đọc được video tải về (ffprobe)");
  const duration = facts.duration_s;
  ctx.setUnits(duration);
  const name = req.name?.trim() || assetId;

  ctx.report({ phase: "Đang dò cảnh", progress: at("scenes", 0) });
  const cuts = await detectCuts(d.ffmpeg, proxy, CUT_SCENE.threshold, ctx.signal, (t) => {
    if (Date.now() - lastShown < 500) return;
    lastShown = Date.now();
    ctx.report({ phase: `Đang dò cảnh (${clock(Math.min(t, duration))} / ${clock(duration)})`, progress: at("scenes", t / duration) });
  });
  ctx.checkpoint();
  const found = buildShots(cuts, duration, CUT_SCENE);

  const out = join(ctx.tempDir, "out");
  mkdirSync(join(out, "frames"), { recursive: true });
  const shots: InputShot[] = [];
  for (const [i, s] of found.entries()) {
    ctx.checkpoint();
    const n = i + 1;
    const frame = `frames/${pad3(n)}.jpg`;
    const t = Math.round(((s.in + s.out) / 2) * 1000) / 1000;
    await grabFrame(d.ffmpeg, proxy, t, join(out, frame), CUT_FRAME_WIDTH);
    shots.push({ n, in: s.in, out: s.out, frame });
    if (n % 5 === 0 || n === found.length) ctx.report({ phase: `Đang lấy khung hình (cảnh ${n}/${found.length})`, progress: at("frames", n / found.length) });
  }

  const sheets: InputShots["sheets"] = [];
  for (let k = 0; k < shots.length; k += CUT_SHEET_SHOTS) {
    ctx.checkpoint();
    const group = shots.slice(k, k + CUT_SHEET_SHOTS);
    const file = `sheets/${pad2(sheets.length + 1)}.jpg`;
    await tileSheet(d.ffmpeg, group.map((s) => join(out, s.frame)), CUT_SHEET_COLS, join(out, file));
    sheets.push({ file, shots: group.map((s) => s.n) });
    ctx.report({ phase: `Đang ghép tờ cảnh ${sheets.length}/${Math.ceil(shots.length / CUT_SHEET_SHOTS)}`, progress: at("sheets", (k + group.length) / shots.length) });
  }

  // what is said: only when it has sound, ag-go does not say nobody speaks, and the worker has a farm
  let transcript: InputTranscript | null = null;
  let transcriptNote: string;
  if (!facts.has_audio) transcriptNote = "video không có tiếng";
  else if (req.has_speech === false) transcriptNote = "ag-go cho biết video không có lời nói";
  else if (!d.farm) transcriptNote = "worker này không nối farm nên chưa đọc lời thoại";
  else {
    ctx.report({ phase: "Đang tách tiếng", progress: at("audio", 0) });
    const sourceId = studioSourceId(assetId);
    const wav = join(ctx.tempDir, "audio", `${sourceId}.wav`);
    if (!(await extractAudio16k(d.ffmpeg, proxy, wav, ctx.signal))) {
      transcriptNote = "video không có tiếng";
    } else {
      ctx.checkpoint();
      const payload = StudioTranscribePayloadSchema.parse({
        production_id: job.project_id, model: CUT_TRANSCRIBE_MODEL, align_words: true,
        sources: [{ source_id: sourceId, audio: `stage:audio/${sourceId}.wav`, language: null }],
      });
      // what is said is a help, not a must: the shots stay usable when the farm cannot read it (README says why)
      const said = await transcribeOnFarm(d.db, d.farm, job, ctx, sourceId, assetId, wav, payload).catch((e: unknown) => {
        if (e instanceof JobStopped) throw e;
        ctx.logger.warn("transcription failed", { error: e instanceof Error ? e.message : String(e) });
        return { failed: e instanceof Error ? e.message : String(e) };
      });
      if ("failed" in said) {
        transcriptNote = `chưa đọc được (${said.failed}); chuẩn bị lại để thử`;
      } else {
        transcript = said;
        transcriptNote = said.segments.length ? `${said.segments.length} câu, ngôn ngữ ${said.language ?? "?"}` : "không nghe thấy lời nói";
      }
    }
  }

  ctx.checkpoint();
  ctx.report({ phase: "Đang ghi vào inputs/", progress: at("write", 0), waiting: false });


  const shotsFile: InputShots = {
    schema_version: "studio.input-shots/v1", asset_id: assetId, name, duration_s: duration, width: facts.width, height: facts.height, fps: facts.fps,
    has_audio: facts.has_audio, source: { kind: item.sourceKind, watermarked: item.watermarked }, scene: CUT_SCENE, shots, sheets,
  };
  writeFileSync(join(out, "shots.json"), JSON.stringify(shotsFile, null, 2));
  if (transcript) {
    writeFileSync(join(out, "transcript.json"), JSON.stringify(transcript, null, 2));
    writeFileSync(join(out, "transcript.md"), transcriptMarkdown(name, transcript));
  }
  const bytes = statSync(proxy).size;
  writeFileSync(join(out, "README.md"), inputReadme(shotsFile, transcript, transcriptNote, ctx.now(), bytes));
  rmSync(proxy, { force: true });

  const dest = join(ctx.workspaceDir, inputDir(assetId));
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(ctx.workspaceDir, "inputs"), { recursive: true });
  cpSync(out, dest, { recursive: true });
  savePrepared(d.db, {
    project_id: job.project_id, asset_id: assetId, status: "ready", name, duration_s: duration, width: facts.width, height: facts.height,
    has_audio: facts.has_audio ? 1 : 0, shots: shots.length, transcript: transcript && transcript.segments.length ? 1 : 0,
    source_kind: item.sourceKind, watermarked: item.watermarked ? 1 : 0, error: null,
  }, ctx.now());
  writeVideoIndexesFor(d.db, ctx.workspaceDir, job.project_id, assetId);
  ctx.report({ progress: 1 });
  return {
    result: { asset_id: assetId, name, shots: shots.length, duration_s: duration, transcript: transcriptNote, folder: `${inputDir(assetId)}/` },
    message: `Đã chuẩn bị **${name}** (${clock(duration)}): ${shots.length} cảnh, lời thoại: ${transcriptNote}. Xem \`${inputDir(assetId)}/README.md\`.`,
  };
}

/** The farm's `studio.transcribe` of one sound file, cleaned of what nobody said. */
async function transcribeOnFarm(
  db: StudioDb, farm: NonNullable<PrepareDeps["farm"]>, job: JobRecord, ctx: JobContext, sourceId: string, assetId: string, wav: string, payload: unknown,
): Promise<InputTranscript> {
  const { outputPrefix, farmJob } = await runFarmStep(
    { db, bucket: farm.bucket, farm: farm.client, ...(farm.pollMs ? { pollMs: farm.pollMs } : {}), ...(farm.queueTimeoutMs ? { queueTimeoutMs: farm.queueTimeoutMs } : {}), now: ctx.now },
    job, { type: "studio.transcribe", payload, stageKey: "prepare", attemptId: job.id, uploads: [{ localPath: wav, relPath: `audio/${sourceId}.wav` }] },
    {
      onUpdate: (u) => ctx.report({ phase: `${u.phase} · đọc lời thoại`, progress: at("farm", u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
      stopRequested: ctx.stopRequested,
    },
  );
  const manifest: TranscribeManifest = TranscribeManifestSchema.parse(JSON.parse((await farm.bucket.get(`${outputPrefix}${TRANSCRIBE_MANIFEST_PATH}`)).toString("utf8")));
  await ackFarmJob(farm.client, farmJob.id);
  const { manifest: clean, report } = cleanTranscribeManifest(manifest);
  const src = clean.sources.find((s) => s.source_id === sourceId);
  return {
    schema_version: "studio.input-transcript/v1", asset_id: assetId, language: src?.language ?? null, alignment: src?.alignment ?? "segment",
    engine: clean.engine.name, segments: (src?.segments ?? []).map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words })),
    dropped: report.dropped.length,
  };
}

export function transcriptMarkdown(name: string, t: InputTranscript): string {
  const lines = [`# Lời thoại — ${name}`, "", `Ngôn ngữ: ${t.language ?? "?"} · căn theo ${t.alignment === "word" ? "từng từ" : "câu"} · ${t.engine}${t.dropped ? ` · bỏ ${t.dropped} câu nghe nhầm` : ""}`, ""];
  for (const g of t.segments) lines.push(`- [${clock(g.start)}–${clock(g.end)}] ${g.text.trim()}`);
  if (!t.segments.length) lines.push("_Không nghe thấy lời nói._");
  return lines.join("\n") + "\n";
}

export function inputReadme(s: InputShots, t: InputTranscript | null, transcriptNote: string, now: string, bytes: number): string {
  const size = s.width && s.height ? `${s.width}×${s.height}` : "?";
  const source = s.source.kind === "original" ? "bản gốc" : s.source.kind === "proxy" ? "bản proxy" : "bản xem trước";
  const lines = [
    `# ${s.name}`,
    "",
    `Video ag-go \`${s.asset_id}\`, Studio chuẩn bị ${now.slice(0, 16).replace("T", " ")} UTC. Thư mục này chỉ đọc; chuẩn bị lại để cập nhật.`,
    "",
    `- Dài ${clock(s.duration_s)} · ${size}${s.fps ? ` · ${s.fps} fps` : ""} · ${s.has_audio ? "có tiếng" : "không tiếng"}`,
    `- Xem từ ${source} ${size}${s.source.watermarked ? " (có watermark)" : ""}, ${(bytes / 1_048_576).toFixed(1)} MB — chỉ để chọn cảnh; bản cuối render từ bản gốc.`,
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
