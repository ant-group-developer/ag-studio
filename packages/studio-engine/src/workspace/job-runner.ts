/**
 * The worker loop of project jobs (spec 2026-10-10 agent-workspace §5): takes queued jobs (at most `lanes` at once,
 * read again each tick: it grows with the idle farm machines, `lanes.ts`),
 * runs each kind's handler, keeps the row saying what it does, how far it is and how long is left (`eta.ts`), and
 * stops it when a person asks (the handler's ffmpeg is killed, its farm job cancelled). When a job ends, its chat
 * thread is told, and the agent goes on when the job asked for it and the project lets it (≤ 3 turns in a row
 * without a message from a person).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessLogger } from "@harness/core";
import { projectSettingsOf } from "@harness/contracts";
import type { StudioDb } from "../studio-db.js";
import { logAudit } from "../audit-log.js";
import { automaticTurnsInARow, getThread, postSystemMessage, type ActorRole } from "../agent/threads-db.js";
import { getProject } from "./project-db.js";
import { projectDir } from "./files.js";
import { estimateSecondsLeft } from "./eta.js";
import { JobStopped } from "./farm.js";
import {
  claimJob, finishJob, getJob, jobCancelRequested, reportJob, requeueStaleJobs, secondsPerUnit, touchJob, type JobKind, type JobRecord,
} from "./jobs-db.js";

/** What a handler runs with. */
export interface JobContext {
  /** Aborted when the job is stopped or the worker shuts down: pass it to downloads and ffmpeg. */
  signal: AbortSignal;
  /** Why it must stop, when it must: a person stopped it, or the worker shuts down (the job goes back in line). */
  stopRequested(): Promise<"cancelled" | "shutdown" | null>;
  /** Throws `JobStopped` when it must stop: call between steps. */
  checkpoint(): Promise<void>;
  /**
   * What it does now and how far it is (0–1); the time left is worked out here. `waiting`: in line for someone else
   * (a farm machine) — no time left can be told until it is taken.
   */
  report(p: { phase?: string; progress?: number | null; node?: string | null; farmJobId?: string | null; waiting?: boolean }): Promise<void>;
  /** The size of the job (seconds of video…), once known, for the estimate before progress comes. */
  setUnits(units: number): Promise<void>;
  /** The project's workspace folder. */
  workspaceDir: string;
  /** A scratch folder outside the workspace, removed when the job ends. */
  tempDir: string;
  logger: HarnessLogger;
  now(): string;
}

/** What a finished job tells its thread (markdown); `null`: nothing. */
export interface JobOutcome { result: unknown; message?: string | null }

export type JobHandler = (job: JobRecord, ctx: JobContext) => Promise<JobOutcome>;

export interface JobRunnerOptions {
  db: StudioDb;
  logger: HarnessLogger;
  workspacesRoot: string;
  dataRoot: string;
  handlers: Partial<Record<JobKind, JobHandler>>;
  /** Jobs run at once (ffmpeg on this machine, farm waits), or how many now (read each tick); default 2. */
  lanes?: number | (() => number);
  pollMs?: number;
  /** How often the row is refreshed (heartbeat, time left, stop requests); default 2 s. */
  tickMs?: number;
  now?: () => string;
}

export interface JobRunner {
  /** One pass: requeue jobs left by a stopped worker, start queued ones while lanes are free. Answers the jobs started. */
  tick(): Promise<string[]>;
  /** Jobs running in this process now. */
  running(): string[];
  /** Resolves when every running job ended. */
  idle(): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
}

