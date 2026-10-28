import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTools, callAgentTool, createJobRunner, createProject, createThread, getJob, listJobs, markAgentTurnRunning, postUserMessage, researchHandler,
  seedWorkspace, studioLogger, YoutubeCrawler, ytDlp, type AgentToolContext, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const ROOT = resolve(__dirname, "..", "..", "..");

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup(role: AgentToolContext["role"] = "editor") {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = mkdtempSync(join(tmpdir(), "research-tools-"));
  const dir = seedWorkspace(root, project, NOW);
  const thread = await createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, NOW);
  const { turn } = await postUserMessage(w.db, { threadId: thread.id, text: "Nghiên cứu", actor: { id: "u", role } }, NOW);
  await markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: null, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video: null, workspaceDir: dir, role, now: () => NOW,
  };
  return { ...w, project, root, dir, thread, ctx, tools: agentTools() };
}

describe("research tools", () => {
  it("queue a crawl for the thread (the agent goes on when it ends) and answer at once when not waiting", async () => {
    const s = await setup();
    const r = await callAgentTool(s.tools, s.ctx, "youtube_search", { q: "phố cổ", max: 20, wait_s: 0 });
    expect(JSON.parse(r.text)).toMatchObject({ status: "queued", note: expect.stringContaining("Studio báo vào luồng") });
    expect((await listJobs(s.db, s.project.id))[0]).toMatchObject({
      kind: "research", title: 'Video xem nhiều: "phố cổ" (VN, 90 ngày)', thread_id: s.thread.id, continue_agent: true, units: 20,
    });
  });

  it("refuse large crawls: a person runs those", async () => {
    const s = await setup();
    const r = await callAgentTool(s.tools, s.ctx, "youtube_top_channels", { q: "du lịch", max: 25 });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("\"Chạy nghiên cứu\" ở tab Tài liệu") });
    expect(await listJobs(s.db, s.project.id)).toEqual([]);
    expect(await callAgentTool(s.tools, { ...s.ctx, role: "viewer" }, "youtube_trending", {})).toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
  });

  it("wait for the crawl and answer its first rows and file", async () => {
    const s = await setup();
    const crawler = new YoutubeCrawler({ ytdlp: ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")] }) });
    const runner = createJobRunner({ db: s.db, logger: studioLogger({ test: "research-tools" }), workspacesRoot: s.root, dataRoot: join(s.dir, "..", "data"), handlers: { research: researchHandler({ db: s.db, crawler }) }, pollMs: 50 });
    const ac = new AbortController();
    const loop = runner.runForever(ac.signal);
    const r = await callAgentTool(s.tools, s.ctx, "youtube_channel_top_videos", { channel: "@kenhpho", max: 3, wait_s: 30 });
    ac.abort();
    await loop;
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ status: "done", source: "yt-dlp", file: expect.stringMatching(/^research\/\d{4}-\d{2}-\d{2}-kenh-kenhpho\.md$/) });
    expect(out.videos).toHaveLength(3);
    expect((await getJob(s.db, out.job_id))!.status).toBe("done");
  });

  it("style_from_files: queues style_watch on the uploaded videos at once (no card), refuses what is not an uploaded video", async () => {
    const s = await setup();
    mkdirSync(join(s.dir, "context", "references"), { recursive: true });
    writeFileSync(join(s.dir, "context", "references", "Kênh mẫu.mp4"), "video");
    writeFileSync(join(s.dir, "context", "notes.md"), "# x");
    const r = await callAgentTool(s.tools, s.ctx, "style_from_files", { paths: ["context/references/Kênh mẫu.mp4", "context/references/Kênh mẫu.mp4"], purpose: "nhịp dựng" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ status: "queued", files: ["context/references/Kênh mẫu.mp4"] });
    const job = (await listJobs(s.db, s.project.id))[0]!;
    expect(job).toMatchObject({ kind: "style_watch", thread_id: s.thread.id, continue_agent: true, title: "Học phong cách từ 1 video tải lên" });
    expect(job.request).toEqual({ files: ["context/references/Kênh mẫu.mp4"], purpose: "nhịp dựng" });
    for (const [path, why] of [["context/notes.md", "không phải video"], ["inputs/a/clip.mp4", "context/"], ["context/references/none.mp4", "không có file"], ["../x.mp4", ".."]] as const) {
      expect(await callAgentTool(s.tools, s.ctx, "style_from_files", { paths: [path], purpose: "x" })).toMatchObject({ isError: true, text: expect.stringContaining(why) });
    }
    expect(await listJobs(s.db, s.project.id)).toHaveLength(1);
    expect(await callAgentTool(s.tools, { ...s.ctx, role: "viewer" }, "style_from_files", { paths: ["context/references/Kênh mẫu.mp4"], purpose: "x" }))
      .toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
  });
});
