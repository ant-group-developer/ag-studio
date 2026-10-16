import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSource, agentTools, callAgentTool, claimJob, createProject, createThread, createVideo, finishJob, getJob, getPrepared, listJobs, listSources, markAgentTurnRunning,
  nameUnnamedAssets, queuePrepare, unnamedAssetIds,
  postUserMessage, savePrepared, seedWorkspace, type AgentToolContext, type ProjectFootage, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const A1 = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const A2 = "1c8b6d45-6e2f-4e5d-8b62-4e3b2f1d8e22";

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup(role: AgentToolContext["role"] = "editor") {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "input-tools-")), project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const thread = await createThread(w.db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW);
  const { turn } = await postUserMessage(w.db, { threadId: thread.id, text: "Chọn video", actor: { id: "u", role } }, NOW);
  await markAgentTurnRunning(w.db, turn!.id, NOW);
  const searches: unknown[] = [];
  const footage: ProjectFootage = {
    search: async (actAs, q) => {
      searches.push([actAs, q]);
      return { items: [{ assetId: A1, name: "Hoa Lư 03.mp4", durationMs: 72_400, width: 1920, height: 1080, hasSpeech: true, projectNames: ["Ninh Bình"], summaryVi: "Thuyền trên sông" }], nextCursor: null, total: 1 };
    },
    check: async (_actAs, ids) => ({ ok: ids.filter((i) => i !== A2), missing: ids.filter((i) => i === A2) }),
  };
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: video.id, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video, workspaceDir: dir, role, now: () => NOW, footage,
  };
  return { ...w, project, video, dir, thread, ctx, tools: agentTools(), searches };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (s: Awaited<ReturnType<typeof setup>>, name: string, args: unknown, ctx = s.ctx) => {
  const r = await callAgentTool(s.tools, ctx, name, args);
  let json: any = null;
  try { json = r.isError ? null : JSON.parse(r.text); } catch { /* a plain sentence */ }
  return { ...r, json };
};

