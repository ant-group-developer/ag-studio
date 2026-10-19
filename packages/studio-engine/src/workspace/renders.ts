/**
 * Renders of a project's video (spec 2026-10-10 agent-workspace §P6): a preview (the agent or a person starts it), the
 * final render and the Premiere export (both after a person confirmed a card). Each is a background job that turns the
 * video's timeline (one revision) into a farm job — the same composition and narration uploads as the episode renders
 * (`prepareRender`, `narrationUploads`), keyed under the project — waits for it, and keeps where the file landed in the
 * job's result. A short note goes to `videos/<id>/renders/` for the agent to read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError, RenderInspectionSchema, type RenderInspection, type RenderInspectIssue, type StoredTimeline } from "@harness/contracts";
import { compositionFeatureLevel, isTimelineV4, RENDER_PREMIERE_SCALE_LEVEL, layoutTimeline, timelineIssues, timelineToComposition, youtubeChapters } from "@harness/core";
import { PREMIERE_MANIFEST_PATH, PremiereManifestSchema, RENDER_MANIFEST_PATH, RenderManifestSchema, type RenderManifest, type StudioExportPremierePayload } from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import { narrationUploads, prepareRender, renderCanvas, type RenderResolution } from "../payloads.js";
import type { StudioDb } from "../studio-db.js";
import { writeWorkspaceFile } from "./files.js";
import { ackFarmJob, runFarmStep, type ProjectFarm } from "./farm.js";
import type { JobContext, JobHandler } from "./job-runner.js";
import { createJob, getJob, listJobs, type JobKind, type JobRecord } from "./jobs-db.js";
import { getVideoRevision, latestVideoRevision, requireVideo, updateVideo } from "./project-db.js";
import { enqueueUsage, renderUsageEvents } from "./usage-outbox.js";

export const RENDER_KINDS = ["render_preview", "render_final", "export_premiere"] as const satisfies readonly JobKind[];
export type RenderKind = (typeof RENDER_KINDS)[number];

/** `request` of a render job. */
export interface RenderJobRequest {
  video_id: string;
  /** The timeline revision; none: the latest when the job runs. */
  revision?: number;
  /** A farm machine for the final render (`requirements.node_id`). */
  node_id?: string;
  /** Final render and Premiere export: the frame size (`renderCanvas`); none: the timeline's (1080p). */
  resolution?: RenderResolution;
  /** Premiere: pack previews (`proxy`) or the original files. */
  media?: "proxy" | "original";
  /** The card a person confirmed, when there is one. */
  action_id?: string;
}

/** Where a finished render is, in its job's `result`. */
export interface RenderResult {
  kind: RenderKind;
  revision: number;
  /** Studio bucket key of the MP4 (renders) or the ZIP (Premiere). */
  key: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  watermarked: boolean | null;
  size_bytes: number | null;
  /** The render worker's warnings worth telling people (`noteOf`), joined. */
  note: string;
  /** Every warning of the worker's manifest, as it wrote them. */
  warnings?: string[];
  /** What makes this file wrong (`renderProblem`), said in the note and the chat; null: nothing. */
  problem?: string | null;
  /** The render worker's inspection of the file (`inspect.json`, contact sheets), copied into the project; absent: the
   * worker did not inspect it (an older render, or the inspection failed). */
  inspect?: RenderInspectSummary;
}

/** Where a render's inspection landed in the project and what it found, in words. */
export interface RenderInspectSummary {
  /** `videos/<id>/renders/<note name>/`: `inspect.json` and `sheet-NN.jpg`. */
  dir: string;
  /** The contact sheets in the project, in order, with the stretch of the render each shows. */
  sheets: { path: string; from_s: number; to_s: number }[];
  /** What is wrong, errors first (`inspectionLines`); empty: nothing found. */
  issues: string[];
}

export interface RenderDeps {
  db: StudioDb;
  bucket: StudioBucket;
  farm: ProjectFarm;
  /** The voice store narration lines are read from. */
  voiceDir: string;
  pollMs?: number;
  queueTimeoutMs?: number;
}

