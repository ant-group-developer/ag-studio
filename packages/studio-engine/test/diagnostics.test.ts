import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject, createThread, createVideo, diagnosticsErrors, diagnosticsOverview, errorEventRecorder, errorSignature, groupErrors, previousPeriod, quantile,
  sweepErrorEvents, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-11-07T08:00:00.000Z";
const PERIOD = { from: "2026-10-31T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" };

let open: StudioDb | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function job(db: StudioDb, j: { project: string; video?: string | null; kind: string; status: string; at: string; error?: string | null; started?: string | null }) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO project_jobs (id, project_id, video_id, kind, status, title, request, error, created_by, created_at, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'job', '{}', ?, 'auth0|lan', ?, ?, ?)`,
    [id, j.project, j.video ?? null, j.kind, j.status, j.error ?? null, j.at, j.started ?? null, j.at],
  );
  return id;
}

async function answer(db: StudioDb, a: { thread: string; seq: number; status: string; trigger?: string; at: string; error?: string | null; cost?: number }) {
  await db.run(
    `INSERT INTO agent_messages (id, thread_id, seq, role, status, trigger, error, cost_usd, created_at, updated_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), a.thread, a.seq, a.status, a.trigger ?? "user", a.error ?? null, a.cost ?? 0, a.at, a.at],
  );
}

async function setup() {
  const w = await world();
  open = w.db;
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Nhóm', ?, ?)", [NOW, NOW]);
  const p = await createProject(w.db, "team-1", { name: "Du lịch", description: "", language: "vi", aspect: "16:9" }, "auth0|lan", NOW);
  const v = await createVideo(w.db, p.id, { title: "Tràng An", createdBy: "auth0|lan" }, NOW);
  const t = await createThread(w.db, { projectId: p.id, videoId: v.id, kind: "video", title: "Tràng An", createdBy: "auth0|lan" }, NOW);
  return { ...w, p, v, t };
}

describe("error signatures", () => {
  it("groups the same failure with other ids, numbers and HTML pages", () => {
    expect(errorSignature("videos/b18237d5-a6b0-408d-91fb-4efce002411f/survey.json thiếu hoặc sai (skill scene-selection)"))
      .toBe("videos/<id>/survey.json thiếu hoặc sai (skill scene-selection)");
    expect(errorSignature("farm báo lỗi: mezzanine 62 (cpu retry): ffmpeg exited 4294967274: Error initializing complex filters"))
      .toBe(errorSignature("farm báo lỗi: mezzanine 0 (cpu retry): ffmpeg exited 4294967274: Error initializing complex filters"));
    expect(errorSignature("Sign request failed: HTTP 502 - <!DOCTYPE html>\n<html lang=en>...")).toBe("Sign request failed: HTTP 502 - <html>");
    expect(errorSignature("[fc#0 @ 0000013b857c64c0] Cannot allocate memory")).toBe(errorSignature("[fc#0 @ 00000245236464c0] Cannot allocate memory"));
    expect(errorSignature("Part 13 PUT failed: HTTP 502")).toBe("Part N PUT failed: HTTP 502");
    expect(errorSignature("x".repeat(400))).toHaveLength(160);
  });

  it("marks a group new or seen before, and lists what is gone", () => {
    const o = (message: string, at = "2026-11-01T00:00:00.000Z") => ({ source: "job" as const, kind: "fit", message, at, projectId: "p1", projectName: null, videoId: null, ref: null });
    const { groups, gone } = groupErrors([o("timeout 1"), o("timeout 2"), o("boom")], [o("timeout 9"), o("gone away")]);
    expect(groups.map((g) => [g.signature, g.count, g.trend, g.previousCount])).toEqual([["timeout N", 2, "same", 1], ["boom", 1, "new", 0]]);
    expect(gone.map((g) => g.signature)).toEqual(["gone away"]);
  });

  it("quantiles and the period before", () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    expect(previousPeriod(PERIOD)).toMatchObject({ from: "2026-10-24T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" });
  });
});

