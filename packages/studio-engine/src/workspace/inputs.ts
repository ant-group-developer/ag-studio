/**
 * A project's inputs as people and the agent see them (spec 2026-10-10 agent-workspace §4): where each ag-go video
 * stands (prepared, being prepared, failed, not yet), and queueing its preparation — shared by the agent's tools and
 * the web's Inputs tab.
 */
import type { StudioDb } from "../studio-db.js";
import type { ActorRole } from "../agent/threads-db.js";
import { createJob, listJobs, type JobRecord } from "./jobs-db.js";
import { inputDir, type PrepareRequest } from "./prepare.js";
import { writeVideoIndexesFor } from "./video-index.js";
import { getPrepared, listPrepared, listSources, sourceView, type PreparedAsset, type SourceRecord, type SourceView } from "./sources-db.js";

export type AssetState =
  | { state: "queued" | "preparing"; job_id: string; phase: string | null; progress: number | null }
  | { state: "ready"; folder: string; readme: string; shots: number | null; duration_s: number | null; transcript: boolean }
  | { state: "failed"; error: string | null }
  | { state: "not_prepared" };

/** The ag-go video a prepare job prepares. */
const preparedAssetId = (j: JobRecord): string | undefined => {
  const req = j.request as Partial<PrepareRequest> | null;
  return req && typeof req === "object" && typeof req.asset_id === "string" ? req.asset_id : undefined;
};

/** Every prepare job of the project still queued or running, by the asset it prepares (the newest when two are). */
async function activePrepares(db: StudioDb, projectId: string): Promise<Map<string, JobRecord>> {
  const out = new Map<string, JobRecord>();
  const jobs = await db.all<JobRecord>(
    "SELECT * FROM project_jobs WHERE project_id = ? AND kind = 'prepare_asset' AND status IN ('queued', 'running') ORDER BY created_at DESC", [projectId],
  );
  for (const j of jobs) {
    const id = preparedAssetId(j);
    if (id && !out.has(id)) out.set(id, j);
  }
  return out;
}

/** The prepare job of an asset still queued or running, if any. */
export async function activePrepare(db: StudioDb, projectId: string, assetId: string): Promise<JobRecord | undefined> {
  return (await activePrepares(db, projectId)).get(assetId);
}

function stateOf(assetId: string, job: JobRecord | undefined, p: PreparedAsset | undefined): AssetState {
  if (job) return { state: job.status === "running" ? "preparing" : "queued", job_id: job.id, phase: job.phase, progress: job.progress };
  if (p?.status === "ready") {
    return { state: "ready", folder: `${inputDir(assetId)}/`, readme: `${inputDir(assetId)}/README.md`, shots: p.shots, duration_s: p.duration_s, transcript: p.transcript };
  }
  if (p?.status === "failed") return { state: "failed", error: p.error };
  return { state: "not_prepared" };
}

export async function assetState(db: StudioDb, projectId: string, assetId: string): Promise<AssetState> {
  return stateOf(assetId, await activePrepare(db, projectId, assetId), await getPrepared(db, projectId, assetId));
}

/**
 * Where any ag-go video of the project stands, for many at once: the active prepare jobs and the prepared rows are read
 * a single time (not once per video), so listing hundreds of videos stays one pass.
 */
export async function assetStates(db: StudioDb, projectId: string): Promise<(assetId: string) => AssetState> {
  const jobs = await activePrepares(db, projectId);
  const prepared = new Map((await listPrepared(db, projectId)).map((p) => [p.asset_id, p]));
  return (assetId) => stateOf(assetId, jobs.get(assetId), prepared.get(assetId));
}

export type SourceItem = SourceView & { asset: AssetState | null };

/** Sources with where each ag-go video stands (`listSources` options), in one pass. */
export async function sourceItems(db: StudioDb, projectId: string, opts: { videoId?: string; projectOnly?: boolean } = {}): Promise<SourceItem[]> {
  const state = await assetStates(db, projectId);
  return (await listSources(db, projectId, opts)).map((s) => ({ ...sourceView(s), asset: s.kind === "ag_go_asset" ? state(s.ref) : null }));
}

/** How many distinct ag-go videos the sources hold, by where they stand (queued and running count as preparing). */
export interface AssetCounts { videos: number; ready: number; preparing: number; failed: number; notPrepared: number }