/** Warnings that stay in the job's result but say nothing a person or the agent can act on (`inspect_failed`: the note
 * says the render was not inspected). */
const QUIET_WARNINGS = new Set(["loudnorm_not_linear", "inspect_failed"]);

/** `duration_mismatch:<expected>:<actual>` (seconds): the render worker's file is not as long as the timeline. */
const DURATION_MISMATCH = /^duration_mismatch:([\d.]+):([\d.]+)$/;

/** The note of a render: its worker's warnings minus the quiet ones and those `renderProblem` says. */
export function noteOf(warnings: readonly string[]): string {
  return warnings.filter((w) => !QUIET_WARNINGS.has(w) && !DURATION_MISMATCH.test(w)).join("; ");
}

/** A warning that makes the file itself wrong, in words; null when there is none. */
export function renderProblem(warnings: readonly string[]): string | null {
  for (const w of warnings) {
    const m = DURATION_MISMATCH.exec(w);
    if (m) {
      const expected = Number(m[1]);
      const actual = Number(m[2]);
      return `bản render dài ${clockOf(actual)} nhưng timeline dài ${clockOf(expected)} (${actual < expected ? "thiếu" : "thừa"} ${Math.abs(Math.round(expected - actual))} giây): file này không đúng timeline, đừng dùng; render lại, nếu vẫn lệch thì báo người quản trị Studio`;
    }
  }
  return null;
}

/** A clip of the timeline by its composition segment (`order` is the clip's index): `C012 · Thuyền`. */
function clipLabel(t: StoredTimeline, order: number | undefined): string | null {
  if (order === undefined) return null;
  const c = t.clips[order];
  if (!c) return null;
  const title = t.assets[c.asset_id]?.title.trim();
  return title ? `${c.clip_id} · ${title}` : c.clip_id;
}

/**
 * What the render worker's inspection found, one line each, errors first: "đứng hình từ 13:21 tới hết video",
 * "im lặng 12:00–12:40", "clip C012 · Thuyền nhỏ hơn trung bình 9 dB". A `duration` issue is left to `renderProblem`
 * when the manifest already said it; codes this Studio does not know are skipped.
 */
export function inspectionLines(inspection: RenderInspection, t: StoredTimeline, opts: { skipDuration?: boolean } = {}): string[] {
  const span = (i: RenderInspectIssue) => `${clockOf(i.start ?? 0)}–${clockOf(i.end ?? 0)}`;
  const inClip = (i: RenderInspectIssue) => {
    const label = clipLabel(t, i.order);
    return label ? ` (clip ${label})` : "";
  };
  const lines: { error: boolean; text: string }[] = [];
  for (const i of inspection.issues) {
    const error = i.severity === "error";
    switch (i.code) {
      case "duration": {
        if (opts.skipDuration || i.expected_s === undefined || i.actual_s === undefined) break;
        const d = Math.round(Math.abs(i.expected_s - i.actual_s));
        lines.push({ error, text: `${i.actual_s < i.expected_s ? "ngắn" : "dài"} hơn timeline ${d} giây (${clockOf(i.actual_s)} so với ${clockOf(i.expected_s)})` });
        break;
      }
      case "freeze":
        if (error) lines.push({ error, text: i.to_end ? `đứng hình từ ${clockOf(i.start ?? 0)} tới hết video (qua cả điểm cắt)` : `đứng hình ${span(i)}, qua điểm cắt${inClip(i)}` });
        else lines.push({ error, text: `hình đứng yên ${span(i)}${inClip(i)}${i.to_end ? " tới hết video" : ""}: kiểm lại nếu đó không phải cảnh tĩnh` });
        break;
      case "black":
        lines.push({ error, text: `màn đen ${span(i)}${inClip(i)}` });
        break;
      case "silence":
        lines.push({ error, text: error ? "im lặng gần như cả video (không có tiếng gốc, lời dẫn hay nhạc)" : `im lặng ${span(i)}` });
        break;
      case "clip_loudness": {
        if (i.delta_db === undefined) break;
        const label = clipLabel(t, i.order) ?? `ở ${span(i)}`;
        lines.push({ error, text: `clip ${label} ${i.delta_db < 0 ? "nhỏ" : "to"} hơn trung bình ${Math.round(Math.abs(i.delta_db))} dB` });
        break;
      }
      default:
        break;
    }
  }
  return [...lines.filter((l) => l.error), ...lines.filter((l) => !l.error)].map((l) => l.text);
}

