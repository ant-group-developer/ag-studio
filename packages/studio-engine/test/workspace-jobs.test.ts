import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import {
  claimJob, createJob, createJobRunner, createProject, createThread, estimateSecondsLeft, finishJob, getJob, JOB_STALE_MS, jobView, listJobs,
  listMessages, postUserMessage, reportJob, requestJobCancel, requeueStaleJobs, runFarmStep, secondsPerUnit, seedWorkspace, studioLogger,
  type JobHandler, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();

function setup() {
  const w = world();
  w.db.run("INSERT OR IGNORE INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|u", NOW);
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "auth0|u" }, NOW);
  const workspacesRoot = join(w.dir, "workspaces");
  seedWorkspace(workspacesRoot, project);
  return { ...w, project, thread, workspacesRoot };
}

describe("project jobs", () => {
  it("are queued, claimed oldest first by kind, report progress and finish", () => {
    const { db, project } = setup();
    const a = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị A", request: { asset_id: "a" }, createdBy: "u" }, at(0));
    const b = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị B", request: { asset_id: "b" }, createdBy: "u" }, at(1));
    expect(claimJob(db, ["render_preview"], at(2))).toBeNull();
    const first = claimJob(db, ["prepare_asset"], at(2))!;
    expect(first).toMatchObject({ id: a.id, status: "running", started_at: at(2), attempts: 1 });
    reportJob(db, a.id, { phase: "Đang dò cảnh", progress: 1.4, etaSeconds: 12.6, nodeId: "may-1" }, at(3));
    expect(jobView(getJob(db, a.id)!)).toMatchObject({ phase: "Đang dò cảnh", progress: 1, etaSeconds: 13, nodeId: "may-1", request: { asset_id: "a" } });
    finishJob(db, a.id, { status: "done", result: { shots: 3 } }, at(10));
    expect(jobView(getJob(db, a.id)!)).toMatchObject({ status: "done", progress: 1, etaSeconds: null, phase: null, result: { shots: 3 }, finishedAt: at(10) });
    expect(listJobs(db, project.id, { active: true }).map((j) => j.id)).toEqual([b.id]);
  });

  it("stop: a queued job is cancelled at once, a running one is asked to stop", () => {
    const { db, project } = setup();
    const a = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    const b = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "B", request: {}, createdBy: "u" }, at(1));
    claimJob(db, ["prepare_asset"], at(2));
    expect(requestJobCancel(db, b.id, at(3))).toMatchObject({ status: "cancelled" });
    expect(requestJobCancel(db, a.id, at(3))).toMatchObject({ status: "running", cancel_requested: 1 });
  });

  it("jobs a stopped worker left go back in line, or fail after too many tries", () => {
    const { db, project } = setup();
    const a = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    claimJob(db, ["prepare_asset"], at(1));
    expect(requeueStaleJobs(db, at(30))).toEqual({ requeued: [], failed: [] });
    const later = new Date(Date.parse(at(1)) + JOB_STALE_MS + 1000).toISOString();
    expect(requeueStaleJobs(db, later)).toEqual({ requeued: [a.id], failed: [] });
    db.run("UPDATE project_jobs SET status = 'running', attempts = 3, updated_at = ? WHERE id = ?", [at(1), a.id]);
    expect(requeueStaleJobs(db, later)).toEqual({ requeued: [], failed: [a.id] });
  });

  it("time left: from progress, else the kind's history per unit, else a default", () => {
    const { db, project } = setup();
    expect(estimateSecondsLeft({ kind: "prepare_asset", elapsedSeconds: 30, progress: 0.25, units: null, secondsPerUnit: null })).toBe(90);
    expect(estimateSecondsLeft({ kind: "prepare_asset", elapsedSeconds: 10, progress: null, units: 100, secondsPerUnit: 0.5 })).toBe(40);
    expect(estimateSecondsLeft({ kind: "prepare_asset", elapsedSeconds: 0, progress: null, units: 100, secondsPerUnit: null })).toBeCloseTo(60);
    expect(estimateSecondsLeft({ kind: "fit", elapsedSeconds: 0, progress: null, units: 100, secondsPerUnit: null })).toBeNull();
    for (const [i, [secs, units]] of [[10, 10], [40, 10], [30, 10]].entries()) {
      const j = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "x", request: {}, units, createdBy: "u" }, at(i * 100));
      claimJob(db, ["prepare_asset"], at(i * 100));
      finishJob(db, j.id, { status: "done" }, at(i * 100 + secs));
    }
    expect(secondsPerUnit(db, "prepare_asset")).toBeCloseTo(3);
  });
});

const quiet = studioLogger({ test: "jobs" });