export function assetCounts(items: readonly SourceItem[]): AssetCounts {
  const seen = new Map<string, AssetState>();
  for (const s of items) if (s.kind === "ag_go_asset" && s.asset && !seen.has(s.ref)) seen.set(s.ref, s.asset);
  const c: AssetCounts = { videos: seen.size, ready: 0, preparing: 0, failed: 0, notPrepared: 0 };
  for (const a of seen.values()) {
    if (a.state === "ready") c.ready += 1;
    else if (a.state === "queued" || a.state === "preparing") c.preparing += 1;
    else if (a.state === "failed") c.failed += 1;
    else c.notPrepared += 1;
  }
  return c;
}

/**
 * Queues preparing these ag-go videos of the project, skipping those prepared (unless `again`: copied again from ag-go,
 * whose own prep is not run again) or already in line. An id that is no ag-go video source of the project is answered
 * `not_an_input`. One transaction: two calls at once queue a video once.
 */
export async function queuePrepare(db: StudioDb, p: {
  projectId: string; assetIds: string[]; threadId?: string | null; continueAgent?: boolean; createdBy: string; actorRole?: ActorRole | null; again?: boolean;
}, now: string): Promise<Record<string, AssetState | { state: "not_an_input" }>> {
  return db.tx(async () => {
    const known = new Map<string, SourceRecord>();
    for (const s of await listSources(db, p.projectId)) if (s.kind === "ag_go_asset" && !known.has(s.ref)) known.set(s.ref, s);
    const out: Record<string, AssetState | { state: "not_an_input" }> = {};
    const state = await assetStates(db, p.projectId);
    for (const id of p.assetIds) {
      const src = known.get(id);
      if (out[id]) continue; // the same id twice in one call: queued once
      if (!src) { out[id] = { state: "not_an_input" }; continue; }
      const st = state(id);
      if (st.state === "queued" || st.state === "preparing" || (st.state === "ready" && !p.again)) { out[id] = st; continue; }
      const meta = sourceView(src).meta;
      const req: PrepareRequest = { asset_id: id, name: src.label, ...(typeof meta.durationMs === "number" ? { duration_s: meta.durationMs / 1000 } : {}) };
      // no units: a video ag-go has prepared takes seconds whatever its length; the job sets them when it must wait for a run
      const job = await createJob(db, {
        projectId: p.projectId, videoId: src.video_id, threadId: p.threadId ?? null, kind: "prepare_asset", title: `Chuẩn bị ${src.label}`, request: req,
        continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
      }, now);
      out[id] = { state: "queued", job_id: job.id, phase: null, progress: null };
    }
    return out;
  });
}

/** ag-go videos of the project added without a name (their label is the asset id: the agent left `name` out). */
export async function unnamedAssetIds(db: StudioDb, projectId: string): Promise<string[]> {
  return (await db.all<{ ref: string }>(
    "SELECT DISTINCT ref FROM project_sources WHERE project_id = ? AND kind = 'ag_go_asset' AND label = ref", [projectId],
  )).map((r) => r.ref);
}

/**
 * Gives unnamed ag-go videos their names (from ag-go): the sources, their prepare jobs (title and request), the
 * prepared row and the index of every video cut from them. Returns the asset ids renamed.
 */
export async function nameUnnamedAssets(db: StudioDb, dir: string, projectId: string, names: ReadonlyMap<string, string>): Promise<string[]> {
  const renamed: string[] = [];
  for (const id of await unnamedAssetIds(db, projectId)) {
    const name = names.get(id)?.trim();
    if (!name || name === id) continue;
    await db.tx(async () => {
      await db.run("UPDATE project_sources SET label = ? WHERE project_id = ? AND kind = 'ag_go_asset' AND ref = ? AND label = ref", [name, projectId, id]);
      await db.run("UPDATE prepared_assets SET name = ? WHERE project_id = ? AND asset_id = ? AND (name IS NULL OR name = asset_id)", [name, projectId, id]);
      for (const j of (await listJobs(db, projectId)).filter((x) => x.kind === "prepare_asset" && preparedAssetId(x) === id)) {
        const req = j.request as PrepareRequest;
        await db.run("UPDATE project_jobs SET title = ?, request = ? WHERE id = ?", [
          j.title.split(id).join(name), JSON.stringify({ ...req, ...(!req.name || req.name === id ? { name } : {}) }), j.id,
        ]);
      }
    });
    await writeVideoIndexesFor(db, dir, projectId, id);
    renamed.push(id);
  }
  return renamed;
}