/** How many inspection lines the chat message names; the note has them all. */
const MESSAGE_ISSUES = 6;

const STAGE: Record<RenderKind, string> ={ render_preview: "render-preview", render_final: "render-final", export_premiere: "premiere" };
const LABEL: Record<RenderKind, string> = { render_preview: "bản xem trước", render_final: "bản cuối", export_premiere: "file dựng Premiere" };

/** The web page of a video with its Xem trước tab open, as a link inside Studio's web (`ProjectPage`). */
export function previewLink(projectId: string, videoId: string): string {
  return `/p/${projectId}/v/${videoId}?tab=preview`;
}

function clockOf(s: number | null): string {
  if (s === null) return "?";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Queues a render of a video (the latest revision unless one is given). */
export async function queueRender(db: StudioDb, p: {
  projectId: string; videoId: string; kind: RenderKind; request?: Omit<RenderJobRequest, "video_id">; threadId?: string | null; continueAgent?: boolean;
  createdBy: string; actorRole?: JobRecord["actor_role"]; title?: string;
}, now = new Date().toISOString()): Promise<JobRecord> {
  const v = await requireVideo(db, p.videoId);
  const rev = p.request?.revision ?? (await latestVideoRevision(db, p.videoId))?.revision;
  if (!rev) throw new HarnessError("CONFIG_INVALID", "video chưa có timeline để render", { code: "no_timeline" });
  return createJob(db, {
    projectId: p.projectId, videoId: p.videoId, threadId: p.threadId ?? null, kind: p.kind,
    title: p.title ?? `Render ${LABEL[p.kind]}: ${v.title} (bản ${rev})`, request: { video_id: p.videoId, ...p.request, revision: rev },
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** Finished renders of a video, newest first (the job results). */
export async function videoRenders(db: StudioDb, projectId: string, videoId: string, limit = 20): Promise<(RenderResult & { jobId: string; finishedAt: string | null })[]> {
  return (await listJobs(db, projectId, { videoId, limit: 200 }))
    .filter((j) => (RENDER_KINDS as readonly string[]).includes(j.kind) && j.status === "done" && j.result)
    .slice(0, limit)
    .map((j) => ({ ...(j.result as RenderResult), jobId: j.id, finishedAt: j.finished_at }));
}

/** One finished render of a video, by its job; undefined when that job is not a finished render of this video. */
export async function videoRender(db: StudioDb, videoId: string, jobId: string): Promise<(RenderResult & { jobId: string; finishedAt: string | null }) | undefined> {
  const j = await getJob(db, jobId);
  if (!j || j.video_id !== videoId || !(RENDER_KINDS as readonly string[]).includes(j.kind) || j.status !== "done" || !j.result) return undefined;
  return { ...(j.result as RenderResult), jobId: j.id, finishedAt: j.finished_at };
}

export function renderHandler(kind: RenderKind, d: RenderDeps): JobHandler {
  return async (job, ctx) => {
    const req = job.request as RenderJobRequest;
    const video = await requireVideo(d.db, req.video_id);
    if (video.project_id !== job.project_id) throw new Error("video thuộc dự án khác");
    const rev = req.revision ? await getVideoRevision(d.db, video.id, req.revision) : await latestVideoRevision(d.db, video.id);
    if (!rev) throw new Error(req.revision ? `không có timeline bản ${req.revision}` : "video chưa có timeline");
    const errors = timelineIssues(rev.data).filter((i) => i.severity === "error");
    if (errors.length) throw new Error(`timeline bản ${rev.revision} còn lỗi: ${errors.map((e) => e.message).join("; ")}`);
    await ctx.setUnits(rev.data.clips.reduce((n, c) => n + Math.max(0, (c.out ?? c.in) - c.in), 0));
    if (kind === "render_final") await updateVideo(d.db, video.id, { status: "rendering" }, ctx.now());

    await ctx.report({ phase: "Đang dựng composition", progress: 0.02 });
    const stageKey = STAGE[kind];
    let type: string;
    let payload: unknown;
    let uploads: { localPath: string; relPath: string }[];
    /** The render level the composition needs (`compositionFeatureLevel`): an older render worker rejects it. */
    let renderLevel: number;
    try {
      if (kind === "export_premiere") {
        // the sequence is the composition's frame: at 4K the worker scales each clip to fill it (Basic Motion)
        const composition = timelineToComposition(req.resolution ? { ...rev.data, canvas: renderCanvas(rev.data.canvas, req.resolution) } : rev.data);
        const compPath = join(ctx.tempDir, "composition.json");
        writeFileSync(compPath, JSON.stringify(composition));
        uploads = [{ localPath: compPath, relPath: "composition.json" }, ...narrationUploads(rev.data, d.voiceDir)];
        // an older worker leaves the clips at 100% in a sequence larger than the proxies
        renderLevel = Math.max(compositionFeatureLevel(composition), req.resolution === "4k" ? RENDER_PREMIERE_SCALE_LEVEL : 0);
        const perSegment = new Set(composition.segments.map((s) => s.has_audio)).size > 1;
        type = "studio.export_premiere";
        payload = {
          production_id: job.project_id, episode_id: video.id, composition: "stage:composition.json", media: req.media ?? "proxy",
          name: video.title.slice(0, 200), markers: youtubeChapters(layoutTimeline(rev.data)).map((c) => ({ t_s: c.start_s, title: c.title })),
          ...(isTimelineV4(rev.data) && rev.data.edit_style === "cut" ? { edit_style: "cut" as const } : {}),
          ...(perSegment ? { audio: "per_segment" as const } : {}),
          media_names: Object.fromEntries(rev.data.clips.flatMap((c) => {
            const title = rev.data.assets[c.asset_id]?.title.trim().slice(0, 200);
            return title ? [[`asset:${c.asset_id}`, title]] : [];
          })),
          output: `videos/${video.id}/premiere/${job.id}.zip`,
        } satisfies StudioExportPremierePayload;
      } else {
        const build = await prepareRender(join(ctx.tempDir, "render"), {
          timeline: rev.data, revision: rev.revision, productionId: job.project_id, episodeId: video.id,
          output: `videos/${video.id}/${kind === "render_final" ? "final" : "previews"}/${job.id}.mp4`, thumbnails: [], voiceDir: d.voiceDir, textStyle: true,
          inspect: true, ...(kind === "render_final" && req.resolution ? { resolution: req.resolution } : {}),
        });
        type = kind === "render_final" ? "studio.render_final" : "studio.render_preview";
        payload = build.payload;
        uploads = build.extraUploads ?? [];
        renderLevel = build.renderLevel;
      }
    } catch (e) {
      // a narration line not in the voice store, a timeline the composition cannot take: said in the chat
      if (e instanceof HarnessError) throw new Error(e.message);
      throw e;
    }
    await ctx.checkpoint();
    const requirements = {
      ...(kind === "render_final" && req.node_id ? { node_id: req.node_id } : {}),
      ...(renderLevel > 0 ? { studio_render_min: renderLevel } : {}),
    };
    const { outputPrefix, farmJob } = await runFarmStep(
      { db: d.db, bucket: d.bucket, farm: d.farm, ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.queueTimeoutMs ? { queueTimeoutMs: d.queueTimeoutMs } : {}), now: ctx.now },
      job,
      {
        type, payload, stageKey, attemptId: job.id, uploads,
        isFinalRender: kind === "render_final" || (kind === "export_premiere" && req.media === "original"),
        ...(Object.keys(requirements).length ? { requirements } : {}),
      },
      {
        onUpdate: (u) => ctx.report({ phase: `${u.phase} · ${LABEL[kind]}`, progress: 0.05 + 0.9 * (u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
        stopRequested: ctx.stopRequested,
      },
    );
    await ctx.report({ phase: "Đang đọc kết quả", progress: 0.97, waiting: false });
    let result: RenderResult;
    const noteBase = `videos/${video.id}/renders/${ctx.now().slice(0, 10)}-${STAGE[kind]}-r${rev.revision}-${job.id.slice(0, 8)}`;
    if (kind === "export_premiere") {
      const m = PremiereManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${PREMIERE_MANIFEST_PATH}`)).toString("utf8")));
      result = {
        kind, revision: rev.revision, key: `${outputPrefix}${m.output}`, duration_s: null, width: null, height: null, watermarked: null,
        size_bytes: m.size_bytes ?? null, note: noteOf(m.warnings ?? []), warnings: m.warnings ?? [], problem: renderProblem(m.warnings ?? []),
      };
    } else {
      const m = RenderManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${RENDER_MANIFEST_PATH}`)).toString("utf8")));
      result = {
        kind, revision: rev.revision, key: `${outputPrefix}${m.output}`, duration_s: m.duration_s, width: m.width, height: m.height,
        watermarked: m.watermarked, size_bytes: m.size_bytes, note: noteOf(m.warnings ?? []), warnings: m.warnings ?? [], problem: renderProblem(m.warnings ?? []),
      };
      const inspect = await copyInspection(d, ctx, job, m, outputPrefix, noteBase, rev.data, result.problem !== null);
      if (inspect) result.inspect = inspect;
    }
    await ackFarmJob(d.farm, farmJob.id);
    // the footage of a final render or a Premiere export is told to ag-go (usage outbox; keyed by job, so once)
    if (kind !== "render_preview") await enqueueUsage(d.db, await renderUsageEvents(d.db, job, kind, video.id, rev.data.clips.map((c) => c.asset_id), ctx.now()), ctx.now());
    if (kind === "render_final") await updateVideo(d.db, video.id, { status: "done" }, ctx.now());
    await writeRenderNote(d.db, ctx, job, `${noteBase}.md`, result);
    const what = `${LABEL[kind]} của **${video.title}** (timeline bản ${rev.revision}${result.duration_s !== null ? `, ${clockOf(result.duration_s)}` : ""}${result.watermarked ? ", có watermark" : ""})`;
    const found = result.inspect?.issues ?? [];
    const checked = found.length > 0
      ? ` Máy render tự kiểm thấy: ${found.slice(0, MESSAGE_ISSUES).join("; ")}${found.length > MESSAGE_ISSUES ? `; và ${found.length - MESSAGE_ISSUES} điều khác (xem \`${noteBase}.md\`)` : ""}.`
      : "";
    const open = `[Mở ở tab Xem trước](${previewLink(job.project_id, video.id)})`;
    if (kind === "export_premiere") return { result, message: `Đã xong ${what}: tải ở tab Xem trước của trang video. ${open}${result.note ? ` Lưu ý: ${result.note}` : ""}` };
    if (result.problem) return { result, message: `Đã xong ${what} nhưng có lỗi: ${result.problem}.${checked} ${open}${result.note ? ` Lưu ý khác: ${result.note}` : ""}` };
    return { result, message: `Đã xong ${what}.${checked} ${open}${result.note ? ` Lưu ý: ${result.note}` : ""}` };
  };
}

/**
 * The render worker's inspection of a render (`m.inspect`), copied from the farm's output into the project next to the
 * render note: `<noteBase>/inspect.json` and `<noteBase>/sheet-NN.jpg`, for the agent to read and open. Undefined when the
 * worker did not inspect it or the files cannot be read (said in the log; the render itself is fine).
 */
async function copyInspection(
  d: RenderDeps, ctx: JobContext, job: JobRecord, m: RenderManifest, outputPrefix: string, noteBase: string, t: StoredTimeline, durationSaid: boolean,
): Promise<RenderInspectSummary | undefined> {
  if (!m.inspect) return undefined;
  try {
    const raw = await d.bucket.get(`${outputPrefix}${m.inspect.output}`);
    const inspection = RenderInspectionSchema.parse(JSON.parse(raw.toString("utf8")));
    mkdirSync(join(ctx.workspaceDir, noteBase), { recursive: true });
    const write = (path: string, content: Buffer) =>
      writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path, content, baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
    await write(`${noteBase}/inspect.json`, raw);
    const sheets: RenderInspectSummary["sheets"] = [];
    for (const key of m.inspect.sheets) {
      const name = key.split("/").pop()!;
      if (!/^sheet-\d+\.jpg$/.test(name)) continue;
      await write(`${noteBase}/${name}`, await d.bucket.get(`${outputPrefix}${key}`));
      const at = inspection.sheets.find((s) => s.file === name);
      const from = at?.from_s ?? 0;
      sheets.push({ path: `${noteBase}/${name}`, from_s: from, to_s: at ? from + Math.max(0, at.frames - 1) * at.every_s : from });
    }
    return { dir: noteBase, sheets, issues: inspectionLines(inspection, t, { skipDuration: durationSaid }) };
  } catch (e) {
    ctx.logger.warn("render inspection unreadable", { job: job.id, error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/** The note's "Tự kiểm" section: what the inspection found and which sheet shows which minutes. */
function inspectSection(r: RenderResult): string[] {
  if (!r.inspect) return ["## Tự kiểm", "", "Máy render không tự kiểm bản này (máy cũ, hoặc lượt kiểm lỗi): mở bản xem trước để xem.", ""];
  const i = r.inspect;
  return [
    "## Tự kiểm",
    "",
    ...(i.issues.length ? i.issues.map((l) => `- ${l}`) : ["Không thấy đứng hình, màn đen, im lặng hay clip lệch độ to."]),
    "",
    `Tờ ghép khung hình (mở bằng Read; mỗi ô cách nhau 10 giây, 5 ô một hàng, đọc từ trái sang phải, trên xuống dưới) và số đo ở \`${i.dir}/inspect.json\`:`,
    "",
    ...i.sheets.map((s) => `- \`${s.path}\`: ${clockOf(s.from_s)}–${clockOf(s.to_s)}`),
    "",
  ];
}

/** `videos/<id>/renders/<date>-<kind>-r<rev>-<job>.md`: what was rendered, for the agent and people reading the files. */
async function writeRenderNote(db: StudioDb, ctx: JobContext, job: JobRecord, name: string, r: RenderResult): Promise<void> {
  const videoId = name.split("/")[1]!;
  const lines = [
    `# ${LABEL[r.kind][0]!.toUpperCase()}${LABEL[r.kind].slice(1)} · timeline bản ${r.revision}`,
    "",
    ...(r.problem ? [`**Lỗi:** ${r.problem}.`, ""] : []),
    `- Xong lúc ${ctx.now().slice(0, 16).replace("T", " ")} UTC (việc ${job.id}).`,
    ...(r.duration_s !== null ? [`- Dài ${clockOf(r.duration_s)}${r.width && r.height ? ` · ${r.width}×${r.height}` : ""}${r.watermarked ? " · có watermark (nguồn xem trước)" : ""}.`] : []),
    ...(r.size_bytes ? [`- ${(r.size_bytes / 1_048_576).toFixed(1)} MB.`] : []),
    "- Xem hoặc tải ở trang video (tab Xem trước); file nằm trong kho của Studio, không trong thư mục dự án.",
    ...(r.note ? [`- Lưu ý của máy render: ${r.note}`] : []),
    "",
    ...(r.kind === "export_premiere" ? [] : inspectSection(r)),
  ];
  mkdirSync(join(ctx.workspaceDir, "videos", videoId, "renders"), { recursive: true });
  await writeWorkspaceFile(db, { projectId: job.project_id, dir: ctx.workspaceDir, path: name, content: lines.join("\n"), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
}
