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
 * here with ffmpeg and deleted: the final render reads the original through `/farm/sign`. Its sound goes to the farm
 * as soon as it is downloaded, so what is said is read while the shots are found here.
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
import { DEFAULT_SITE_NAME } from "../site-name.js";
import { ackFarmJob, JobStopped, runFarmStep, type FarmWatch, type ProjectFarm } from "./farm.js";
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
  /** What people call the footage library (ag-go's `siteName`), for job text and README; default "AG Go". */
  siteName?: () => string;
  /**
   * A turn at decoding the video here (scenes, frames, sheets), shared by the worker's prepare jobs so more jobs at
   * once (idle farm machines) do not crowd its CPU; default: no limit.
   */
  decodeSlot?: <T>(task: () => Promise<T>) => Promise<T>;
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

/**
 * Progress of the steps. `work` is the shots found here and what is said read on the farm, side by side: the shots
 * weigh `LOCAL_SHARE` of it when there is a transcription, all of it when there is none (so the job still ends at 1).
 */
const SPAN = { resolve: [0, 0.02], download: [0.02, 0.15], audio: [0.15, 0.17], work: [0.17, 0.97], write: [0.97, 1] } as const;
const LOCAL = { scenes: [0, 0.6], frames: [0.6, 0.93], sheets: [0.93, 1] } as const;
const LOCAL_SHARE = 0.6;
const clamp01 = (f: number) => Math.max(0, Math.min(1, f));
const at = (step: keyof typeof SPAN, f: number) => SPAN[step][0] + (SPAN[step][1] - SPAN[step][0]) * clamp01(f);
const local = (step: keyof typeof LOCAL, f: number) => LOCAL[step][0] + (LOCAL[step][1] - LOCAL[step][0]) * clamp01(f);

