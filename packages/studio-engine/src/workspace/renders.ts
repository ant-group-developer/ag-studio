/**
 * Renders of a project's video (spec 2026-10-10 agent-workspace §P6): a preview (the agent or a person starts it), the
 * final render and the Premiere export (both after a person confirmed a card). Each is a background job that turns the
 * video's timeline (one revision) into a farm job — the same composition and narration uploads as the episode renders
 * (`prepareRender`, `narrationUploads`), keyed under the project — waits for it, and keeps where the file landed in the
 * job's result. A short note goes to `videos/<id>/renders/` for the agent to read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "@harness/contracts";
import { isTimelineV4, layoutTimeline, timelineIssues, timelineToComposition, youtubeChapters } from "@harness/core";
import { PREMIERE_MANIFEST_PATH, PremiereManifestSchema, RENDER_MANIFEST_PATH, RenderManifestSchema, type StudioExportPremierePayload } from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import { narrationUploads, prepareRender } from "../payloads.js";
import type { StudioDb } from "../studio-db.js";
import { writeWorkspaceFile } from "./files.js";
import { ackFarmJob, runFarmStep, type ProjectFarm } from "./farm.js";
import type { JobContext, JobHandler } from "./job-runner.js";
import { createJob, getJob, listJobs, type JobKind, type JobRecord } from "./jobs-db.js";
import { getVideoRevision, latestVideoRevision, requireVideo, updateVideo } from "./project-db.js";

export const RENDER_KINDS = ["render_preview", "render_final", "export_premiere"] as const satisfies readonly JobKind[];
export type RenderKind = (typeof RENDER_KINDS)[number];

/** `request` of a render job. */
export interface RenderJobRequest {
  video_id: string;
  /** The timeline revision; none: the latest when the job runs. */
  revision?: number;
  /** A farm machine for the final render (`requirements.node_id`). */
  node_id?: string;
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
  note: string;
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

const STAGE: Record<RenderKind, string> = { render_preview: "render-preview", render_final: "render-final", export_premiere: "premiere" };
const LABEL: Record<RenderKind, string> = { render_preview: "bản xem trước", render_final: "bản cuối", export_premiere: "file dựng Premiere" };

function clockOf(s: number | null): string {
  if (s === null) return "?";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Queues a render of a video (the latest revision unless one is given). */
export function queueRender(db: StudioDb, p: {
  projectId: string; videoId: string; kind: RenderKind; request?: Omit<RenderJobRequest, "video_id">; threadId?: string | null; continueAgent?: boolean;
  createdBy: string; actorRole?: JobRecord["actor_role"]; title?: string;
}, now = new Date().toISOString()): JobRecord {
  const v = requireVideo(db, p.videoId);
  const rev = p.request?.revision ?? latestVideoRevision(db, p.videoId)?.revision;
  if (!rev) throw new HarnessError("CONFIG_INVALID", "video chưa có timeline để render", { code: "no_timeline" });
  return createJob(db, {
    projectId: p.projectId, videoId: p.videoId, threadId: p.threadId ?? null, kind: p.kind,
    title: p.title ?? `Render ${LABEL[p.kind]}: ${v.title} (bản ${rev})`, request: { video_id: p.videoId, ...p.request, revision: rev },
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** Finished renders of a video, newest first (the job results). */
export function videoRenders(db: StudioDb, projectId: string, videoId: string, limit = 20): (RenderResult & { jobId: string; finishedAt: string | null })[] {
  return listJobs(db, projectId, { videoId, limit: 200 })
    .filter((j) => (RENDER_KINDS as readonly string[]).includes(j.kind) && j.status === "done" && j.result)
    .slice(0, limit)
    .map((j) => ({ ...(JSON.parse(j.result!) as RenderResult), jobId: j.id, finishedAt: j.finished_at }));
}

/** One finished render of a video, by its job; undefined when that job is not a finished render of this video. */
export function videoRender(db: StudioDb, videoId: string, jobId: string): (RenderResult & { jobId: string; finishedAt: string | null }) | undefined {
  const j = getJob(db, jobId);
  if (!j || j.video_id !== videoId || !(RENDER_KINDS as readonly string[]).includes(j.kind) || j.status !== "done" || !j.result) return undefined;
  return { ...(JSON.parse(j.result) as RenderResult), jobId: j.id, finishedAt: j.finished_at };
}

export function renderHandler(kind: RenderKind, d: RenderDeps): JobHandler {
  return async (job, ctx) => {
    const req = JSON.parse(job.request) as RenderJobRequest;
    const video = requireVideo(d.db, req.video_id);
    if (video.project_id !== job.project_id) throw new Error("video thuộc dự án khác");
    const rev = req.revision ? getVideoRevision(d.db, video.id, req.revision) : latestVideoRevision(d.db, video.id);
    if (!rev) throw new Error(req.revision ? `không có timeline bản ${req.revision}` : "video chưa có timeline");
    const errors = timelineIssues(rev.data).filter((i) => i.severity === "error");
    if (errors.length) throw new Error(`timeline bản ${rev.revision} còn lỗi: ${errors.map((e) => e.message).join("; ")}`);
    ctx.setUnits(rev.data.clips.reduce((n, c) => n + Math.max(0, (c.out ?? c.in) - c.in), 0));
    if (kind === "render_final") updateVideo(d.db, video.id, { status: "rendering" }, ctx.now());

    ctx.report({ phase: "Đang dựng composition", progress: 0.02 });
    const stageKey = STAGE[kind];
    let type: string;
    let payload: unknown;
    let uploads: { localPath: string; relPath: string }[];
    try {
      if (kind === "export_premiere") {
        const composition = timelineToComposition(rev.data);
        const compPath = join(ctx.tempDir, "composition.json");
        writeFileSync(compPath, JSON.stringify(composition));
        uploads = [{ localPath: compPath, relPath: "composition.json" }, ...narrationUploads(rev.data, d.voiceDir)];
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
        });
        type = kind === "render_final" ? "studio.render_final" : "studio.render_preview";
        payload = build.payload;
        uploads = build.extraUploads ?? [];
      }
    } catch (e) {
      // a narration line not in the voice store, a timeline the composition cannot take: said in the chat
      if (e instanceof HarnessError) throw new Error(e.message);
      throw e;
    }
    ctx.checkpoint();
    const { outputPrefix, farmJob } = await runFarmStep(
      { db: d.db, bucket: d.bucket, farm: d.farm, ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.queueTimeoutMs ? { queueTimeoutMs: d.queueTimeoutMs } : {}), now: ctx.now },
      job,
      {
        type, payload, stageKey, attemptId: job.id, uploads,
        isFinalRender: kind === "render_final" || (kind === "export_premiere" && req.media === "original"),
        ...(kind === "render_final" && req.node_id ? { requirements: { node_id: req.node_id } } : {}),
      },
      {
        onUpdate: (u) => ctx.report({ phase: `${u.phase} · ${LABEL[kind]}`, progress: 0.05 + 0.9 * (u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
        stopRequested: ctx.stopRequested,
      },
    );
    ctx.report({ phase: "Đang đọc kết quả", progress: 0.97, waiting: false });
    let result: RenderResult;
    if (kind === "export_premiere") {
      const m = PremiereManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${PREMIERE_MANIFEST_PATH}`)).toString("utf8")));
      result = {
        kind, revision: rev.revision, key: `${outputPrefix}${m.output}`, duration_s: null, width: null, height: null, watermarked: null,
        size_bytes: m.size_bytes ?? null, note: (m.warnings ?? []).join("; "),
      };
    } else {
      const m = RenderManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${RENDER_MANIFEST_PATH}`)).toString("utf8")));
      result = {
        kind, revision: rev.revision, key: `${outputPrefix}${m.output}`, duration_s: m.duration_s, width: m.width, height: m.height,
        watermarked: m.watermarked, size_bytes: m.size_bytes, note: (m.warnings ?? []).join("; "),
      };
    }
    await ackFarmJob(d.farm, farmJob.id);
    if (kind === "render_final") updateVideo(d.db, video.id, { status: "done" }, ctx.now());
    writeRenderNote(d.db, ctx, job, video.id, result);
    const what = `${LABEL[kind]} của **${video.title}** (timeline bản ${rev.revision}${result.duration_s !== null ? `, ${clockOf(result.duration_s)}` : ""}${result.watermarked ? ", có watermark" : ""})`;
    return { result, message: `Đã xong ${what}: xem ở trang video, tab Xem trước.${result.note ? ` Lưu ý: ${result.note}` : ""}` };
  };
}

/** `videos/<id>/renders/<date>-<kind>-r<rev>.md`: what was rendered, for the agent and people reading the files. */
function writeRenderNote(db: StudioDb, ctx: JobContext, job: JobRecord, videoId: string, r: RenderResult): void {
  const name = `videos/${videoId}/renders/${ctx.now().slice(0, 10)}-${STAGE[r.kind]}-r${r.revision}-${job.id.slice(0, 8)}.md`;
  const lines = [
    `# ${LABEL[r.kind][0]!.toUpperCase()}${LABEL[r.kind].slice(1)} · timeline bản ${r.revision}`,
    "",
    `- Xong lúc ${ctx.now().slice(0, 16).replace("T", " ")} UTC (việc ${job.id}).`,
    ...(r.duration_s !== null ? [`- Dài ${clockOf(r.duration_s)}${r.width && r.height ? ` · ${r.width}×${r.height}` : ""}${r.watermarked ? " · có watermark (nguồn xem trước)" : ""}.`] : []),
    ...(r.size_bytes ? [`- ${(r.size_bytes / 1_048_576).toFixed(1)} MB.`] : []),
    "- Xem hoặc tải ở trang video (tab Xem trước); file nằm trong kho của Studio, không trong thư mục dự án.",
    ...(r.note ? [`- Lưu ý của máy render: ${r.note}`] : []),
    "",
  ];
  mkdirSync(join(ctx.workspaceDir, "videos", videoId, "renders"), { recursive: true });
  writeWorkspaceFile(db, { projectId: job.project_id, dir: ctx.workspaceDir, path: name, content: lines.join("\n"), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
}
