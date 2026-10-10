import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentToolList, agentTools, callAgentTool, createProject, createThread, finishTurn, listFileVersions, listThreads, listVideos, markAgentTurnRunning,
  mcpToolNames, postUserMessage, seedWorkspace, type AgentToolContext,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

function setup(role: AgentToolContext["role"] = "editor") {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", channelUrl: "@dlc", description: "Đi bộ", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "tools-")), project, NOW);
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, NOW);
  const { turn } = postUserMessage(w.db, { threadId: thread.id, text: "Tạo 2 video", actor: { id: "u", role } }, NOW);
  markAgentTurnRunning(w.db, turn!.id, NOW);
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
      "project_info", "video_list", "video_create", "video_update", "suggest_replies", "playbook_status", "validate_file", "thread_history",
      "inputs_list", "footage_search", "inputs_add", "inputs_prepare", "input_describe", "job_status", "job_cancel",
    ]);
    expect(list.find((t) => t.name === "video_create")!.inputSchema).toMatchObject({ type: "object", required: ["title"], additionalProperties: false });
    expect(list.every((t) => !("$schema" in t.inputSchema))).toBe(true);
    expect(mcpToolNames(agentTools())[0]).toBe("mcp__studio__project_info");
  });

  it("project_info tells the agent about the channel and its videos", async () => {
    const { ctx, tools } = setup();
    const out = JSON.parse((await callAgentTool(tools, ctx, "project_info", {})).text) as { project: { name: string; channelUrl: string }; videos: unknown[] };
    expect(out.project).toMatchObject({ name: "Du lịch chậm", channelUrl: "@dlc" });
    expect(out.videos).toEqual([]);
  });

  it("video_create makes the video, its folder, its thread and the brief written by the agent", async () => {
    const { db, ctx, tools, dir, project } = setup();
    const out = await callAgentTool(tools, ctx, "video_create", { title: "Hội An đêm", brief: "Đi bộ phố đèn lồng, 6 phút." });
    expect(out.isError).toBeUndefined();
    const v = listVideos(db, project.id)[0]!;
    expect(v).toMatchObject({ title: "Hội An đêm", idx: 1 });
    expect(readFileSync(join(dir, "videos", v.id, "brief.md"), "utf8")).toContain("Đi bộ phố đèn lồng");
    expect(listFileVersions(db, project.id, `videos/${v.id}/brief.md`)[0]).toMatchObject({ author_kind: "agent", message_id: ctx.message.id });
    expect(listThreads(db, project.id, { videoId: v.id }).map((t) => t.kind)).toEqual(["video"]);
  });

  it("refuses what the person's role does not allow, bad input, unknown tools and other projects' videos", async () => {
    const { db, ctx, tools } = setup("viewer");
    expect(await callAgentTool(tools, ctx, "video_create", { title: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("cần vai editor") });
    const editor = { ...ctx, role: "editor" as const };
    expect(await callAgentTool(tools, editor, "video_create", { title: "" })).toMatchObject({ isError: true, text: expect.stringContaining("Tham số sai") });
    expect(await callAgentTool(tools, editor, "nope", {})).toMatchObject({ isError: true });
    expect(await callAgentTool(tools, editor, "video_update", { title: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("video_id") });
    const other = createProject(db, "team-1", { name: "B", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const created = await callAgentTool(tools, { ...editor, project: other, workspaceDir: ctx.workspaceDir }, "video_create", { title: "khác" });
    const foreignId = (JSON.parse(created.text) as { id: string }).id;
    expect(await callAgentTool(tools, editor, "video_update", { video_id: foreignId, title: "x" })).toMatchObject({ isError: true, text: "video thuộc dự án khác" });
  });

  it("thread_history lists the project's threads and reads one", async () => {
    const { db, ctx, tools, project, thread } = setup();
    finishTurn(db, ctx.message.id, { status: "done", text: "Đã tạo 2 video.", parts: [{ kind: "text", text: "Đã tạo 2 video." }] }, NOW);
    const other = createThread(db, { projectId: project.id, kind: "project", title: "Ý tưởng", createdBy: "u" }, NOW);
    const list = JSON.parse((await callAgentTool(tools, ctx, "thread_history", {})).text) as { id: string }[];
    expect(list.map((t) => t.id).sort()).toEqual([thread.id, other.id].sort());
    const md = (await callAgentTool(tools, ctx, "thread_history", { thread_id: thread.id })).text;
    expect(md).toContain("# Luồng chat: Kênh");
    expect(md).toContain("Tạo 2 video");
    expect(md).toContain("Đã tạo 2 video.");
    expect((await callAgentTool(tools, ctx, "thread_history", { thread_id: thread.id, query: "zzz" })).text).not.toContain("Tạo 2 video");
  });
});