/** Frames grabbed at once inside one job (each a short seek and decode). */
const FRAME_LANES = 4;

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
  const site = d.siteName?.() ?? DEFAULT_SITE_NAME;
  if (!ASSET_ID.test(assetId)) throw new Error(`id video ${site} không hợp lệ: ${assetId}`);
  const actAs = projectActAs(d.db, job.project_id);
  if (!actAs) throw new Error(`dự án chưa có chủ để hỏi ${site}`);
  if (req.duration_s) ctx.setUnits(req.duration_s);

  ctx.report({ phase: `Lấy link video từ ${site}`, progress: at("resolve", 0) });
  const resolved = await d.resolve(actAs, [assetId]);
  const item = resolved.items.find((i) => i.assetId === assetId);
  if (!item || resolved.missing.includes(assetId)) throw new Error(`${site} không trả được video này cho chủ dự án (không có quyền hoặc chưa có bản xem)`);
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

  // what the job shows: the shots found here and what is said read on the farm, both at once
  const view = {
    local: { state: "queued" as "queued" | "working" | "done", phase: null as string | null, f: 0 },
    farm: { state: "off" as "off" | "waiting" | "working" | "done", phase: null as string | null, f: 0, node: undefined as string | null | undefined, farmJobId: undefined as string | undefined },
  };
  const show = () => ctx.report({
    phase: [view.local.state === "done" ? null : view.local.phase, view.farm.phase].filter(Boolean).join(" · ") || "Đang chuẩn bị",
    progress: at("work", view.farm.state === "off" ? view.local.f : LOCAL_SHARE * view.local.f + (1 - LOCAL_SHARE) * view.farm.f),
    ...(view.farm.node !== undefined ? { node: view.farm.node } : {}), ...(view.farm.farmJobId ? { farmJobId: view.farm.farmJobId } : {}),
    // the time left is told only while something works: not while both wait for a turn
    waiting: view.local.state !== "working" && view.farm.state !== "working",
  });

  // what is said goes to the farm first (only when it has sound, ag-go does not say nobody speaks, and the worker has
  // a farm), so it is read while the shots are found here
  let transcriptNote: string | null = null;
  let hearing: Promise<{ said: InputTranscript } | { failed: string } | { stopped: unknown }> | null = null;
  let localFailed = false;
  if (!facts.has_audio) transcriptNote = "video không có tiếng";
  else if (req.has_speech === false) transcriptNote = `${site} cho biết video không có lời nói`;
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
      view.farm.state = "waiting";
      // what is said is a help, not a must: the shots stay usable when the farm cannot read it (README says why);
      // settled here so a stop or failure while the shots are found is never an unhandled rejection
      hearing = transcribeOnFarm(d.db, d.farm, job, ctx.now, sourceId, assetId, wav, payload, {
        onUpdate: (u) => {
          view.farm = { ...view.farm, state: u.waiting ? "waiting" : "working", phase: `${u.phase} · đọc lời thoại`, f: u.progress ?? view.farm.f, node: u.node, farmJobId: u.farmJobId };
          show();
        },
        // shots that cannot be found end the job: what the farm reads is then cancelled too
        stopRequested: () => ctx.stopRequested() ?? (localFailed ? "cancelled" : null),
      }).then(
        (said) => ({ said }),
        (e: unknown) => {
          if (e instanceof JobStopped) return { stopped: e };
          ctx.logger.warn("transcription failed", { error: e instanceof Error ? e.message : String(e) });
          return { failed: e instanceof Error ? e.message : String(e) };
        },
      ).finally(() => {
        view.farm = { ...view.farm, state: "done", phase: view.local.state === "done" ? null : "đã đọc lời thoại", f: 1 };
      });
    }
  }

  const out = join(ctx.tempDir, "out");
  let found: { shots: InputShot[]; sheets: InputShots["sheets"] };
  try {
    found = await findShots(d, proxy, duration, out, ctx, (state, phase, f, force) => {
      view.local = { state, phase, f };
      if (!force && Date.now() - lastShown < 500) return;
      lastShown = Date.now();
      show();
    });
  } catch (e) {
    localFailed = true;
    await hearing;
    throw e;
  }
  const { shots, sheets } = found;

  let transcript: InputTranscript | null = null;
  if (hearing) {
    if (view.farm.state !== "done") show();
    const heard = await hearing;
    if ("stopped" in heard) throw heard.stopped;
    if ("failed" in heard) {
      transcriptNote = `chưa đọc được (${heard.failed}); chuẩn bị lại để thử`;
    } else {
      transcript = heard.said;
      transcriptNote = heard.said.segments.length ? `${heard.said.segments.length} câu, ngôn ngữ ${heard.said.language ?? "?"}` : "không nghe thấy lời nói";
    }
  }
  const note = transcriptNote ?? "không nghe thấy lời nói";

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
  writeFileSync(join(out, "README.md"), inputReadme(shotsFile, transcript, note, ctx.now(), bytes, site));
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
    result: { asset_id: assetId, name, shots: shots.length, duration_s: duration, transcript: note, folder: `${inputDir(assetId)}/` },
    message: `Đã chuẩn bị **${name}** (${clock(duration)}): ${shots.length} cảnh, lời thoại: ${note}. Xem \`${inputDir(assetId)}/README.md\`.`,
  };
}

/**
 * Scenes, the middle frame of each shot (`FRAME_LANES` at once) and the contact sheets, decoded here in one turn of
 * `decodeSlot`. `onStep` tells where it is (`force`: show it now, not throttled).
 */
