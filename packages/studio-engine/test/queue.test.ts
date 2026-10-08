/**
 * The Queue screen (mockup 12): Claude calls running and waiting, the farm jobs not done, filtered to what the person
 * may see. Farm jobs and machines are read from ag-farm's owner API.
 */
import { describe, expect, it } from "vitest";
import { acquireChatSlot, cachedQueueFarm, insertUserTurn, startPlanRun, studioQueue, type QueueFarm } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const NOW = "2026-10-06T10:30:00.000Z";
const OTHER = "22222222-2222-4222-8222-222222222222";

function seed() {
  const w = world();
  const mine = seedProduction(w.db, { title: "Series Kyoto" });
  const other = seedProduction(w.db, { id: OTHER, title: "Đà Lạt" });
  const t = "2026-10-06T09:00:00.000Z";
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-2', 'Khác', ?, ?)", [t, t]);
  w.db.run("UPDATE productions SET team_id = 'team-2' WHERE id = ?", [other]);
  w.db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, run_id, created_at, updated_at) VALUES ('ep-1', ?, 1, 'Rừng tre', 'h', '{}', 'run-ep1', ?, ?)", [mine, t, t]);
  w.db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, run_id, created_at, updated_at) VALUES ('ep-9', ?, 1, 'Hồ Xuân Hương', 'h', '{}', 'run-ep9', ?, ?)", [other, t, t]);
  const job = (id: string, prod: string, ep: string | null, type: string, req: string | null, stage = "render-final") =>
    w.db.run("INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, episode_id, job_type, is_final_render, requirements, created_at) VALUES (?, ?, 'r', ?, 'a', ?, ?, ?, 0, ?, ?)",
      [`row-${id}`, id, stage, prod, ep, type, req, t]);
  job("f-final", mine, "ep-1", "studio.render_final", '{"nvenc":true}');
  job("f-preview", mine, "ep-1", "studio.render_preview", "{}", "editor");
  job("f-old", mine, "ep-1", "studio.render_final", null);
  job("f-other", other, "ep-9", "studio.render_final", '{"gpu":true}');
  return { ...w, mine, other };
}

type FakeJob = { status: string; progress_percent?: number | null; created_at?: string; attempt_count?: number };

function farm(jobs: Record<string, FakeJob>, pageSize = 100) {
  const calls: unknown[] = [];
  const all = Object.entries(jobs).map(([id, j]) => ({
    id, status: j.status, progress_percent: j.progress_percent ?? null, progress_stage: null, attempt_count: j.attempt_count ?? 1,
    created_at: j.created_at ?? "2026-10-06T10:25:00.000Z", node_id: null,
  }));
  const f: QueueFarm & { calls: unknown[] } = {
    calls,
    async listJobs(q) {
      calls.push(q);
      const start = q?.after ? Number(q.after) : 0;
      const page = all.slice(start, start + pageSize);
      return { jobs: page as never, next_cursor: start + pageSize < all.length ? String(start + pageSize) : null };
    },
  };
  return f;
}

const LEASE = "INSERT INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES (?, ?, ?, ?, 1, ?)";

