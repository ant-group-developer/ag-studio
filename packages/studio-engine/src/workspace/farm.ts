/**
 * A project job's work on the farm (spec 2026-10-10 agent-workspace §5): files uploaded under the job's input prefix,
 * the farm job sent (its correlation id is the project job's, so a worker that restarts finds it again instead of
 * sending another), recorded in `project_farm_jobs` for `/farm/sign`, then watched: waiting in line, the machine that
 * took it, its progress. Stop cancels it on the farm. The farm's key layout is kept: the project is the "production".
 */
import { jobOutputPrefix, stageInputPrefix } from "@harness/executors";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import type { StudioDb } from "../studio-db.js";

export type ProjectFarm = Pick<FarmOwnerClient, "submitJob" | "getJob" | "cancelJob" | "ackJob"> & Partial<Pick<FarmOwnerClient, "listNodes">>;

/** The job was stopped (by a person, or the worker is shutting down): what ran is cancelled, nothing is saved. */
export class JobStopped extends Error {
  constructor(readonly reason: "cancelled" | "shutdown") { super(reason === "cancelled" ? "đã dừng" : "worker đang tắt"); this.name = "JobStopped"; }
}

export interface FarmStep {
  /** Farm job type, e.g. `studio.transcribe`. */
  type: string;
  payload: unknown;
  /** Bucket prefixes: `productions/<project>/jobs/<stageKey>/<attemptId>/{in,out}/`. */
  stageKey: string;
  attemptId: string;
  /** Local files uploaded under the input prefix first (`stage:<relPath>` in the payload). */
  uploads?: { localPath: string; relPath: string }[];
  isFinalRender?: boolean;
  requirements?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface FarmWatch {
  /** What to show while it waits or runs. `progress` is the farm's 0–1, `node` the machine's name (or id). */
  onUpdate(u: { phase: string; progress: number | null; node: string | null; farmJobId: string }): void;
  /** Read often: true stops the job (cancelled on the farm). */
  stopRequested(): "cancelled" | "shutdown" | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Node names by id, read from the farm at most once a minute. */
function nodeNames(farm: ProjectFarm): (id: string | null) => Promise<string | null> {
  let names = new Map<string, string>();
  let readAt = 0;
  return async (id) => {
    if (!id) return null;
    if (farm.listNodes && (Date.now() - readAt > 60_000 || !names.has(id))) {
      readAt = Date.now();
      try { names = new Map((await farm.listNodes()).nodes.map((n) => [n.id, n.name])); } catch { /* keep the id */ }
    }
    return names.get(id) ?? id;
  };
}

/**
 * Runs one farm step of a project job to its end and answers the bucket prefix of its outputs. A failed or cancelled
 * farm job throws (with the farm's reason); a stop request cancels it on the farm and throws `JobStopped`.
 */
export async function runFarmStep(
  d: { db: StudioDb; bucket: StudioBucket; farm: ProjectFarm; pollMs?: number; now?: () => string },
  job: { id: string; project_id: string; video_id: string | null },
  step: FarmStep,
  watch: FarmWatch,
): Promise<{ outputPrefix: string; farmJob: FarmJobView }> {
  const now = d.now ?? (() => new Date().toISOString());
  const inPrefix = stageInputPrefix(job.project_id, step.stageKey, step.attemptId);
  for (const u of step.uploads ?? []) await d.bucket.putFile(`${inPrefix}${u.relPath}`, u.localPath);
  const stop0 = watch.stopRequested();
  if (stop0) throw new JobStopped(stop0);
  const { job: sent } = await d.farm.submitJob({
    type: step.type as never, correlation_id: `studio-job-${step.stageKey}-${step.attemptId}`, affinity_key: job.project_id,
    max_attempts: step.maxAttempts ?? 2, payload: step.payload,
    ...(step.requirements && Object.keys(step.requirements).length ? { requirements: step.requirements as never } : {}),
  });
  d.db.run(
    `INSERT OR IGNORE INTO project_farm_jobs (farm_job_id, job_id, project_id, video_id, stage_key, attempt_id, job_type, is_final_render, requirements, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sent.id, job.id, job.project_id, job.video_id, step.stageKey, step.attemptId, step.type, step.isFinalRender ? 1 : 0, JSON.stringify(step.requirements ?? {}), now()],
  );
  const nameOf = nodeNames(d.farm);
  const pollMs = d.pollMs ?? 3000;
  let view = sent;
  for (;;) {
    const stop = watch.stopRequested();
    if (stop) {
      if (stop === "cancelled") await d.farm.cancelJob(sent.id).catch(() => undefined);
      throw new JobStopped(stop);
    }
    if (view.status === "completed") break;
    if (view.status === "failed" || view.status === "cancelled") {
      const reason = (view.error as { message?: string } | null)?.message ?? view.status;
      await d.farm.ackJob(sent.id).catch(() => undefined);
      throw new Error(view.status === "cancelled" ? "việc trên farm đã bị huỷ" : `farm báo lỗi: ${reason}`);
    }
    const node = await nameOf(view.node_id);
    const phase = view.status === "leased" || node
      ? `Farm · ${node ?? "máy farm"}${view.progress_stage ? ` · ${view.progress_stage}` : ""}`
      : view.status === "paused" ? "Farm · đang tạm dừng" : "Farm · đang chờ máy nhận";
    watch.onUpdate({ phase, progress: view.progress_percent === null ? null : view.progress_percent / 100, node, farmJobId: sent.id });
    await sleep(pollMs);
    view = await d.farm.getJob(sent.id);
  }
  return { outputPrefix: jobOutputPrefix(job.project_id, step.stageKey, step.attemptId), farmJob: view };
}

/** Lets the farm forget a finished job (its outputs were read). */
export async function ackFarmJob(farm: ProjectFarm, farmJobId: string): Promise<void> {
  await farm.ackJob(farmJobId).catch(() => undefined);
}