describe("diagnostics of a period", () => {
  it("counts jobs and turns against the period before, finds stuck jobs, and days in the viewer's zone", async () => {
    const s = await setup();
    await job(s.db, { project: s.p.id, kind: "fit", status: "done", at: "2026-11-01T10:00:00.000Z" });
    await job(s.db, { project: s.p.id, kind: "fit", status: "failed", at: "2026-11-01T18:00:00.000Z", error: "boom" });
    await job(s.db, { project: s.p.id, kind: "fit", status: "failed", at: "2026-10-25T10:00:00.000Z", error: "boom" });
    await job(s.db, { project: s.p.id, kind: "render_final", status: "running", at: "2026-11-07T03:00:00.000Z", started: "2026-11-07T03:00:00.000Z" });
    await job(s.db, { project: s.p.id, kind: "render_preview", status: "running", at: "2026-11-07T07:30:00.000Z", started: "2026-11-07T07:30:00.000Z" });
    await answer(s.db, { thread: s.t.id, seq: 1, status: "done", at: "2026-11-01T10:00:00.000Z", cost: 0.5 });
    await answer(s.db, { thread: s.t.id, seq: 2, status: "failed", trigger: "timeout", at: "2026-11-02T10:00:00.000Z", error: "timeout" });
    const o = await diagnosticsOverview(s.db, { ...PERIOD, tzOffsetMinutes: 420 }, NOW);
    expect(o.jobs).toEqual([{ kind: "fit", status: "done", n: 1 }, { kind: "fit", status: "failed", n: 1 }]);
    expect(o.previousJobs).toEqual([{ kind: "fit", status: "failed", n: 1 }]);
    expect(o.turns).toEqual({ byStatus: { done: 1, failed: 1 }, byTrigger: { user: 1, timeout: 1 }, costUsd: 0.5 });
    expect(o.stuck.map((j) => [j.kind, j.minutes])).toEqual([["render_final", 300]]);
    // 18:00 UTC is the next day in Vietnam
    expect(o.daily).toEqual([
      { day: "2026-11-01", jobs: 1, jobsFailed: 0, turns: 1, turnsFailed: 0 },
      { day: "2026-11-02", jobs: 1, jobsFailed: 1, turns: 1, turnsFailed: 1 },
    ]);
  });

  it("groups errors of jobs, turns and the activity log, with the project named", async () => {
    const s = await setup();
    await job(s.db, { project: s.p.id, video: s.v.id, kind: "render_preview", status: "failed", at: "2026-11-01T10:00:00.000Z", error: "farm báo lỗi: Part 3 PUT failed: HTTP 502" });
    await job(s.db, { project: s.p.id, video: s.v.id, kind: "render_final", status: "failed", at: "2026-11-02T10:00:00.000Z", error: "farm báo lỗi: Part 9 PUT failed: HTTP 502" });
    await job(s.db, { project: s.p.id, kind: "fit", status: "failed", at: "2026-10-26T10:00:00.000Z", error: "old trouble" });
    await answer(s.db, { thread: s.t.id, seq: 1, status: "failed", trigger: "timeout", at: "2026-11-03T10:00:00.000Z", error: "timeout" });
    await s.db.run(
      `INSERT INTO audit_log (id, at, actor_kind, kind, action, outcome, project_id, summary) VALUES (?, '2026-11-03T11:00:00Z', 'user', 'http', 'POST /x', 'error', ?, 'bài học này đã được xử lý')`,
      [randomUUID(), s.p.id],
    );
    const e = await diagnosticsErrors(s.db, PERIOD);
    expect(e.total).toBe(4);
    expect(e.groups.map((g) => [g.source, g.signature, g.count, g.kinds, g.trend])).toEqual([
      ["job", "farm báo lỗi: Part N PUT failed: HTTP 502", 2, ["render_final", "render_preview"], "new"],
      ["http", "bài học này đã được xử lý", 1, ["POST /x"], "new"],
      ["turn", "timeout", 1, ["timeout"], "new"],
    ]);
    expect(e.groups[0]!.examples[0]).toMatchObject({ projectName: "Du lịch", videoId: s.v.id });
    expect(e.gone).toEqual([{ key: "job|old trouble", source: "job", signature: "old trouble", previousCount: 1 }]);
  });
});

describe("error events (stdout errors kept in the database)", () => {
  it("records a worker's warn and error lines, folds repeats within a minute, and the diagnostics count them", async () => {
    const s = await setup();
    let t = Date.parse("2026-11-02T10:00:00.000Z");
    const rec = errorEventRecorder({ service: "studio-worker", now: () => t });
    rec.fromLogLine(JSON.stringify({ level: "warn", time: "2026-11-02T09:00:00.000Z", service: "studio-worker", msg: "dropped before attach" }));
    rec.attach(s.db);
    const line = (msg: string, extra: object = {}) => JSON.stringify({ level: "error", time: new Date(t).toISOString(), service: "studio-worker", owner: "w1", msg, ...extra });
    rec.fromLogLine(JSON.stringify({ level: "info", time: new Date(t).toISOString(), msg: "fine" }));
    rec.fromLogLine(line("farm poll failed", { error: "fetch failed 12", projectId: s.p.id }));
    await new Promise((r) => setTimeout(r, 50));
    t += 30_000;
    rec.fromLogLine(line("farm poll failed", { error: "fetch failed 13", projectId: s.p.id }));
    await new Promise((r) => setTimeout(r, 50));
    t += 120_000;
    await rec.record({ service: "studio-api", level: "error", message: "GET /api/x -> 500 INTERNAL: boom", requestId: "req-12345678" });
    const rows = await s.db.all<{ service: string; message: string; repeats: number; project_id: string | null; context: Record<string, unknown> }>(
      "SELECT service, message, repeats, project_id, context FROM error_events ORDER BY at",
    );
    expect(rows.map((r) => [r.service, r.message, r.repeats])).toEqual([
      ["studio-worker", "farm poll failed: fetch failed 12", 2],
      ["studio-api", "GET /api/x -> 500 INTERNAL: boom", 1],
    ]);
    expect(rows[0]).toMatchObject({ project_id: s.p.id, context: { error: "fetch failed 12", projectId: s.p.id } });
    const e = await diagnosticsErrors(s.db, PERIOD);
    expect(e.total).toBe(3);
    expect(e.groups.map((g) => [g.source, g.signature, g.count])).toEqual([
      ["log:studio-worker", "farm poll failed: fetch failed N", 2],
      ["log:studio-api", "GET /api/x -> N INTERNAL: boom", 1],
    ]);
    expect(await sweepErrorEvents(s.db, "2026-11-02T10:01:00.000Z")).toBe(1);
  });

  it("never throws when the database fails", async () => {
    const errors: unknown[] = [];
    const db = { run: async () => { throw new Error("down"); } } as unknown as StudioDb;
    const rec = errorEventRecorder({ db, service: "studio-api", onError: (e) => errors.push(e) });
    await expect(rec.record({ service: "studio-api", level: "error", message: "x" })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