describe("studioQueue", () => {
  it("lists the farm jobs not done that belong to videos the person can see, with the machine type each was sent as", async () => {
    const s = seed();
    const f = farm({
      "f-final": { status: "leased", progress_percent: 62, attempt_count: 1 },
      "f-preview": { status: "queued", created_at: "2026-10-06T10:28:00.000Z" },
      "f-old": { status: "queued", created_at: "2026-10-06T10:00:00.000Z" },
      "f-other": { status: "leased", progress_percent: 30 },
      "f-stranger": { status: "queued" },
    });
    const q = await studioQueue(s.core, s.db, f, { userId: "auth0|owner", isAdmin: false, now: NOW, claudeMax: 20 });
    expect(q.farm).toEqual({ ok: true });
    const ep = { productionId: s.mine, productionTitle: "Series Kyoto", episodeId: "ep-1", episodeIdx: 1, episodeTitle: "Rừng tre" };
    expect(q.renders).toEqual([
      { farmJobId: "f-final", kind: "final", ...ep, machine: "nvenc", status: "leased", progress: 62, progressStage: null, attempt: 1, createdAt: "2026-10-06T10:25:00.000Z", stuck: false, node: null, pinned: null },
      { farmJobId: "f-preview", kind: "preview", ...ep, machine: "any", status: "queued", progress: null, progressStage: null, attempt: 1, createdAt: "2026-10-06T10:28:00.000Z", stuck: false, node: null, pinned: null },
      // queued for 30 minutes: no node took it, maybe none fits
      { farmJobId: "f-old", kind: "final", ...ep, machine: null, status: "queued", progress: null, progressStage: null, attempt: 1, createdAt: "2026-10-06T10:00:00.000Z", stuck: true, node: null, pinned: null },
    ]);
    expect(q.hiddenRenders).toBe(1);
    expect(f.calls[0]).toMatchObject({ status: "queued,leased,paused" });
  });

  it("lists the farm's machines, names the node running a job and the one it was pinned to", async () => {
    const s = seed();
    const n1 = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a41";
    const n2 = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a42";
    s.db.run("UPDATE studio_farm_jobs SET requirements = ? WHERE farm_job_id = 'f-final'", [JSON.stringify({ nvenc: true, node_id: n2 })]);
    const machine = (id: string, name: string) => ({ id, name, online: true, kinds: ["studio.render_final" as const], gpus: [], running_jobs: 0, last_seen_at: null });
    const f = farm({ "f-final": { status: "leased" } });
    const withNodes: QueueFarm = { listJobs: async (q) => ({ ...(await f.listJobs(q)), jobs: (await f.listJobs(q)).jobs.map((j) => ({ ...j, node_id: n2 })) }),
      listNodes: async () => ({ nodes: [machine(n1, "render-01"), machine(n2, "render-02")] }) };
    const q = await studioQueue(s.core, s.db, withNodes, { userId: "auth0|owner", isAdmin: false, now: NOW, claudeMax: 20 });
    expect(q.machines?.map((m) => m.name)).toEqual(["render-01", "render-02"]);
    expect(q.renders[0]).toMatchObject({ farmJobId: "f-final", machine: "nvenc", node: { id: n2, name: "render-02" }, pinned: { id: n2, name: "render-02" } });
    // a hub that lists no machines: none shown, jobs still listed
    expect((await studioQueue(s.core, s.db, f, { userId: "auth0|owner", isAdmin: false, now: NOW, claudeMax: 20 })).machines).toBeNull();
  });

  it("an admin sees every job; pages of the farm are followed", async () => {
    const s = seed();
    const f = farm({ "f-final": { status: "leased" }, "f-preview": { status: "queued" }, "f-other": { status: "paused" } }, 2);
    const q = await studioQueue(s.core, s.db, f, { userId: "auth0|admin", isAdmin: true, now: NOW, claudeMax: 20 });
    expect(q.renders.map((r) => r.farmJobId).sort()).toEqual(["f-final", "f-other", "f-preview"]);
    expect(q.hiddenRenders).toBe(0);
    expect(f.calls).toHaveLength(2);
  });

  it("the farm out of reach is said, not thrown", async () => {
    const s = seed();
    const q = await studioQueue(s.core, s.db, { async listJobs() { throw new Error("connect ECONNREFUSED 127.0.0.1:3010"); } },
      { userId: "auth0|owner", isAdmin: false, now: NOW, claudeMax: 20 });
    expect(q.renders).toEqual([]);
    expect(q.farm).toEqual({ ok: false, error: "connect ECONNREFUSED 127.0.0.1:3010" });
  });

  it("lists the Claude calls: replies running and waiting, stages running; others' only counted", async () => {
    const s = seed();
    const gate = { productionId: s.mine, episodeId: null, runId: "run-p", stageKey: "approve-rnd", scope: "gate" as const };
    const a = insertUserTurn(s.db, gate, { text: "Gộp tập 3 và 4", createdBy: "auth0|owner" }, "2026-10-06T10:29:00.000Z");
    const b = insertUserTurn(s.db, { ...gate, productionId: OTHER, runId: "run-q" }, { text: "Ngắn hơn", createdBy: "auth0|x" }, "2026-10-06T10:29:30.000Z");
    expect(acquireChatSlot(s.db, a.assistant!.id, 1, NOW)).toBe(true);
    expect(acquireChatSlot(s.db, b.assistant!.id, 1, NOW)).toBe(false);
    s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["kyoto"]), s.mine]);
    const { runId } = startPlanRun(s.core, s.db, s.mine);
    const stage = s.core.store.listStageRuns(runId)[0]!;
    s.db.run(LEASE, [stage.stage_run_id, "attempt_x", "worker#1", "2026-10-06T11:00:00.000Z", '["claude"]']);
    s.db.run(LEASE, ["stage_run_farm", "attempt_y", "worker#2", "2026-10-06T11:00:00.000Z", '["farm"]']);
    const q = await studioQueue(s.core, s.db, farm({}), { userId: "auth0|owner", isAdmin: false, now: NOW, claudeMax: 20 });
    expect(q.claude).toMatchObject({ running: 2, waiting: 1, max: 20, hidden: 1 });
    const prod = { productionId: s.mine, productionTitle: "Series Kyoto", episodeId: null, episodeIdx: null, episodeTitle: null };
    expect(q.claude.items).toEqual([
      { source: "chat", waiting: false, ...prod, step: "approve-rnd", since: "2026-10-06T10:29:00.000Z" },
      { source: "stage", waiting: false, ...prod, step: stage.stage_key, since: null },
    ]);
  });
});

describe("cachedQueueFarm", () => {
  it("asks the farm once per query within the time to live, then again", async () => {
    let t = 0;
    let calls = 0;
    const f = cachedQueueFarm({ async listJobs() { calls += 1; return { jobs: [], next_cursor: null }; } }, 3000, () => t);
    await f.listJobs({ status: "queued" });
    await f.listJobs({ status: "queued" });
    expect(calls).toBe(1);
    await f.listJobs({ status: "queued", after: "x" });
    expect(calls).toBe(2);
    t = 3001;
    await f.listJobs({ status: "queued" });
    expect(calls).toBe(3);
  });

  it("does not keep a failure", async () => {
    let fail = true;
    const f = cachedQueueFarm({ async listJobs() { if (fail) throw new Error("down"); return { jobs: [], next_cursor: null }; } }, 3000, () => 0);
    await expect(f.listJobs({})).rejects.toThrow("down");
    fail = false;
    await expect(f.listJobs({})).resolves.toEqual({ jobs: [], next_cursor: null });
  });
});
