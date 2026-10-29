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
import { projectFarmPool } from "../claude-accounts.js";
import type { StudioDb } from "../studio-db.js";

export type ProjectFarm = Pick<FarmOwnerClient, "submitJob" | "getJob" | "cancelJob" | "ackJob"> & Partial<Pick<FarmOwnerClient, "listNodes">>;

/** The job was stopped (by a person, or the worker is shutting down): what ran is cancelled, nothing is saved. */
export class JobStopped extends Error {
  constructor(readonly reason: "cancelled" | "shutdown") { super(reason === "cancelled" ? "đã dừng" : "worker đang tắt"); this.name = "JobStopped"; }
}

/**
 * A farm job that failed: `message` as before ("farm báo lỗi: …"), with the farm's own error (`code`, its words,
 * whether it was worth retrying) and the machine that ran it, so a step can tell its failures apart.
 */
export class FarmJobFailed extends Error {
  constructor(
    readonly farmJobId: string,
    readonly code: string | null,
    readonly farmMessage: string,
    readonly retryable: boolean,
    /** The machine's name (or id), when one took it. */
    readonly node: string | null,
  ) {
    super(`farm báo lỗi: ${farmMessage}`);
    this.name = "FarmJobFailed";
  }
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
  /** What to show while it waits or runs. `progress` is the farm's 0–1, `node` the machine's name (or id); `waiting`: no machine took it yet. */
  onUpdate(u: { phase: string; progress: number | null; node: string | null; farmJobId: string; waiting: boolean }): void | Promise<void>;
  /** Read often: true stops the job (cancelled on the farm). */
  stopRequested(): Promise<"cancelled" | "shutdown" | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the farm may stay out of reach while a job runs on it before the step gives up (and cancels it there). */
export const FARM_UNREACHABLE_TIMEOUT_MS = 15 * 60_000;
/** The longest wait between two tries while the farm is out of reach. */
const UNREACHABLE_MAX_BACKOFF_MS = 30_000;

/**
 * An error asking the farm that asking again may get past: the owner client's timeout, a dropped connection, a busy or
 * broken hub (`FarmHttpError` 5xx, 408, 429). A 4xx answer (the job is gone, the key is wrong) will not change.
 */
function farmUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name !== "FarmHttpError") return true;
  const status = (e as Error & { status?: number }).status ?? 0;
  return status >= 500 || status === 408 || status === 429;
}

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
 * farm job throws (with the farm's reason); a stop request cancels it on the farm and throws `JobStopped`. Asking the
 * farm fails now and then (the hub restarting, a slow network): the step keeps asking, longer and longer apart, and only
 * gives up after `unreachableTimeoutMs` without an answer (20/10: one timed out request had failed five renders, one of
 * which the farm went on to finish).
 */
export async function runFarmStep(
  d: {
    db: StudioDb; bucket: StudioBucket; farm: ProjectFarm; pollMs?: number; now?: () => string;
    /** No machine takes it this long: cancelled on the farm, and this throws saying so (default: wait forever). */
    queueTimeoutMs?: number;
    /** The farm gave no answer this long: cancelled there, and this throws saying so (default 15 minutes). */
    unreachableTimeoutMs?: number;
  },
  job: { id: string; project_id: string; video_id: string | null },
  step: FarmStep,
  watch: FarmWatch,
): Promise<{ outputPrefix: string; farmJob: FarmJobView }> {
  const now = d.now ?? (() => new Date().toISOString());
  const inPrefix = stageInputPrefix(job.project_id, step.stageKey, step.attemptId);
  for (const u of step.uploads ?? []) await d.bucket.putFile(`${inPrefix}${u.relPath}`, u.localPath);
  const stop0 = await watch.stopRequested();
  if (stop0) throw new JobStopped(stop0);
  // the team's own machines (plan 2026-10-30): its jobs run only on its pool; none: the shared machines
  const pool = await projectFarmPool(d.db, job.project_id);
  const requirements = { ...(step.requirements ?? {}), ...(pool ? { pool } : {}) };
  const { job: sent } = await d.farm.submitJob({
    type: step.type as never, correlation_id: `studio-job-${step.stageKey}-${step.attemptId}`, affinity_key: job.project_id,
    max_attempts: step.maxAttempts ?? 2, payload: step.payload,
    ...(Object.keys(requirements).length ? { requirements: requirements as never } : {}),
  });
  await d.db.run(
    `INSERT INTO project_farm_jobs (farm_job_id, job_id, project_id, video_id, stage_key, attempt_id, job_type, is_final_render, requirements, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [sent.id, job.id, job.project_id, job.video_id, step.stageKey, step.attemptId, step.type, step.isFinalRender === true, JSON.stringify(requirements), now()],
  );
  const nameOf = nodeNames(d.farm);
  const pollMs = d.pollMs ?? 3000;
  const unreachableTimeoutMs = d.unreachableTimeoutMs ?? FARM_UNREACHABLE_TIMEOUT_MS;
  let view = sent;
  let waitingSince: number | null = null;
  /** Since when, and how many times in a row, asking the farm failed (null: the last answer came). */
  let unreachable = null as { since: number; misses: number } | null;
  for (;;) {
    const stop = await watch.stopRequested();
    if (stop) {
      if (stop === "cancelled") await d.farm.cancelJob(sent.id).catch(() => undefined);
      throw new JobStopped(stop);
    }
    if (unreachable) {
      const node = await nameOf(view.node_id);
      await watch.onUpdate({
        phase: "Farm · mất liên lạc, đang hỏi lại", progress: view.progress_percent === null ? null : view.progress_percent / 100, node, farmJobId: sent.id,
        waiting: view.status === "queued" || view.status === "paused",
      });
      await sleep(Math.min(UNREACHABLE_MAX_BACKOFF_MS, pollMs * 2 ** unreachable.misses));
      view = await askAgain();
      continue;
    }
    if (view.status === "completed") break;
    if (view.status === "failed" || view.status === "cancelled") {
      const err = view.error as { code?: string; message?: string; retryable?: boolean } | null;
      await d.farm.ackJob(sent.id).catch(() => undefined);
      if (view.status === "cancelled") throw new Error("việc trên farm đã bị huỷ");
      throw new FarmJobFailed(sent.id, err?.code ?? null, err?.message ?? view.status, err?.retryable === true, await nameOf(view.node_id));
    }
    const node = await nameOf(view.node_id);
    const phase = view.status === "leased" || node
      ? `Farm · ${node ?? "máy farm"}${view.progress_stage ? ` · ${view.progress_stage}` : ""}`
      : view.status === "paused" ? "Farm · đang tạm dừng" : "Farm · đang chờ máy nhận";
    const waiting = view.status === "queued" || view.status === "paused";
    waitingSince = waiting ? waitingSince ?? Date.now() : null;
    if (waiting && d.queueTimeoutMs && Date.now() - waitingSince! > d.queueTimeoutMs) {
      await d.farm.cancelJob(sent.id).catch(() => undefined);
      // a render needs a machine of its render level: one still on an older render worker never takes it
      const level = (step.requirements as { studio_render_min?: unknown } | undefined)?.studio_render_min;
      const why = typeof level === "number" ? `máy có thể đang tắt, hoặc chưa máy nào lên bản render worker đạt mức render ≥ ${level}` : "máy có thể đang tắt";
      throw new Error(`không máy farm nào nhận việc sau ${Math.round(d.queueTimeoutMs / 60_000)} phút (${why})`);
    }
    await watch.onUpdate({ phase, progress: view.progress_percent === null ? null : view.progress_percent / 100, node, farmJobId: sent.id, waiting });
    await sleep(pollMs);
    view = await askAgain();
  }
  return { outputPrefix: jobOutputPrefix(job.project_id, step.stageKey, step.attemptId), farmJob: view };

  /** The job's state from the farm; while it is out of reach, the last one known (until `unreachableTimeoutMs`). */
  async function askAgain(): Promise<FarmJobView> {
    try {
      const fresh = await d.farm.getJob(sent.id);
      unreachable = null;
      return fresh;
    } catch (e) {
      if (!farmUnreachable(e)) throw e;
      unreachable = unreachable ? { since: unreachable.since, misses: unreachable.misses + 1 } : { since: Date.now(), misses: 0 };
      if (Date.now() - unreachable.since >= unreachableTimeoutMs) {
        await d.farm.cancelJob(sent.id).catch(() => undefined);
        const minutes = Math.round(unreachableTimeoutMs / 60_000);
        throw new Error(`không hỏi được farm trong ${minutes >= 1 ? `${minutes} phút` : `${Math.round(unreachableTimeoutMs / 1000)} giây`} (${(e as Error).message}); việc trên farm đã được huỷ`);
      }
      return view;
    }
  }
}

/** Lets the farm forget a finished job (its outputs were read). */
export async function ackFarmJob(farm: ProjectFarm, farmJobId: string): Promise<void> {
  await farm.ackJob(farmJobId).catch(() => undefined);
}
