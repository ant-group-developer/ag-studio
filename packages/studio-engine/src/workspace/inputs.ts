/**
 * A project's inputs as people and the agent see them (spec 2026-10-10 agent-workspace §4): where each ag-go video
 * stands (prepared, being prepared, failed, not yet), and queueing its preparation — shared by the agent's tools and
 * the web's Inputs tab.
 */
import type { StudioDb } from "../studio-db.js";
import type { ActorRole } from "../agent/threads-db.js";
import { createJob, listJobs, type JobRecord } from "./jobs-db.js";
import { inputDir, type PrepareRequest } from "./prepare.js";
import { getPrepared, listSources, sourceView, type SourceRecord, type SourceView } from "./sources-db.js";

export type AssetState =
  | { state: "queued" | "preparing"; job_id: string; phase: string | null; progress: number | null }
  | { state: "ready"; folder: string; readme: string; shots: number | null; duration_s: number | null; transcript: boolean }
  | { state: "failed"; error: string | null }
  | { state: "not_prepared" };

/** The prepare job of an asset still queued or running, if any. */
export function activePrepare(db: StudioDb, projectId: string, assetId: string): JobRecord | undefined {
  return listJobs(db, projectId, { active: true }).find((j) => j.kind === "prepare_asset" && (JSON.parse(j.request) as PrepareRequest).asset_id === assetId);
}

export function assetState(db: StudioDb, projectId: string, assetId: string): AssetState {
  const job = activePrepare(db, projectId, assetId);
  if (job) return { state: job.status === "running" ? "preparing" : "queued", job_id: job.id, phase: job.phase, progress: job.progress };
  const p = getPrepared(db, projectId, assetId);
  if (p?.status === "ready") {
    return { state: "ready", folder: `${inputDir(assetId)}/`, readme: `${inputDir(assetId)}/README.md`, shots: p.shots, duration_s: p.duration_s, transcript: p.transcript === 1 };
  }
  if (p?.status === "failed") return { state: "failed", error: p.error };
  return { state: "not_prepared" };
}

export type SourceItem = SourceView & { asset: AssetState | null };

/** Sources with where each ag-go video stands (`listSources` options). */
export function sourceItems(db: StudioDb, projectId: string, opts: { videoId?: string; projectOnly?: boolean } = {}): SourceItem[] {
  return listSources(db, projectId, opts).map((s) => ({ ...sourceView(s), asset: s.kind === "ag_go_asset" ? assetState(db, projectId, s.ref) : null }));
}

/**
 * Queues preparing these ag-go videos of the project, skipping those prepared (unless `again`) or already in line.
 * An id that is no ag-go video source of the project is answered `not_an_input`.
 */
export function queuePrepare(db: StudioDb, p: {
  projectId: string; assetIds: string[]; threadId?: string | null; continueAgent?: boolean; createdBy: string; actorRole?: ActorRole | null; again?: boolean;
}, now: string): Record<string, AssetState | { state: "not_an_input" }> {
  const known = new Map<string, SourceRecord>();
  for (const s of listSources(db, p.projectId)) if (s.kind === "ag_go_asset" && !known.has(s.ref)) known.set(s.ref, s);
  const out: Record<string, AssetState | { state: "not_an_input" }> = {};
  for (const id of p.assetIds) {
    const src = known.get(id);
    if (!src) { out[id] = { state: "not_an_input" }; continue; }
    const st = assetState(db, p.projectId, id);
    if (st.state === "queued" || st.state === "preparing" || (st.state === "ready" && !p.again)) { out[id] = st; continue; }
    const req: PrepareRequest = { asset_id: id, name: src.label, ...(typeof sourceView(src).meta.durationMs === "number" ? { duration_s: (sourceView(src).meta.durationMs as number) / 1000 } : {}) };
    const job = createJob(db, {
      projectId: p.projectId, videoId: src.video_id, threadId: p.threadId ?? null, kind: "prepare_asset", title: `Chuẩn bị ${src.label}`, request: req,
      units: req.duration_s ?? null, continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
    }, now);
    out[id] = { state: "queued", job_id: job.id, phase: null, progress: null };
  }
  return out;
}
