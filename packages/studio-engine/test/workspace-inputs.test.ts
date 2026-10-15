import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSource, assetCounts, assetState, claimJob, createJob, createProject, finishJob, getJob, jobCancelRequested, jobView, queuePrepare, reportJob, requestJobCancel,
  requeueStaleJobs, savePrepared, secondsPerUnit, sourceItems, touchJob, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-12T08:00:00.000Z";

let opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened) await db.close(); opened = []; });

async function setup() {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  return { ...w, project };
}

const prepared = (projectId: string, assetId: string, status: "ready" | "failed") => ({
  project_id: projectId, asset_id: assetId, status, name: assetId, duration_s: 10, width: 1920, height: 1080, has_audio: true, shots: 4, transcript: false,
  source_kind: null, watermarked: null, error: status === "failed" ? "hỏng" : null,
});

describe("the sources list for many videos", () => {
  it("is one pass however many videos and jobs there are, and counts each video once by where it stands", async () => {
    const s = await setup();
    const pid = s.project.id;
    const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
    for (const id of ids) await addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: id, mediaType: "video", label: `clip ${id}`, addedBy: "u" }, NOW);
    // the same video picked for a video as well: counted once
    await s.db.run("INSERT INTO videos (id, project_id, idx, title, status, created_by, created_at, updated_at) VALUES ('v1', ?, 1, 'Huế', 'draft', 'u', ?, ?)", [pid, NOW, NOW]);
    await addSource(s.db, { projectId: pid, videoId: "v1", kind: "ag_go_asset", ref: "a0", mediaType: "video", label: "clip a0", addedBy: "u" }, NOW);
    for (let i = 0; i < 110; i += 40) await queuePrepare(s.db, { projectId: pid, assetIds: ids.slice(i, Math.min(i + 40, 110)), createdBy: "u" }, NOW);
    await claimJob(s.db, ["prepare_asset"], NOW);
    for (const id of ["a110", "a111", "a112", "a113", "a114"]) await savePrepared(s.db, prepared(pid, id, "ready"), NOW);
    for (const id of ["a115", "a116"]) await savePrepared(s.db, prepared(pid, id, "failed"), NOW);

    const all = vi.spyOn(s.db, "all");
    const get = vi.spyOn(s.db, "get");
    const items = await sourceItems(s.db, pid);
    expect(all.mock.calls.length + get.mock.calls.length).toBeLessThanOrEqual(4);
    all.mockRestore();
    get.mockRestore();

    expect(items).toHaveLength(121);
    expect(assetCounts(items)).toEqual({ videos: 120, ready: 5, preparing: 110, failed: 2, notPrepared: 3 });
    expect(new Set(items.filter((x) => x.asset?.state === "preparing").map((x) => x.ref)).size).toBe(1);
    // past the first hundred jobs, a video in line is still seen as in line (not "not prepared")
    for (const id of ids.slice(0, 110)) expect(["queued", "preparing"]).toContain((await assetState(s.db, pid, id)).state);
    expect(items.find((x) => x.ref === "a0")!.asset).toEqual(await assetState(s.db, pid, "a0"));
    expect(items.find((x) => x.ref === "a110")!.asset).toMatchObject({ state: "ready", transcript: false });
  });

  it("queues a video once even when asked twice in one call", async () => {
    const s = await setup();
    const pid = s.project.id;
    await addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: "a1", mediaType: "video", label: "clip", addedBy: "u" }, NOW);
    const r = await queuePrepare(s.db, { projectId: pid, assetIds: ["a1", "a1", "zz"], createdBy: "u" }, NOW);
    expect(r).toEqual({ a1: expect.objectContaining({ state: "queued" }), zz: { state: "not_an_input" } });
    expect(await s.db.all("SELECT id FROM project_jobs WHERE project_id = ?", [pid])).toHaveLength(1);
    // one video alone is no batch: its own message, as before
    expect((await getJob(s.db, (r.a1 as { job_id: string }).job_id))!.request).not.toHaveProperty("batch_id");
  });

  it("videos queued together share a batch, so their thread hears once", async () => {
    const s = await setup();
    const pid = s.project.id;
    for (const id of ["a1", "a2", "a3"]) await addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: id, mediaType: "video", label: `clip ${id}`, addedBy: "u" }, NOW);
    await queuePrepare(s.db, { projectId: pid, assetIds: ["a1", "a2", "a3"], createdBy: "u" }, NOW);
    const batches = (await s.db.all<{ request: { batch_id?: string } }>("SELECT request FROM project_jobs WHERE project_id = ?", [pid])).map((j) => j.request.batch_id);
    expect(batches).toHaveLength(3);
    expect(new Set(batches).size).toBe(1);
    expect(batches[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("queues a video once when two calls ask at the same time", async () => {
    const s = await setup();
    const pid = s.project.id;
    await addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: "a1", mediaType: "video", label: "clip", addedBy: "u" }, NOW);
    const [a, b] = await Promise.all([1, 2].map(() => queuePrepare(s.db, { projectId: pid, assetIds: ["a1"], createdBy: "u" }, NOW)));
    expect(a!.a1).toMatchObject({ state: "queued" });
    expect(b!.a1).toMatchObject({ state: "queued", job_id: (a!.a1 as { job_id: string }).job_id });
    expect(await s.db.all("SELECT id FROM project_jobs WHERE project_id = ?", [pid])).toHaveLength(1);
  });
});

