import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentToolList, agentTools, callAgentTool, createProject, createThread, createVideo, finishTurn, listFileVersions, listMessages, listThreads, listVideos, markAgentTurnRunning,
  mcpToolNames, postUserMessage, seedWorkspace, type AgentToolContext, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup(role: AgentToolContext["role"] = "editor") {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", channelUrl: "@dlc", description: "Đi bộ", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "tools-")), project, NOW);
  const thread = await createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, NOW);
  const { turn } = await postUserMessage(w.db, { threadId: thread.id, text: "Tạo 2 video", actor: { id: "u", role } }, NOW);
  await markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: null, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video: null, workspaceDir: dir, role, now: () => NOW,
  };
  return { ...w, project, dir, thread, ctx, tools: agentTools() };
}

describe("agent tools", () => {
  it("lists each tool with an object JSON schema, and their MCP names", () => {
    const list = agentToolList(agentTools());
    expect(list.map((t) => t.name)).toEqual([
      "project_info", "video_list", "video_create", "video_focus", "video_update", "suggest_replies", "playbook_status", "validate_file", "thread_history",
      "inputs_list", "footage_search", "inputs_add", "inputs_prepare", "input_describe", "job_status", "job_cancel",
      "youtube_trending", "youtube_search", "youtube_top_channels", "youtube_channel_top_videos", "style_from_files",
      "timeline_from_edit_plan", "timeline_get", "timeline_apply_ops", "render_preview", "thumbnail_make", "render_frames", "music_list", "music_set", "propose_action",
    ]);
    expect(list.find((t) => t.name === "video_create")!.inputSchema).toMatchObject({ type: "object", required: ["title"], additionalProperties: false });
    expect(list.every((t) => !("$schema" in t.inputSchema))).toBe(true);
    expect(mcpToolNames(agentTools())[0]).toBe("mcp__studio__project_info");
  });

  it("names the footage library as ag-go calls itself in every description, AG Go by default", () => {
    const named = agentToolList(agentTools(), { siteName: "Kho Footage" });
    expect(named.filter((t) => /ag-go|\{\{site\}\}/i.test(t.description)).map((t) => t.name)).toEqual([]);
    expect(named.find((t) => t.name === "footage_search")!.description).toContain("các project Kho Footage của dự án");
    expect(agentToolList(agentTools()).find((t) => t.name === "inputs_add")!.description).toContain("Thêm video AG Go");
  });

  it("project_info tells the agent about the channel and its videos", async () => {
    const { ctx, tools } = await setup();
    const out = JSON.parse((await callAgentTool(tools, ctx, "project_info", {})).text) as { project: { name: string; channelUrl: string }; videos: unknown[] };
    expect(out.project).toMatchObject({ name: "Du lịch chậm", channelUrl: "@dlc" });
    expect(out.videos).toEqual([]);
  });

  it("video_create makes the video, its folder, its thread and the brief written by the agent", async () => {
    const { db, ctx, tools, dir, project } = await setup();
    const out = await callAgentTool(tools, ctx, "video_create", { title: "Hội An đêm", brief: "Đi bộ phố đèn lồng, 6 phút." });
    expect(out.isError).toBeUndefined();
    const v = (await listVideos(db, project.id))[0]!;
    expect(v).toMatchObject({ title: "Hội An đêm", idx: 1 });
    expect(readFileSync(join(dir, "videos", v.id, "brief.md"), "utf8")).toContain("Đi bộ phố đèn lồng");
    expect((await listFileVersions(db, project.id, `videos/${v.id}/brief.md`))[0]).toMatchObject({ author_kind: "agent", message_id: ctx.message.id });
    expect((await listThreads(db, project.id, { videoId: v.id })).map((t) => t.kind)).toEqual(["video"]);
  });

  it("video_create with start hands the work to the video's thread: a note its agent acts on, for this turn's person", async () => {
    const { db, ctx, tools, project } = await setup();
    const out = JSON.parse((await callAgentTool(tools, ctx, "video_create", { title: "Hội An đêm", start: "Viết brief: đi bộ phố đèn lồng, 6 phút." })).text) as {
      handoff: { video_id: string; video_idx: number; thread_id: string }; next: string;
    };
    const v = (await listVideos(db, project.id))[0]!;
    expect(out.handoff).toMatchObject({ video_id: v.id, video_idx: 1, video_title: "Hội An đêm" });
    expect(out.next).toContain("dừng lượt này");
    const [thread] = await listThreads(db, project.id, { videoId: v.id });
    expect(out.handoff.thread_id).toBe(thread!.id);
    const [note, turn] = await listMessages(db, thread!.id);
    expect(note).toMatchObject({ role: "system", trigger: "system" });
    expect(note!.text).toContain('Chuyển từ luồng "Kênh"');
    expect(note!.text).toContain("phố đèn lồng");
    expect(turn).toMatchObject({ role: "assistant", status: "pending", created_by: "u", actor_role: "editor" });
    // several ideas at once: no start, no hand-over
    expect(JSON.parse((await callAgentTool(tools, ctx, "video_create", { title: "Huế mưa" })).text)).not.toHaveProperty("handoff");
  });

  it("video_focus hands an existing video's work over; its own work is refused from another thread", async () => {
    const { db, ctx, tools, project } = await setup();
    const v = await createVideo(db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
    const refused = await callAgentTool(tools, ctx, "inputs_add", { video_id: v.id, assets: [{ asset_id: "01a0d24a-02ae-700f-be7f-03bfd7207592", name: "Bến thuyền" }] });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("video_focus") });
    expect(await callAgentTool(tools, ctx, "timeline_apply_ops", { video_id: v.id, base_revision: 1, ops: [{ op: "setLook", look: "warm" }] })).toMatchObject({ isError: true, text: expect.stringContaining("luồng chat của video đó") });
    const out = JSON.parse((await callAgentTool(tools, ctx, "video_focus", { video_id: v.id, message: "Chọn cảnh từ footage Hoa Lư." })).text) as { handoff: { thread_id: string } };
    const [note] = await listMessages(db, out.handoff.thread_id);
    expect(note!.text).toContain("Chọn cảnh từ footage Hoa Lư.");
    // in the video's own thread there is nothing to hand over
    const own = { ...ctx, video: v };
    expect(await callAgentTool(tools, own, "video_focus", { video_id: v.id, message: "x" })).toMatchObject({ isError: true });
  });

  it("refuses what the person's role does not allow, bad input, unknown tools and other projects' videos", async () => {
    const { db, ctx, tools } = await setup("viewer");
    expect(await callAgentTool(tools, ctx, "video_create", { title: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
    const editor = { ...ctx, role: "editor" as const };
    expect(await callAgentTool(tools, editor, "video_create", { title: "" })).toMatchObject({ isError: true, text: expect.stringContaining("Tham số sai") });
    expect(await callAgentTool(tools, editor, "nope", {})).toMatchObject({ isError: true });
    expect(await callAgentTool(tools, editor, "video_update", { title: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("video_id") });
    const other = await createProject(db, "team-1", { name: "B", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const created = await callAgentTool(tools, { ...editor, project: other, workspaceDir: ctx.workspaceDir }, "video_create", { title: "khác" });
    const foreignId = (JSON.parse(created.text) as { id: string }).id;
    expect(await callAgentTool(tools, editor, "video_update", { video_id: foreignId, title: "x" })).toMatchObject({ isError: true, text: "video thuộc dự án khác" });
  });

  it("thread_history lists the project's threads and reads one", async () => {
    const { db, ctx, tools, project, thread } = await setup();
    await finishTurn(db, ctx.message.id, { status: "done", text: "Đã tạo 2 video.", parts: [{ kind: "text", text: "Đã tạo 2 video." }] }, NOW);
    const other = await createThread(db, { projectId: project.id, kind: "project", title: "Ý tưởng", createdBy: "u" }, NOW);
    const list = JSON.parse((await callAgentTool(tools, ctx, "thread_history", {})).text) as { id: string }[];
    expect(list.map((t) => t.id).sort()).toEqual([thread.id, other.id].sort());
    const md = (await callAgentTool(tools, ctx, "thread_history", { thread_id: thread.id })).text;
    expect(md).toContain("# Luồng chat: Kênh");
    expect(md).toContain("Tạo 2 video");
    expect(md).toContain("Đã tạo 2 video.");
    expect((await callAgentTool(tools, ctx, "thread_history", { thread_id: thread.id, query: "zzz" })).text).not.toContain("Tạo 2 video");
  });
});
