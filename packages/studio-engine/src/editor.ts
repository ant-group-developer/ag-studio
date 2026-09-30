/**
 * Web editor server side (GĐ2): per-episode autosaved revisions with optimistic concurrency,
 * and "Render preview" — an ag-farm job the editor starts outside the workflow.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimelineV3Schema, type TimelineV3 } from "@harness/contracts";
import { timelineIssues, type TimelineIssue } from "@harness/core";
import { jobOutputPrefix, stageInputPrefix } from "@harness/executors";
import { RenderManifestSchema } from "@ag-farm/protocol";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { productionKey, type StudioBucket } from "./bucket.js";
import { prepareRender } from "./payloads.js";
import { StudioRunError } from "./run-control.js";
import {
  getEpisode, getEpisodeJob, getEpisodeRevision, insertEpisodeJob, latestEpisodeRevision,
  saveEpisodeRevision, updateEpisodeJob, type StudioDb, type EpisodeJobRecord,
} from "./studio-db.js";

export type EditorFarmClient = Pick<FarmOwnerClient, "submitJob" | "getJob" | "ackJob">;
export interface EditorDeps { db: StudioDb; bucket: StudioBucket; farm: EditorFarmClient }

export interface EditorJobView {
  id: string; kind: EpisodeJobRecord["kind"]; status: EpisodeJobRecord["status"];
  request: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; created_at: string;
}

const view = (r: EpisodeJobRecord): EditorJobView => ({
  id: r.id, kind: r.kind, status: r.status,
  request: JSON.parse(r.request) as Record<string, unknown>,
  result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
  error: r.error, created_at: r.created_at,
});

/** Record the job in `studio_farm_jobs` so `/farm/sign` accepts the worker's ticket for it. */
function recordFarmJob(db: StudioDb, p: { farmJobId: string; runId: string; stageKey: string; attemptId: string; productionId: string; episodeId: string; jobType: string }): void {
  db.run(
    "INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, episode_id, job_type, is_final_render, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    [randomUUID(), p.farmJobId, p.runId, p.stageKey, p.attemptId, p.productionId, p.episodeId, p.jobType, new Date().toISOString()],
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
    const prefix = stageInputPrefix(p.productionId, "editor-preview", id);
    for (const up of build.extraUploads ?? []) {
      await d.bucket.put(prefix + up.relPath, readFileSync(up.localPath));
    }
    const { job } = await d.farm.submitJob({
      type: "studio.render_preview", correlation_id: `editor-ep-${id}`,
      affinity_key: p.episodeId, max_attempts: 2, payload: build.payload,
    });
    recordFarmJob(d.db, {
      farmJobId: job.id, runId: ep.run_id ?? "editor", stageKey: "editor-preview",
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
  if (row.status === "running" && row.farm_job_id) {
    const job = await d.farm.getJob(row.farm_job_id);
    if (job.status === "failed" || job.status === "cancelled") {
      const msg = (job.error as { message?: string } | null)?.message ?? job.status;
      updateEpisodeJob(d.db, p.jobId, { status: "failed", error: msg });
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    } else if (job.status === "completed") {
      try {
        const req = JSON.parse(row.request) as { revision?: number };
        const out = jobOutputPrefix(p.productionId, "editor-preview", p.jobId);
        const m = RenderManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}render.json`)).toString("utf8")));
        updateEpisodeJob(d.db, p.jobId, {
          status: "completed",
          result: JSON.stringify({ key: `${out}${m.output}`, duration_s: m.duration_s, watermarked: m.watermarked, revision: req.revision }),
        });
      } catch (e) {
        updateEpisodeJob(d.db, p.jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    }
  }
  const out: EditorJobView & { url?: string } = view(getEpisodeJob(d.db, p.episodeId, p.jobId)!);
  if (out.kind === "render_preview" && out.status === "completed" && out.result?.["key"]) {
    out.url = await d.bucket.signedGetUrl(String(out.result["key"]), p.urlTtlSeconds ?? 3600);
  }
  return out;
}

export type { TimelineV3 };