async function findShots(
  d: PrepareDeps, proxy: string, duration: number, out: string, ctx: JobContext,
  onStep: (state: "queued" | "working" | "done", phase: string | null, f: number, force?: boolean) => void,
): Promise<{ shots: InputShot[]; sheets: InputShots["sheets"] }> {
  const slot = d.decodeSlot ?? (<T>(task: () => Promise<T>) => task());
  onStep("queued", "Chờ lượt dò cảnh trên worker", 0, true);
  const result = await slot(async () => {
    ctx.checkpoint();
    onStep("working", "Đang dò cảnh", local("scenes", 0), true);
    const cuts = await detectCuts(d.ffmpeg, proxy, CUT_SCENE.threshold, ctx.signal, (t) => {
      onStep("working", `Đang dò cảnh (${clock(Math.min(t, duration))} / ${clock(duration)})`, local("scenes", t / duration));
    });
    ctx.checkpoint();
    const shots: InputShot[] = buildShots(cuts, duration, CUT_SCENE).map((s, i) => ({ n: i + 1, in: s.in, out: s.out, frame: `frames/${pad3(i + 1)}.jpg` }));

    mkdirSync(join(out, "frames"), { recursive: true });
    let next = 0;
    let grabbed = 0;
    let broken = false;
    const lanes = await Promise.allSettled(Array.from({ length: Math.min(FRAME_LANES, shots.length) }, async () => {
      while (!broken && next < shots.length) {
        const s = shots[next++]!;
        try {
          ctx.checkpoint();
          await grabFrame(d.ffmpeg, proxy, Math.round(((s.in + s.out) / 2) * 1000) / 1000, join(out, s.frame), CUT_FRAME_WIDTH);
        } catch (e) {
          broken = true;
          throw e;
        }
        grabbed++;
        if (grabbed % 5 === 0 || grabbed === shots.length) onStep("working", `Đang lấy khung hình (cảnh ${grabbed}/${shots.length})`, local("frames", grabbed / shots.length));
      }
    }));
    const failed = lanes.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;

    const sheets: InputShots["sheets"] = [];
    for (let k = 0; k < shots.length; k += CUT_SHEET_SHOTS) {
      ctx.checkpoint();
      const group = shots.slice(k, k + CUT_SHEET_SHOTS);
      const file = `sheets/${pad2(sheets.length + 1)}.jpg`;
      await tileSheet(d.ffmpeg, group.map((s) => join(out, s.frame)), CUT_SHEET_COLS, join(out, file));
      sheets.push({ file, shots: group.map((s) => s.n) });
      onStep("working", `Đang ghép tờ cảnh ${sheets.length}/${Math.ceil(shots.length / CUT_SHEET_SHOTS)}`, local("sheets", (k + group.length) / shots.length), true);
    }
    return { shots, sheets };
  });
  onStep("done", null, 1, true);
  return result;
}

/** The farm's `studio.transcribe` of one sound file, cleaned of what nobody said. */
async function transcribeOnFarm(
  db: StudioDb, farm: NonNullable<PrepareDeps["farm"]>, job: JobRecord, now: () => string, sourceId: string, assetId: string, wav: string, payload: unknown,
  watch: FarmWatch,
): Promise<InputTranscript> {
  const { outputPrefix, farmJob } = await runFarmStep(
    { db, bucket: farm.bucket, farm: farm.client, ...(farm.pollMs ? { pollMs: farm.pollMs } : {}), ...(farm.queueTimeoutMs ? { queueTimeoutMs: farm.queueTimeoutMs } : {}), now },
    job, { type: "studio.transcribe", payload, stageKey: "prepare", attemptId: job.id, uploads: [{ localPath: wav, relPath: `audio/${sourceId}.wav` }] },
    watch,
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

export function inputReadme(s: InputShots, t: InputTranscript | null, transcriptNote: string, now: string, bytes: number, siteName: string = DEFAULT_SITE_NAME): string {
  const size = s.width && s.height ? `${s.width}×${s.height}` : "?";
  const source = s.source.kind === "original" ? "bản gốc" : s.source.kind === "proxy" ? "bản proxy" : "bản xem trước";
  const lines = [
    `# ${s.name}`,
    "",
    `Video ${siteName} \`${s.asset_id}\`, Studio chuẩn bị ${now.slice(0, 16).replace("T", " ")} UTC. Thư mục này chỉ đọc; chuẩn bị lại để cập nhật.`,
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
