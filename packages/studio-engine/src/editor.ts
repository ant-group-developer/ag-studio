/**
 * Web editor server side (GĐ2, GĐ6): per-episode autosaved revisions with optimistic concurrency, and the farm
 * jobs a person starts outside the workflow — "Render preview" and "Xuất Premiere".
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimelineV3Schema, type TimelineV3 } from "@harness/contracts";
import { layoutTimeline, timelineIssues, timelineToComposition, youtubeChapters, type TimelineIssue } from "@harness/core";
import { jobOutputPrefix, stageInputPrefix } from "@harness/executors";
import { PREMIERE_MANIFEST_PATH, PremiereManifestSchema, RenderManifestSchema, type StudioExportPremierePayload } from "@ag-farm/protocol";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { productionKey, type StudioBucket } from "./bucket.js";
import { prepareRender } from "./payloads.js";
import { StudioRunError } from "./run-control.js";
import {
  getEpisode, getEpisodeJob, getEpisodeRevision, insertEpisodeJob, latestEpisodeRevision,
  saveEpisodeRevision, updateEpisodeJob, type StudioDb, type EpisodeJobRecord,
} from "./studio-db.js";

/** Stage keys of the farm jobs the editor starts (their bucket prefixes and `/farm/sign` scope). */
export const EDITOR_PREVIEW_STAGE = "editor-preview";
export const EDITOR_PREMIERE_STAGE = "editor-premiere";
export type PremiereMedia = StudioExportPremierePayload["media"];

export type EditorFarmClient = Pick<FarmOwnerClient, "submitJob" | "getJob" | "ackJob">;
export interface EditorDeps { db: StudioDb; bucket: StudioBucket; farm: EditorFarmClient }

export interface EditorJobView {
  id: string; kind: EpisodeJobRecord["kind"]; status: EpisodeJobRecord["status"];
  /** Farm progress 0..100 while running (read live, not stored). */
  progress: number | null;
  request: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; created_at: string;
}

const view = (r: EpisodeJobRecord, progress: number | null = null): EditorJobView => ({
  id: r.id, kind: r.kind, status: r.status, progress: r.status === "completed" ? 100 : progress,
  request: JSON.parse(r.request) as Record<string, unknown>,
  result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
  error: r.error, created_at: r.created_at,
});

/**
 * Record the job in `studio_farm_jobs` so `/farm/sign` accepts the worker's ticket for it. `finalMedia` decides
 * which footage the sign endpoint resolves: originals (as for a final render) or the preview/proxy.
 */
function recordFarmJob(db: StudioDb, p: { farmJobId: string; runId: string; stageKey: string; attemptId: string; productionId: string; episodeId: string; jobType: string; finalMedia?: boolean }): void {
  db.run(
    "INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, episode_id, job_type, is_final_render, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [randomUUID(), p.farmJobId, p.runId, p.stageKey, p.attemptId, p.productionId, p.episodeId, p.jobType, p.finalMedia ? 1 : 0, new Date().toISOString()],
  );
}