describe("input tools", () => {
  it("answers in the footage library's own name", async () => {
    const s = await setup();
    const named = { ...s.ctx, siteName: "Kho Footage" };
    expect(await call(s, "footage_search", {}, named)).toMatchObject({ isError: true, text: expect.stringContaining("chưa có project Kho Footage") });
    expect(await call(s, "footage_search", {}, { ...named, footage: undefined })).toMatchObject({ isError: true, text: expect.stringContaining("chưa nối Kho Footage") });
  });

  it("footage_search looks only in the project's ag-go projects, as the owner, with each video's preparation", async () => {
    const s = await setup();
    expect(await call(s, "footage_search", {})).toMatchObject({ isError: true, text: expect.stringContaining("chưa có project AG Go") });
    await addSource(s.db, { projectId: s.project.id, kind: "ag_go_project", ref: "agp-1", mediaType: "mixed", label: "Ninh Bình", addedBy: "u" }, NOW);
    const r = await call(s, "footage_search", { q: "thuyền" });
    expect(s.searches).toEqual([["auth0|owner", { projectIds: ["agp-1"], q: "thuyền", limit: 30 }]]);
    expect(r.json.items).toEqual([{ asset_id: A1, name: "Hoa Lư 03.mp4", duration_s: 72.4, size: "1920x1080", has_speech: true, projects: ["Ninh Bình"], summary: "Thuyền trên sông", prepared: "not_prepared" }]);
    expect(await call(s, "footage_search", { ag_go_project_id: "agp-x" })).toMatchObject({ isError: true });
  });

  it("inputs_add adds usable videos to this thread's video in order and writes its index; refuses what the owner cannot use", async () => {
    const s = await setup();
    expect(await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }, { asset_id: A2, name: "Tam Cốc.mp4" }] })).toMatchObject({ isError: true, text: expect.stringContaining(A2) });
    const r = await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] });
    expect(r.json).toMatchObject({ video_id: s.video.id, sources: [{ index: 0, asset_id: A1, name: "Hoa Lư 03.mp4", status: "missing" }] });
    expect(existsSync(join(s.dir, "videos", s.video.id, "sources", "index.json"))).toBe(true);
    const list = await call(s, "inputs_list", {});
    expect(list.json.video.sources).toEqual([expect.objectContaining({ kind: "ag_go_asset", ref: A1, label: "Hoa Lư 03.mp4", state: "not_prepared" })]);
    const viewer = await setup("viewer");
    expect(await call(viewer, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] })).toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
  });

  it("inputs_add needs each video's name: people read it, not the asset id", async () => {
    const s = await setup();
    expect(await call(s, "inputs_add", { assets: [{ asset_id: A1 }] })).toMatchObject({ isError: true, text: expect.stringContaining("name") });
    expect(await listSources(s.db, s.project.id)).toEqual([]);
  });

  it("names videos added without a name: their sources, prepare jobs, prepared row and video index", async () => {
    const s = await setup();
    await addSource(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: A1, addedBy: "u" }, NOW);
    await addSource(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "ag_go_asset", ref: A2, mediaType: "video", label: "Tam Cốc.mp4", addedBy: "u" }, NOW);
    await queuePrepare(s.db, { projectId: s.project.id, assetIds: [A1], createdBy: "u" }, NOW);
    await savePrepared(s.db, { project_id: s.project.id, asset_id: A1, status: "failed", name: A1, duration_s: null, width: null, height: null, has_audio: null, shots: null, transcript: false, source_kind: null, watermarked: null, error: "x" }, NOW);
    expect(await unnamedAssetIds(s.db, s.project.id)).toEqual([A1]);
    expect((await listJobs(s.db, s.project.id))[0]!.title).toBe(`Chuẩn bị ${A1}`);
    expect(await nameUnnamedAssets(s.db, s.dir, s.project.id, new Map([[A1, "Hoa Lư 03.mp4"], [A2, "khác"]]))).toEqual([A1]);
    expect((await listSources(s.db, s.project.id)).map((x) => x.label).sort()).toEqual(["Hoa Lư 03.mp4", "Tam Cốc.mp4"]);
    const job = (await listJobs(s.db, s.project.id))[0]!;
    expect([job.title, (job.request as { name: string }).name]).toEqual(["Chuẩn bị Hoa Lư 03.mp4", "Hoa Lư 03.mp4"]);
    expect((await getPrepared(s.db, s.project.id, A1))?.name).toBe("Hoa Lư 03.mp4");
    expect(readFileSync(join(s.dir, "videos", s.video.id, "sources", "index.json"), "utf8")).toContain("Hoa Lư 03.mp4");
    expect(await unnamedAssetIds(s.db, s.project.id)).toEqual([]);
  });

  it("inputs_prepare queues one job per video not yet prepared (the agent goes on when it ends), reuses running and ready ones", async () => {
    const s = await setup();
    await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] });
    expect((await call(s, "inputs_prepare", { asset_ids: [A2] })).json.assets[A2]).toMatchObject({ state: "not_an_input" });
    const first = await call(s, "inputs_prepare", { asset_ids: [A1] });
    const jobId = first.json.assets[A1].job_id as string;
    expect(first.json).toMatchObject({ assets: { [A1]: { state: "queued", job_id: jobId } }, note: expect.stringContaining("Còn 1 việc") });
    expect(await getJob(s.db, jobId)).toMatchObject({ kind: "prepare_asset", title: "Chuẩn bị Hoa Lư 03.mp4", thread_id: s.thread.id, video_id: s.video.id, continue_agent: true, actor_role: "editor" });
    expect((await call(s, "inputs_prepare", { asset_ids: [A1] })).json.assets[A1]).toMatchObject({ state: "queued", job_id: jobId });
    expect(await listJobs(s.db, s.project.id)).toHaveLength(1);
    await claimJob(s.db, ["prepare_asset"], NOW);
    await finishJob(s.db, jobId, { status: "done" }, NOW);
    await savePrepared(s.db, { project_id: s.project.id, asset_id: A1, status: "ready", name: "Hoa Lư 03.mp4", duration_s: 72.4, width: 854, height: 480, has_audio: true, shots: 12, transcript: true, source_kind: "preview", watermarked: false, error: null }, NOW);
    expect((await call(s, "inputs_prepare", { asset_ids: [A1] })).json.assets[A1]).toMatchObject({ state: "ready", shots: 12, readme: `inputs/${A1}/README.md` });
    expect((await call(s, "input_describe", { asset_id: A1 })).json).toMatchObject({ state: "ready", transcript: true });
  });

  it("inputs_prepare waits for the job when asked (up to wait_s)", async () => {
    const s = await setup();
    await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] });
    setTimeout(() => void (async () => {
      const j = (await listJobs(s.db, s.project.id))[0]!;
      await claimJob(s.db, ["prepare_asset"], NOW);
      await finishJob(s.db, j.id, { status: "done" }, NOW);
      await savePrepared(s.db, { project_id: s.project.id, asset_id: A1, status: "ready", name: "x", duration_s: 1, width: 1, height: 1, has_audio: false, shots: 1, transcript: false, source_kind: "preview", watermarked: false, error: null }, NOW);
    })(), 300);
    const r = await call(s, "inputs_prepare", { asset_ids: [A1], wait_s: 5 });
    expect(r.json).toEqual({ assets: { [A1]: expect.objectContaining({ state: "ready" }) } });
  });

  it("job_status shows running and recent jobs; job_cancel stops one of the project's", async () => {
    const s = await setup();
    await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] });
    const id = (await call(s, "inputs_prepare", { asset_ids: [A1] })).json.assets[A1].job_id as string;
    expect((await call(s, "job_status", {})).json.active).toEqual([expect.objectContaining({ id, kind: "prepare_asset", status: "queued" })]);
    expect(await call(s, "job_cancel", { job_id: id })).toMatchObject({ text: `Đã huỷ: Chuẩn bị Hoa Lư 03.mp4.` });
    expect((await call(s, "job_status", { job_id: id })).json).toMatchObject({ status: "cancelled" });
    expect(await call(s, "job_cancel", { job_id: "nope" })).toMatchObject({ isError: true });
    void readFileSync;
  });
});

describe("the prepare step of the playbook", () => {
  it("follows the video's ag-go videos: none picked, being prepared, all ready", async () => {
    const s = await setup();
    const prepare = async () => (await call(s, "playbook_status", {})).json.video.find((x: { key: string }) => x.key === "prepare");
    expect(await prepare()).toMatchObject({ status: "missing", detail: "chưa chọn video nguồn nào cho video này" });
    await call(s, "inputs_add", { assets: [{ asset_id: A1, name: "Hoa Lư 03.mp4" }] });
    const jobId = (await call(s, "inputs_prepare", { asset_ids: [A1] })).json.assets[A1].job_id as string;
    expect(await prepare()).toMatchObject({ status: "running", detail: "đang chuẩn bị (0/1 xong)" });
    await claimJob(s.db, ["prepare_asset"], NOW);
    await finishJob(s.db, jobId, { status: "done" }, NOW);
    await savePrepared(s.db, { project_id: s.project.id, asset_id: A1, status: "ready", name: "x", duration_s: 1, width: 1, height: 1, has_audio: false, shots: 7, transcript: false, source_kind: "preview", watermarked: false, error: null }, NOW);
    expect(await prepare()).toMatchObject({ status: "done", detail: "1 video, 7 cảnh" });
  });
});