describe("job runner", () => {
  it("runs a job, shows its progress and time left, then tells its thread and lets the agent go on", async () => {
    const { db, project, thread, workspacesRoot, dir } = setup();
    postUserMessage(db, { threadId: thread.id, text: "Chuẩn bị video", actor: { id: "auth0|u", role: "editor" } }, at(0));
    db.run("UPDATE agent_messages SET status = 'done' WHERE thread_id = ?", [thread.id]);
    let release!: () => void;
    const seen: unknown[] = [];
    const handler: JobHandler = async (job, ctx) => {
      ctx.setUnits(100);
      ctx.report({ phase: "Đang dò cảnh", progress: 0.5 });
      seen.push(jobView(getJob(db, job.id)!));
      await new Promise<void>((r) => { release = r; });
      return { result: { ok: true }, message: "Đã chuẩn bị **A**." };
    };
    const job = createJob(db, {
      projectId: project.id, threadId: thread.id, kind: "prepare_asset", title: "Chuẩn bị A", request: {}, continueAgent: true, createdBy: "auth0|u", actorRole: "editor",
    }, at(1));
    const runner = createJobRunner({ db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: handler }, tickMs: 20 });
    expect(runner.tick()).toEqual([job.id]);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen[0]).toMatchObject({ status: "running", phase: "Đang dò cảnh", progress: 0.5 });
    expect((seen[0] as { etaSeconds: number }).etaSeconds).toBeGreaterThanOrEqual(0);
    release();
    await runner.idle();
    expect(getJob(db, job.id)).toMatchObject({ status: "done", progress: 1 });
    const msgs = listMessages(db, thread.id);
    expect(msgs.slice(-2).map((m) => [m.role, m.trigger, m.status])).toEqual([["system", "job", "done"], ["assistant", "job", "pending"]]);
    expect(msgs.at(-2)!.text).toBe("Đã chuẩn bị **A**.");
  });

  it("stops a running job when a person asks: the handler's signal aborts, the job is cancelled, the agent waits", async () => {
    const { db, project, thread, workspacesRoot, dir } = setup();
    const handler: JobHandler = async (_job, ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        void resolve;
      });
      return { result: null };
    };
    const job = createJob(db, { projectId: project.id, threadId: thread.id, kind: "prepare_asset", title: "Chuẩn bị A", request: {}, continueAgent: true, createdBy: "u" }, at(0));
    const runner = createJobRunner({ db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: handler }, tickMs: 10 });
    runner.tick();
    requestJobCancel(db, job.id);
    await runner.idle();
    expect(getJob(db, job.id)).toMatchObject({ status: "cancelled" });
    const msgs = listMessages(db, thread.id);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([["system", "Đã dừng: Chuẩn bị A."]]);
  });

  it("a failed job says why in its thread", async () => {
    const { db, project, thread, workspacesRoot, dir } = setup();
    const job = createJob(db, { projectId: project.id, threadId: thread.id, kind: "prepare_asset", title: "Chuẩn bị A", request: {}, createdBy: "u" }, at(0));
    const runner = createJobRunner({
      db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: async () => { throw new Error("ag-go không trả được video"); } },
    });
    runner.tick();
    await runner.idle();
    expect(getJob(db, job.id)).toMatchObject({ status: "failed", error: "ag-go không trả được video" });
    expect(listMessages(db, thread.id).at(-1)!.text).toBe("Không làm xong: Chuẩn bị A — ag-go không trả được video");
  });

  it("shutting down puts a running job back in line instead of failing it", async () => {
    const { db, project, workspacesRoot, dir } = setup();
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    const handler: JobHandler = async (_job, ctx) => {
      await new Promise<void>((_r, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return { result: null };
    };
    const runner = createJobRunner({ db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: handler }, pollMs: 10 });
    const ac = new AbortController();
    const done = runner.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 40));
    expect(getJob(db, job.id)!.status).toBe("running");
    ac.abort();
    await done;
    expect(getJob(db, job.id)).toMatchObject({ status: "queued" });
  });
});

function farmView(over: Partial<FarmJobView>): FarmJobView {
  return {
    id: "00000000-0000-4000-8000-00000000f001", owner: "studio", type: "studio.transcribe", lane: "gpu", status: "queued", priority: 0,
    correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 0, max_attempts: 2, node_id: null, progress_percent: null,
    progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
  } as FarmJobView;
}

function fakeFarm(script: Partial<FarmJobView>[]) {
  const calls: { submit: unknown[]; cancel: string[]; ack: string[] } = { submit: [], cancel: [], ack: [] };
  let i = 0;
  const farm: ProjectFarm = {
    submitJob: async (req) => { calls.submit.push(req); return { job: farmView(script[0] ?? {}), created: true }; },
    getJob: async () => farmView(script[Math.min(++i, script.length - 1)] ?? {}),
    cancelJob: async (id) => { calls.cancel.push(id); return farmView({ status: "cancelled" }); },
    ackJob: async (id) => { calls.ack.push(id); return farmView({ status: "completed" }); },
    listNodes: async () => ({ nodes: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "GPU-02", online: true, kinds: [], gpus: [], running_jobs: 1, last_seen_at: NOW }] }),
  };
  return { farm, calls };
}

