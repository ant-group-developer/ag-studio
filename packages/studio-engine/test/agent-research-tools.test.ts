import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTools, callAgentTool, createJobRunner, createProject, createThread, getJob, listJobs, markAgentTurnRunning, postUserMessage, researchHandler,
  seedWorkspace, studioLogger, YoutubeCrawler, ytDlp, type AgentToolContext,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const ROOT = resolve(__dirname, "..", "..", "..");

function setup(role: AgentToolContext["role"] = "editor") {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = mkdtempSync(join(tmpdir(), "research-tools-"));
  const dir = seedWorkspace(root, project, NOW);
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, NOW);
  const { turn } = postUserMessage(w.db, { threadId: thread.id, text: "Nghiên cứu", actor: { id: "u", role } }, NOW);
  markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: null, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video: null, workspaceDir: dir, role, now: () => NOW,
  };
  return { ...w, project, root, dir, thread, ctx, tools: agentTools() };
}

describe("research tools", () => {
  it("queue a crawl for the thread (the agent goes on when it ends) and answer at once when not waiting", async () => {
    const s = setup();
    const r = await callAgentTool(s.tools, s.ctx, "youtube_search", { q: "phố cổ", max: 20, wait_s: 0 });
    expect(JSON.parse(r.text)).toMatchObject({ status: "queued", note: expect.stringContaining("Studio báo vào luồng") });
    expect(listJobs(s.db, s.project.id)[0]).toMatchObject({
      kind: "research", title: 'Video xem nhiều: "phố cổ" (VN, 90 ngày)', thread_id: s.thread.id, continue_agent: 1, units: 20,
    });
  });

  it("refuse large crawls: a person runs those", async () => {
    const s = setup();
    const r = await callAgentTool(s.tools, s.ctx, "youtube_top_channels", { q: "du lịch", max: 25 });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("tab Nghiên cứu") });
    expect(listJobs(s.db, s.project.id)).toEqual([]);
    expect(await callAgentTool(s.tools, { ...s.ctx, role: "viewer" }, "youtube_trending", {})).toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
  });

  it("wait for the crawl and answer its first rows and file", async () => {
    const s = setup();
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
    expect(getJob(s.db, out.job_id)!.status).toBe("done");
  });
});
