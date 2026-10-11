/**
 * The worker loop of project jobs (spec 2026-10-10 agent-workspace §5): takes queued jobs (at most `lanes` at once),
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
  stopRequested(): "cancelled" | "shutdown" | null;
  /** Throws `JobStopped` when it must stop: call between steps. */
  checkpoint(): void;
  /**
   * What it does now and how far it is (0–1); the time left is worked out here. `waiting`: in line for someone else
   * (a farm machine) — no time left can be told until it is taken.
   */
  report(p: { phase?: string; progress?: number | null; node?: string | null; farmJobId?: string | null; waiting?: boolean }): void;
  /** The size of the job (seconds of video…), once known, for the estimate before progress comes. */
  setUnits(units: number): void;
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
  /** Jobs run at once (ffmpeg on this machine, farm waits); default 2. */
  lanes?: number;
  pollMs?: number;
  /** How often the row is refreshed (heartbeat, time left, stop requests); default 2 s. */
  tickMs?: number;
  now?: () => string;
}

export interface JobRunner {
  /** One pass: requeue jobs left by a stopped worker, start queued ones while lanes are free. Answers the jobs started. */
  tick(): string[];
  /** Jobs running in this process now. */
  running(): string[];
  /** Resolves when every running job ended. */
  idle(): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const AUTO_TURNS_IN_A_ROW = 3;

export function createJobRunner(o: JobRunnerOptions): JobRunner {
  const now = o.now ?? (() => new Date().toISOString());
  const lanes = o.lanes ?? 2;
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
    const perUnit = secondsPerUnit(o.db, job.kind);
    const startedAt = Date.parse(job.started_at ?? now());
    const tempDir = join(o.dataRoot, "job-runs", job.id);
    mkdirSync(tempDir, { recursive: true });
    const eta = () => waiting ? null : estimateSecondsLeft({
      kind: job.kind, elapsedSeconds: (Date.parse(now()) - startedAt - waitedMs) / 1000, progress, units, secondsPerUnit: perUnit,
    });
    const readStop = () => {
      if (!stop && jobCancelRequested(o.db, job.id)) stop = "cancelled";
      if (!stop && shuttingDown) stop = "shutdown";
      if (stop && !ac.signal.aborted) ac.abort();
      return stop;
    };
    const ticker = setInterval(() => {
      try {
        readStop();
        reportJob(o.db, job.id, { etaSeconds: eta() }, now());
        touchJob(o.db, job.id, now());
      } catch (e) { log.warn("job tick failed", { error: errText(e) }); }
    }, o.tickMs ?? 2000);
    const ctx: JobContext = {
      signal: ac.signal,
      stopRequested: readStop,
      checkpoint: () => { const s = readStop(); if (s) throw new JobStopped(s); },
      report: (p) => {
        if (p.progress !== undefined) progress = p.progress;
        if (p.waiting !== undefined && p.waiting !== waiting) {
          if (p.waiting) waitStart = Date.parse(now());
          else if (waitStart !== null) { waitedMs += Date.parse(now()) - waitStart; waitStart = null; }
          waiting = p.waiting;
        }
        reportJob(o.db, job.id, {
          ...(p.phase !== undefined ? { phase: p.phase } : {}), ...(p.progress !== undefined ? { progress: p.progress } : {}),
          ...(p.node !== undefined ? { nodeId: p.node } : {}), ...(p.farmJobId !== undefined ? { farmJobId: p.farmJobId } : {}), etaSeconds: eta(),
        }, now());
      },
      setUnits: (n) => {
        units = n;
        o.db.run("UPDATE project_jobs SET units = ? WHERE id = ?", [n, job.id]);
      },
      workspaceDir: projectDir(o.workspacesRoot, job.project_id),
      tempDir,
      logger: log,
      now,
    };
    let outcome: { status: "done" | "failed" | "cancelled"; result?: unknown; error?: string | null; message?: string | null } | null = null;
    try {
      ctx.report({ phase: "Bắt đầu", progress: null });
      const r = await handler(job, ctx);
      outcome = { status: "done", result: r.result, message: r.message ?? null };
    } catch (e) {
      const s = e instanceof JobStopped ? e.reason : readStop();
      if (s === "shutdown") {
        // back in line for the next worker; its farm job is found again by correlation id
        o.db.run("UPDATE project_jobs SET status = 'queued', phase = NULL, eta_seconds = NULL, updated_at = ? WHERE id = ? AND status = 'running'", [now(), job.id]);
        log.info("job left for the next worker", {});
      } else if (s === "cancelled") {
        outcome = { status: "cancelled", error: null, message: `Đã dừng: ${job.title}.` };
      } else {
        log.warn("job failed", { error: errText(e) });
        outcome = { status: "failed", error: errText(e).slice(0, 2000), message: `Không làm xong: ${job.title} — ${errText(e).slice(0, 500)}` };
      }
    } finally {
      clearInterval(ticker);
      shutdown.signal.removeEventListener("abort", onShutdown);
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (!outcome) return;
    finishJob(o.db, job.id, { status: outcome.status, result: outcome.result, error: outcome.error ?? null }, now());
    log.info("job finished", { status: outcome.status });
    const done = getJob(o.db, job.id)!;
    // the activity log: the job as Studio ran it for the person who asked
    logAudit(o.db, {
      actorKind: "studio", actorId: done.created_by, kind: "job", action: `job.${done.kind}`, outcome: done.status === "failed" ? "error" : "ok", at: now(),
      durationMs: done.started_at && done.finished_at ? Date.parse(done.finished_at) - Date.parse(done.started_at) : null,
      projectId: done.project_id, videoId: done.video_id, threadId: done.thread_id, jobId: done.id, target: done.title, summary: done.error?.slice(0, 300) ?? null,
      details: { status: done.status, node: done.node_id, units: done.units, farmJobId: done.farm_job_id, attempts: done.attempts },
    }, (e) => log.warn("job not in the activity log", { error: String(e) }));
    tellThread(o.db, done, outcome.status, outcome.message ?? null, now());
  };

  const tick = (): string[] => {
    if (shuttingDown || kinds.length === 0) return [];
    try {
      const { requeued, failed } = requeueStaleJobs(o.db, now());
      if (requeued.length || failed.length) o.logger.warn("jobs left by a stopped worker", { requeued, failed });
    } catch (e) { o.logger.warn("requeue of stale jobs failed", { error: errText(e) }); }
    const started: string[] = [];
    while (live.size < lanes) {
      const job = claimJob(o.db, kinds, now());
      if (!job) break;
      started.push(job.id);
      const p = run(job).catch((e) => o.logger.error("job runner crashed", { job_id: job.id, error: errText(e) })).finally(() => live.delete(job.id));
      live.set(job.id, p);
    }
    return started;
  };

  return {
    tick,
    running: () => [...live.keys()],
    idle: async () => { while (live.size) await Promise.all([...live.values()]); },
    runForever: async (signal) => {
      const pollMs = o.pollMs ?? 1000;
      while (!signal.aborted) {
        tick();
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

/**
 * A finished job's line in its thread, and the agent's next turn when the job asked for one, the project lets the
 * agent go on by itself, and it has not already gone on 3 times without a person's message.
 */
function tellThread(db: StudioDb, job: JobRecord, status: "done" | "failed" | "cancelled", message: string | null, now: string): void {
  if (!job.thread_id || !message) return;
  const thread = getThread(db, job.thread_id);
  if (!thread || thread.archived_at) return;
  const project = getProject(db, job.project_id);
  const settings = projectSettingsOf(project?.settings ?? null);
  const goOn = job.continue_agent === 1 && status !== "cancelled" && settings.auto_continue
    && automaticTurnsInARow(db, thread.id) < AUTO_TURNS_IN_A_ROW;
  const actor = job.actor_role ? { id: job.created_by, role: job.actor_role as ActorRole } : null;
  postSystemMessage(db, { threadId: thread.id, text: message, trigger: "job", continueAgent: goOn, actor }, now);
}