/** Save a timeline revision for an episode (autosave from the web editor). */
export function saveEpisodeTimeline(
  db: StudioDb, episodeId: string, p: { baseRevision: number; data: unknown; authorId: string; label?: string },
): { revision: number; issues: TimelineIssue[] } {
  if (!getEpisode(db, episodeId)) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  const parsed = TimelineV3Schema.safeParse(p.data);
  if (!parsed.success) {
    throw new StudioRunError("invalid", "timeline không hợp lệ", { problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  const saved = saveEpisodeRevision(db, episodeId, { baseRevision: p.baseRevision, data: parsed.data, authorId: p.authorId, label: p.label ?? "autosave" });
  return { revision: saved.revision, issues: timelineIssues(parsed.data) };
}

const RENDER_BLOCKERS = new Set(["no_clips", "duplicate_id", "unknown_asset", "duplicate_asset"]);

/** Start a render-preview farm job for one episode revision. */
export async function startEpisodePreview(
  d: EditorDeps, p: { productionId: string; episodeId: string; revision: number; userId: string },
): Promise<EditorJobView> {
  const ep = getEpisode(d.db, p.episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${p.episodeId} not found`);
  const rev = getEpisodeRevision(d.db, p.episodeId, p.revision);
  if (!rev) throw new StudioRunError("not_found", `revision ${p.revision} not found`);
  const blocking = timelineIssues(rev.data).filter((i) => i.severity === "error" && RENDER_BLOCKERS.has(i.code));
  if (blocking.length) throw new StudioRunError("invalid", "timeline chưa render được", { problems: blocking });
  const id = randomUUID();
  insertEpisodeJob(d.db, { id, episodeId: p.episodeId, kind: "render_preview", request: { revision: p.revision }, userId: p.userId });
  const work = mkdtempSync(join(tmpdir(), "studio-ep-preview-"));
  try {
    const output = `episodes/${p.episodeId}/previews/${id}.mp4`;
    const build = await prepareRender(work, {
      timeline: rev.data, revision: p.revision,
      productionId: p.productionId, episodeId: p.episodeId,
      output, thumbnails: [],
    });
    const prefix = stageInputPrefix(p.productionId, EDITOR_PREVIEW_STAGE, id);
    for (const up of build.extraUploads ?? []) {
      await d.bucket.put(prefix + up.relPath, readFileSync(up.localPath));
    }
    const { job } = await d.farm.submitJob({
      type: "studio.render_preview", correlation_id: `editor-ep-${id}`,
      affinity_key: p.episodeId, max_attempts: 2, payload: build.payload,
    });
    recordFarmJob(d.db, {
      farmJobId: job.id, runId: ep.run_id ?? "editor", stageKey: EDITOR_PREVIEW_STAGE,
      attemptId: id, productionId: p.productionId, episodeId: p.episodeId, jobType: "studio.render_preview",
    });
    updateEpisodeJob(d.db, id, { farm_job_id: job.id, status: "running" });
  } catch (e) {
    updateEpisodeJob(d.db, id, { status: "failed", error: `gửi job render preview thất bại: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return view(getEpisodeJob(d.db, p.episodeId, id)!);
}

/** Poll one editor job and return its current state (may trigger a bucket read on completion). */
export async function pollEpisodeJob(
  d: EditorDeps, p: { productionId: string; episodeId: string; jobId: string; urlTtlSeconds?: number },
): Promise<EditorJobView & { url?: string }> {
  const row = getEpisodeJob(d.db, p.episodeId, p.jobId);
  if (!row) throw new StudioRunError("not_found", `editor job ${p.jobId} not found`);
  let progress: number | null = null;
  if (row.status === "running" && row.farm_job_id) {
    const job = await d.farm.getJob(row.farm_job_id);
    progress = job.progress_percent ?? null;
    if (job.status === "failed" || job.status === "cancelled") {
      const msg = (job.error as { message?: string } | null)?.message ?? job.status;
      updateEpisodeJob(d.db, p.jobId, { status: "failed", error: msg });
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    } else if (job.status === "completed") {
      try {
        const req = JSON.parse(row.request) as { revision?: number };
        if (row.kind === "export_premiere") {
          const out = jobOutputPrefix(p.productionId, EDITOR_PREMIERE_STAGE, p.jobId);
          const m = PremiereManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}${PREMIERE_MANIFEST_PATH}`)).toString("utf8")));
          updateEpisodeJob(d.db, p.jobId, {
            status: "completed",
            result: JSON.stringify({ key: `${out}${m.output}`, size_bytes: m.size_bytes, media: m.media, revision: req.revision, warnings: m.warnings }),
          });
        } else {
          const out = jobOutputPrefix(p.productionId, EDITOR_PREVIEW_STAGE, p.jobId);
          const m = RenderManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}render.json`)).toString("utf8")));
          updateEpisodeJob(d.db, p.jobId, {
            status: "completed",
            result: JSON.stringify({ key: `${out}${m.output}`, duration_s: m.duration_s, watermarked: m.watermarked, revision: req.revision }),
          });
        }
      } catch (e) {
        updateEpisodeJob(d.db, p.jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    }
  }
  const out: EditorJobView & { url?: string } = view(getEpisodeJob(d.db, p.episodeId, p.jobId)!, progress);
  if (out.status === "completed" && out.result?.["key"]) {
    out.url = await d.bucket.signedGetUrl(String(out.result["key"]), p.urlTtlSeconds ?? 3600);
  }
  return out;
}

/** The episode's editor jobs of one kind, latest first, each polled once (so a list reflects the farm). */
export async function listEpisodeJobs(
  d: EditorDeps, p: { productionId: string; episodeId: string; kind: EpisodeJobRecord["kind"]; urlTtlSeconds?: number; limit?: number },
): Promise<(EditorJobView & { url?: string })[]> {
  const rows = d.db.all<{ id: string }>(
    "SELECT id FROM episode_jobs WHERE episode_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?",
    [p.episodeId, p.kind, p.limit ?? 20],
  );
  return Promise.all(rows.map((r) => pollEpisodeJob(d, { productionId: p.productionId, episodeId: p.episodeId, jobId: r.id, ...(p.urlTtlSeconds ? { urlTtlSeconds: p.urlTtlSeconds } : {}) })));
}

/**
 * "Xuất Premiere" (GĐ6): an Adobe Premiere project (FCP7 XML + media + text overlays, zipped) of the episode's
 * latest timeline revision, built by the render worker. `original` packs the original files — the caller's right
 * to download originals is checked by the API before this is called; the farm job is recorded as final media so
 * `/farm/sign` resolves originals (the production owner's scope still applies at ag-go).
 */
export async function startPremiereExport(
  d: EditorDeps, p: { productionId: string; episodeId: string; media: PremiereMedia; userId: string },
): Promise<EditorJobView> {
  const ep = getEpisode(d.db, p.episodeId);
  if (!ep || ep.production_id !== p.productionId) throw new StudioRunError("not_found", `episode ${p.episodeId} not found`);
  const rev = latestEpisodeRevision(d.db, p.episodeId);
  if (!rev) throw new StudioRunError("invalid", "tập chưa có timeline để xuất");
  const blocking = timelineIssues(rev.data).filter((i) => i.severity === "error");
  if (blocking.length) throw new StudioRunError("invalid", "timeline còn lỗi, chưa xuất được", { problems: blocking });
  const id = randomUUID();
  insertEpisodeJob(d.db, { id, episodeId: p.episodeId, kind: "export_premiere", request: { revision: rev.revision, media: p.media }, userId: p.userId });
  try {
    await d.bucket.put(`${stageInputPrefix(p.productionId, EDITOR_PREMIERE_STAGE, id)}composition.json`,
      Buffer.from(JSON.stringify(timelineToComposition(rev.data)), "utf8"), "application/json");
    const payload: StudioExportPremierePayload = {
      production_id: p.productionId, episode_id: p.episodeId, composition: "stage:composition.json", media: p.media,
      name: ep.title.slice(0, 200),
      markers: youtubeChapters(layoutTimeline(rev.data)).map((c) => ({ t_s: c.start_s, title: c.title })),
      // Files in the zip are named after the videos, not their ids.
      media_names: Object.fromEntries(rev.data.clips.flatMap((c) => {
        const title = rev.data.assets[c.asset_id]?.title.trim().slice(0, 200);
        return title ? [[`asset:${c.asset_id}`, title]] : [];
      })),
      output: `episodes/${p.episodeId}/premiere/${id}.zip`,
    };
    const { job } = await d.farm.submitJob({
      type: "studio.export_premiere", correlation_id: `editor-premiere-${id}`, affinity_key: p.episodeId, max_attempts: 2, payload,
    });
    recordFarmJob(d.db, {
      farmJobId: job.id, runId: ep.run_id ?? "editor", stageKey: EDITOR_PREMIERE_STAGE, attemptId: id,
      productionId: p.productionId, episodeId: p.episodeId, jobType: "studio.export_premiere", finalMedia: p.media === "original",
    });
    updateEpisodeJob(d.db, id, { farm_job_id: job.id, status: "running" });
  } catch (e) {
    updateEpisodeJob(d.db, id, { status: "failed", error: `gửi job xuất Premiere thất bại: ${e instanceof Error ? e.message : String(e)}` });
  }
  return view(getEpisodeJob(d.db, p.episodeId, id)!);
}

export type { TimelineV3 };