describe("farm step of a project job", () => {
  it("uploads its inputs, records the farm job for /farm/sign, shows the machine and progress, answers its output prefix", async () => {
    const { db, bucket, project, dir } = setup();
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    const wav = join(mkdtempSync(join(tmpdir(), "farm-step-")), "a.wav");
    writeFileSync(wav, "RIFF");
    const { farm, calls } = fakeFarm([{}, { status: "leased", node_id: "00000000-0000-4000-8000-0000000000a1", progress_percent: 40, progress_stage: "whisper" }, { status: "completed" }]);
    const updates: unknown[] = [];
    const r = await runFarmStep({ db, bucket, farm, pollMs: 1 }, job, {
      type: "studio.transcribe", payload: { x: 1 }, stageKey: "prepare", attemptId: job.id, uploads: [{ localPath: wav, relPath: "audio/a.wav" }],
    }, { onUpdate: (u) => updates.push(u), stopRequested: () => null });
    expect(bucket.objects.has(`productions/${project.id}/jobs/prepare/${job.id}/in/audio/a.wav`)).toBe(true);
    expect(calls.submit[0]).toMatchObject({ type: "studio.transcribe", correlation_id: `studio-job-prepare-${job.id}`, affinity_key: project.id });
    expect(db.get("SELECT project_id, job_id, stage_key, attempt_id, job_type FROM project_farm_jobs")).toEqual({
      project_id: project.id, job_id: job.id, stage_key: "prepare", attempt_id: job.id, job_type: "studio.transcribe",
    });
    expect(updates).toEqual([
      { phase: "Farm · đang chờ máy nhận", progress: null, node: null, farmJobId: "00000000-0000-4000-8000-00000000f001", waiting: true },
      { phase: "Farm · GPU-02 · whisper", progress: 0.4, node: "GPU-02", farmJobId: "00000000-0000-4000-8000-00000000f001", waiting: false },
    ]);
    expect(r.outputPrefix).toBe(`productions/${project.id}/jobs/prepare/${job.id}/out/`);
    void dir;
  });

  it("a stop request cancels the farm job; a failed farm job throws its reason", async () => {
    const { db, bucket, project } = setup();
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    const a = fakeFarm([{}, { status: "leased" }]);
    let stop: "cancelled" | null = null;
    const p = runFarmStep({ db, bucket, farm: a.farm, pollMs: 1 }, job, { type: "studio.transcribe", payload: {}, stageKey: "prepare", attemptId: job.id },
      { onUpdate: () => { stop = "cancelled"; }, stopRequested: () => stop });
    await expect(p).rejects.toMatchObject({ name: "JobStopped", reason: "cancelled" });
    expect(a.calls.cancel).toEqual(["00000000-0000-4000-8000-00000000f001"]);
    const b = fakeFarm([{}, { status: "failed", error: { code: "x", message: "hết VRAM", retryable: false } as never }]);
    await expect(runFarmStep({ db, bucket, farm: b.farm, pollMs: 1 }, job, { type: "studio.transcribe", payload: {}, stageKey: "prepare", attemptId: `${job.id}-b` },
      { onUpdate: () => {}, stopRequested: () => null })).rejects.toThrow("farm báo lỗi: hết VRAM");
  });
});

describe("ffmpeg -progress", () => {
  it("reads out_time across chunk boundaries", async () => {
    const { progressReader } = await import("../src/cut-ffmpeg.js");
    const seen: number[] = [];
    const read = progressReader((s) => seen.push(s));
    read("frame=10\nout_time_us=1500");
    read("000\nprogress=continue\r\nout_time_ms=3000000\n");
    expect(seen).toEqual([1.5, 3]);
  });
});