/** A job that failed for a reason with a name (`youtube_blocked`…): the row keeps it as `result.error_code`. */
export class JobError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "JobError"; }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The code a failure carries (`JobError`, `YtDlpError`), recorded with it; null for others. */
function errCode(e: unknown): string | null {
  if (!(e instanceof Error) || (e.name !== "JobError" && e.name !== "YtDlpError")) return null;
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
const AUTO_TURNS_IN_A_ROW = 3;

export function createJobRunner(o: JobRunnerOptions): JobRunner {
  const now = o.now ?? (() => new Date().toISOString());
  const lanesNow = typeof o.lanes === "function" ? o.lanes : () => (o.lanes as number | undefined) ?? 2;
  const kinds = Object.keys(o.handlers) as JobKind[];
  const live = new Map<string, Promise<void>>();
  let shuttingDown = false;
  const shutdown = new AbortController();

  const run = async (job: JobRecord): Promise<void> => {
    const handler = o.handlers[job.kind]!;
    const log = o.logger.child({ job_id: job.id, kind: job.kind });
    const ac = new AbortController();
    const onShutdown = () => ac.abort();
    shutdown.signal.addEventListener("abort", onShutdown, { once: true });
    let stop: "cancelled" | "shutdown" | null = null;
    let progress: number | null = null;
    let waiting = false;
    // time spent in line for a farm machine does not count in the estimate (the work itself is what progress measures)
    let waitedMs = 0;
    let waitStart: number | null = null;
    let units = job.units;
    const perUnit = await secondsPerUnit(o.db, job.kind);
    const startedAt = Date.parse(job.started_at ?? now());
    const tempDir = join(o.dataRoot, "job-runs", job.id);
    mkdirSync(tempDir, { recursive: true });
    const eta = () => waiting ? null : estimateSecondsLeft({
      kind: job.kind, elapsedSeconds: (Date.parse(now()) - startedAt - waitedMs) / 1000, progress, units, secondsPerUnit: perUnit,
    });
    const readStop = async () => {
      if (!stop && await jobCancelRequested(o.db, job.id)) stop = "cancelled";
      if (!stop && shuttingDown) stop = "shutdown";
      if (stop && !ac.signal.aborted) ac.abort();
      return stop;
    };
    // one tick at a time; the last one is waited for before the job's end is written
    let ticking: Promise<void> | null = null;
    const ticker = setInterval(() => {
      if (ticking) return;
      ticking = (async () => {
        await readStop();
        await reportJob(o.db, job.id, { etaSeconds: eta() }, now());
        await touchJob(o.db, job.id, now());
      })().catch((e) => log.warn("job tick failed", { error: errText(e) })).finally(() => { ticking = null; });
    }, o.tickMs ?? 2000);
    const ctx: JobContext = {
      signal: ac.signal,
      stopRequested: readStop,
      checkpoint: async () => { const s = await readStop(); if (s) throw new JobStopped(s); },
      report: async (p) => {
        if (p.progress !== undefined) progress = p.progress;
        if (p.waiting !== undefined && p.waiting !== waiting) {
          if (p.waiting) waitStart = Date.parse(now());
          else if (waitStart !== null) { waitedMs += Date.parse(now()) - waitStart; waitStart = null; }
          waiting = p.waiting;
        }
        await reportJob(o.db, job.id, {
          ...(p.phase !== undefined ? { phase: p.phase } : {}), ...(p.progress !== undefined ? { progress: p.progress } : {}),
          ...(p.node !== undefined ? { nodeId: p.node } : {}), ...(p.farmJobId !== undefined ? { farmJobId: p.farmJobId } : {}), etaSeconds: eta(),
        }, now());
      },
      setUnits: async (n) => {
        units = n;
        await o.db.run("UPDATE project_jobs SET units = ? WHERE id = ?", [n, job.id]);
      },
      workspaceDir: projectDir(o.workspacesRoot, job.project_id),
      tempDir,
      logger: log,
      now,
    };
    let outcome: { status: "done" | "failed" | "cancelled"; result?: unknown; error?: string | null; message?: string | null } | null = null;
    try {
      await ctx.report({ phase: "Bắt đầu", progress: null });
      const r = await handler(job, ctx);
      outcome = { status: "done", result: r.result, message: r.message ?? null };
    } catch (e) {
      const s = e instanceof JobStopped ? e.reason : await readStop();
      if (s === "shutdown") {
        // back in line for the next worker; its farm job is found again by correlation id
        await o.db.run("UPDATE project_jobs SET status = 'queued', phase = NULL, eta_seconds = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [now(), job.id]);
        log.info("job left for the next worker", {});
      } else if (s === "cancelled") {
        outcome = { status: "cancelled", error: null, message: `Đã dừng: ${job.title}.` };
      } else {
        log.warn("job failed", { error: errText(e) });
        const code = errCode(e);
        outcome = {
          status: "failed", error: errText(e).slice(0, 2000), message: `Không làm xong: ${job.title} — ${errText(e).slice(0, 500)}`,
          ...(code ? { result: { error_code: code } } : {}),
        };
      }
    } finally {
      clearInterval(ticker);
      await ticking;
      shutdown.signal.removeEventListener("abort", onShutdown);
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (!outcome) return;
    await finishJob(o.db, job.id, { status: outcome.status, result: outcome.result, error: outcome.error ?? null }, now());
    log.info("job finished", { status: outcome.status });
    const done = (await getJob(o.db, job.id))!;
    // the activity log: the job as Studio ran it for the person who asked
    await logAudit(o.db, {
      actorKind: "studio", actorId: done.created_by, kind: "job", action: `job.${done.kind}`, outcome: done.status === "failed" ? "error" : "ok", at: now(),
      durationMs: done.started_at && done.finished_at ? Date.parse(done.finished_at) - Date.parse(done.started_at) : null,
      projectId: done.project_id, videoId: done.video_id, threadId: done.thread_id, jobId: done.id, target: done.title, summary: done.error?.slice(0, 300) ?? null,
      details: { status: done.status, node: done.node_id, units: done.units, farmJobId: done.farm_job_id, attempts: done.attempts },
    }, (e) => log.warn("job not in the activity log", { error: String(e) }));
    await tellThread(o.db, done, outcome.status, outcome.message ?? null, now());
  };

  const pass = async (): Promise<string[]> => {
    if (shuttingDown || kinds.length === 0) return [];
    try {
      const { requeued, failed } = await requeueStaleJobs(o.db, now());
      if (requeued.length || failed.length) o.logger.warn("jobs left by a stopped worker", { requeued, failed });
    } catch (e) { o.logger.warn("requeue of stale jobs failed", { error: errText(e) }); }
    const started: string[] = [];
    const lanes = lanesNow();
    while (live.size < lanes) {
      const job = await claimJob(o.db, kinds, now());
      if (!job) break;
      started.push(job.id);
      const p = run(job).catch((e) => o.logger.error("job runner crashed", { job_id: job.id, error: errText(e) })).finally(() => live.delete(job.id));
      live.set(job.id, p);
    }
    return started;
  };
  // passes run one after another: two at once would both see free lanes
  let passes: Promise<unknown> = Promise.resolve();
  const tick = (): Promise<string[]> => {
    const p = passes.then(pass, pass);
    passes = p.catch(() => undefined);
    return p;
  };

  return {
    tick,
    running: () => [...live.keys()],
    idle: async () => { while (live.size) await Promise.all([...live.values()]); },
    runForever: async (signal) => {
      const pollMs = o.pollMs ?? 1000;
      while (!signal.aborted) {
        await tick().catch((e) => o.logger.warn("job pass failed", { error: errText(e) }));
        await new Promise<void>((res) => {
          const t = setTimeout(res, pollMs);
          signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
        });
      }
      shuttingDown = true;
      shutdown.abort();
      await Promise.all([...live.values()]);
    },
  };
}

/** What a batch of jobs of a kind did, for its one summary line. */
const BATCH_VERB: Partial<Record<JobKind, string>> = { prepare_asset: "Đã chuẩn bị" };
/** Failures a batch summary names; the rest are counted. */
const BATCH_FAILURES_NAMED = 8;

function batchOf(job: JobRecord): string | null {
  const id = (job.request as { batch_id?: unknown } | null)?.batch_id;
  return typeof id === "string" && id ? id : null;
}

/** "Đã chuẩn bị 12/14 · 2 lỗi: **A** — lý do; **B** — lý do · 1 đã dừng." */
export function batchSummary(jobs: readonly JobRecord[]): string {
  const name = (j: JobRecord) => {
    const n = (j.request as { name?: unknown } | null)?.name;
    return typeof n === "string" && n ? n : j.title;
  };
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed");
  const cancelled = jobs.filter((j) => j.status === "cancelled").length;
  const named = failed.slice(0, BATCH_FAILURES_NAMED).map((j) => `**${name(j)}** — ${(j.error ?? "lỗi").slice(0, 200)}`);
  const more = failed.length > BATCH_FAILURES_NAMED ? ` và ${failed.length - BATCH_FAILURES_NAMED} lỗi khác` : "";
  return `${BATCH_VERB[jobs[0]!.kind] ?? "Đã xong"} ${done}/${jobs.length}`
    + `${failed.length ? ` · ${failed.length} lỗi: ${named.join("; ")}${more}` : ""}${cancelled ? ` · ${cancelled} đã dừng` : ""}.`;
}

/**
 * A finished job's line in its thread, and the agent's next turn when the job asked for one, the project lets the
 * agent go on by itself, and it has not already gone on 3 times without a person's message. Jobs queued together
 * (`request.batch_id`) say nothing until the last of them ends, which posts one summary (`batchSummary`) and is the
 * only one to wake the agent: 160 prepare messages, each waking the agent, flooded a thread on prod.
 */
async function tellThread(db: StudioDb, job: JobRecord, status: "done" | "failed" | "cancelled", message: string | null, now: string): Promise<void> {
  if (!job.thread_id) return;
  let text = message;
  let wake = job.continue_agent && status !== "cancelled";
  const batchId = batchOf(job);
  if (batchId !== null) {
    // one transaction (one write lock): of two jobs ending at once, exactly one sees the batch over and tells it
    const told = await db.tx(async () => {
      const jobs = await db.all<JobRecord>("SELECT * FROM project_jobs WHERE project_id = ? AND request->>'batch_id' = ? ORDER BY created_at, id", [job.project_id, batchId]);
      if (jobs.some((j) => j.status === "queued" || j.status === "running")) return null;
      if (jobs.some((j) => (j.result as { batch_told?: unknown } | null)?.batch_told === true)) return null;
      await db.run("UPDATE project_jobs SET result = COALESCE(result, '{}'::jsonb) || ?::jsonb WHERE id = ?", [JSON.stringify({ batch_told: true }), job.id]);
      return { text: batchSummary(jobs), wake: jobs.some((j) => j.continue_agent && j.status !== "cancelled") };
    });
    if (told === null) return;
    ({ text, wake } = told);
  }
  if (!text) return;
  const thread = await getThread(db, job.thread_id);
  if (!thread || thread.archived_at) return;
  const project = await getProject(db, job.project_id);
  const settings = projectSettingsOf(project ? JSON.stringify(project.settings) : null);
  const goOn = wake && settings.auto_continue && await automaticTurnsInARow(db, thread.id) < AUTO_TURNS_IN_A_ROW;
  const actor = job.actor_role ? { id: job.created_by, role: job.actor_role as ActorRole } : null;
  await postSystemMessage(db, { threadId: thread.id, text, trigger: "job", continueAgent: goOn, actor }, now);
}