describe("taking a queued job", () => {
  it("two workers asking at once never take the same job", async () => {
    const s = await setup();
    const pid = s.project.id;
    const make = (n: number) => createJob(s.db, { projectId: pid, kind: "render_preview", title: `j${n}`, request: { n }, createdBy: "u" }, `2026-10-12T08:00:0${n}.000Z`);
    const j1 = await make(1);
    const j2 = await make(2);
    const claimed = await Promise.all([1, 2, 3].map(() => claimJob(s.db, ["render_preview"], NOW)));
    const ids = claimed.filter((j) => j !== null).map((j) => j!.id);
    expect(ids.sort()).toEqual([j1.id, j2.id].sort());
    expect(claimed.filter((j) => j === null)).toHaveLength(1);
    expect(claimed.find((j) => j?.id === j1.id)).toMatchObject({ status: "running", attempts: 1, started_at: NOW, request: { n: 1 }, cancel_requested: false });
    expect(await claimJob(s.db, ["render_preview"], NOW)).toBeNull();
    expect(await claimJob(s.db, [], NOW)).toBeNull();
  });

  it("stopping, reporting, jobs a stopped worker left, and seconds per unit", async () => {
    const s = await setup();
    const pid = s.project.id;
    const make = (n: number, units: number | null = null) => createJob(s.db, { projectId: pid, kind: "render_preview", title: `j${n}`, request: {}, units, createdBy: "u" }, `2026-10-12T08:00:0${n}.000Z`);
    const queued = await make(1);
    expect(await requestJobCancel(s.db, queued.id, NOW)).toMatchObject({ status: "cancelled", finished_at: NOW, cancel_requested: false });
    const running = await make(2, 10);
    await claimJob(s.db, ["render_preview"], "2026-10-12T08:00:00.000Z");
    await reportJob(s.db, running.id, { phase: "Đang dựng", progress: 1.5, etaSeconds: 3.4 }, NOW);
    expect(jobView((await getJob(s.db, running.id))!)).toMatchObject({ phase: "Đang dựng", progress: 1, etaSeconds: 3, cancelRequested: false, request: {} });
    expect(await requestJobCancel(s.db, running.id, NOW)).toMatchObject({ status: "running", cancel_requested: true });
    expect(await jobCancelRequested(s.db, running.id)).toBe(true);
    await finishJob(s.db, running.id, { status: "done", result: { ok: 1 } }, "2026-10-12T08:00:20.000Z");
    expect(await getJob(s.db, running.id)).toMatchObject({ status: "done", phase: null, progress: 1, result: { ok: 1 } });
    expect(await secondsPerUnit(s.db, "render_preview")).toBe(2);
    // left running: back in line, or failed after too many attempts, or cancelled when asked to stop; a job touched since is left
    const ids = [];
    for (const n of [3, 4, 5, 6]) {
      const j = await make(n);
      await claimJob(s.db, ["render_preview"], NOW);
      ids.push(j.id);
    }
    await s.db.run("UPDATE project_jobs SET attempts = 3 WHERE id = ?", [ids[1]!]);
    await s.db.run("UPDATE project_jobs SET cancel_requested = true WHERE id = ?", [ids[2]!]);
    await touchJob(s.db, ids[3]!, "2026-10-12T08:05:00.000Z");
    expect(await requeueStaleJobs(s.db, "2026-10-12T08:06:00.000Z")).toEqual({ requeued: [ids[0]], failed: [ids[1]] });
    expect((await Promise.all(ids.map((id) => getJob(s.db, id)))).map((j) => j!.status)).toEqual(["queued", "failed", "cancelled", "running"]);
  });
});