describe("project activity", () => {
  it("lists jobs in line and running with what they do, how far, time left and the machine; the heartbeat alone changes nothing", async () => {
    const { agentActivity, projectFingerprint, touchJob } = await import("../src/index.js");
    const { db, project, thread } = setup();
    const a = createJob(db, { projectId: project.id, threadId: thread.id, kind: "prepare_asset", title: "Chuẩn bị A", request: {}, createdBy: "u" }, at(0));
    const b = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị B", request: {}, createdBy: "u" }, at(1));
    claimJob(db, ["prepare_asset"], at(2));
    reportJob(db, a.id, { phase: "Farm · GPU-02 · đọc lời thoại", progress: 0.4, etaSeconds: 30, nodeId: "GPU-02" }, at(3));
    expect(agentActivity(db, project.id)).toEqual([
      expect.objectContaining({ id: a.id, kind: "job", status: "running", title: "Chuẩn bị A", detail: "Farm · GPU-02 · đọc lời thoại", progress: 0.4, etaSeconds: 30, node: "GPU-02", cancellable: true, threadTitle: "Kênh", jobKind: "prepare_asset" }),
      expect.objectContaining({ id: b.id, kind: "job", status: "waiting", startedAt: null }),
    ]);
    const before = projectFingerprint(db, project.id);
    touchJob(db, a.id, at(5));
    expect(projectFingerprint(db, project.id)).toBe(before);
    reportJob(db, a.id, { progress: 0.5 }, at(6));
    expect(projectFingerprint(db, project.id)).not.toBe(before);
    requestJobCancel(db, a.id, at(7));
    expect(agentActivity(db, project.id)[0]).toMatchObject({ cancellable: false });
  });

  it("the Queue screen: what runs in the projects of the person's teams (an admin sees all), the rest only counted", async () => {
    const { studioActivity } = await import("../src/index.js");
    const { db, project } = setup();
    db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-2', 'Khác', ?, ?)", [NOW, NOW]);
    db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', 'auth0|u', 'editor', ?)", [NOW]);
    const other = createProject(db, "team-2", { name: "Ẩm thực", description: "", language: "vi", aspect: "16:9" }, "auth0|x", at(1));
    const mine = createJob(db, { projectId: project.id, kind: "research", title: "Crawl", request: {}, createdBy: "u" }, at(0));
    createJob(db, { projectId: other.id, kind: "render_preview", title: "Xem trước", request: {}, createdBy: "x" }, at(1));
    expect(studioActivity(db, { userId: "auth0|u", isAdmin: false })).toEqual({
      items: [expect.objectContaining({ id: mine.id, projectId: project.id, projectName: "Du lịch chậm", teamId: "team-1", kind: "job" })],
      hidden: 1,
    });
    expect(studioActivity(db, { userId: "auth0|admin", isAdmin: true }).items.map((i) => i.projectName)).toEqual(["Du lịch chậm", "Ẩm thực"]);
  });
});

describe("waiting for a farm machine", () => {
  it("says no time left while no machine took the job, and gives up after the queue timeout (cancelled on the farm)", async () => {
    const { db, bucket, project } = setup();
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, at(0));
    const { farm, calls } = fakeFarm([{}, {}, {}, {}]);
    const updates: { waiting: boolean }[] = [];
    await expect(runFarmStep({ db, bucket, farm, pollMs: 5, queueTimeoutMs: 20 }, job, { type: "studio.transcribe", payload: {}, stageKey: "prepare", attemptId: job.id },
      { onUpdate: (u) => updates.push(u), stopRequested: () => null })).rejects.toThrow("không máy farm nào nhận việc");
    expect(updates.every((u) => u.waiting)).toBe(true);
    expect(calls.cancel).toEqual(["00000000-0000-4000-8000-00000000f001"]);
  });

  it("a job waiting in line shows no time left", async () => {
    const { db, project, workspacesRoot, dir } = setup();
    let release!: () => void;
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, units: 100, createdBy: "u" }, at(0));
    const runner = createJobRunner({
      db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), tickMs: 10,
      handlers: { prepare_asset: async (_j, ctx) => { ctx.report({ phase: "Farm · đang chờ máy nhận", progress: 0.68, waiting: true }); await new Promise<void>((r) => { release = r; }); return { result: null }; } },
    });
    runner.tick();
    await new Promise((r) => setTimeout(r, 40));
    expect(getJob(db, job.id)).toMatchObject({ phase: "Farm · đang chờ máy nhận", progress: 0.68, eta_seconds: null });
    release();
    await runner.idle();
  });
});

describe("time left after waiting in line", () => {
  it("does not count the time spent waiting for a farm machine", async () => {
    const { db, project, workspacesRoot, dir } = setup();
    let clockMs = Date.parse(at(0));
    const now = () => new Date(clockMs).toISOString();
    const job = createJob(db, { projectId: project.id, kind: "prepare_asset", title: "A", request: {}, createdBy: "u" }, now());
    let step!: (n: number) => void;
    const runner = createJobRunner({
      db, logger: quiet, workspacesRoot, dataRoot: join(dir, "data"), tickMs: 60_000, now,
      handlers: {
        prepare_asset: async (_j, ctx) => {
          ctx.report({ progress: 0.1, waiting: true });
          clockMs += 600_000; // ten minutes in line
          ctx.report({ progress: 0.5, waiting: false });
          clockMs += 20_000; // twenty seconds of work
          ctx.report({ progress: 0.5 });
          await new Promise<void>((r) => { step = () => r(); });
          return { result: null };
        },
      },
    });
    runner.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(getJob(db, job.id)!.eta_seconds).toBe(20);
    step(0);
    await runner.idle();
  });
});
