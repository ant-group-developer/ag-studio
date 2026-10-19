import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  actionView, agentTools, callAgentTool, createProject, createThread, createVideo, decideAction, getAction, getJob, getVideo, listActions, listJobs,
  listMessages, markAgentTurnRunning, noteYoutubeBlocked, postUserMessage, proposeAction, saveVideoRevision, seedWorkspace, StudioRunError, type AgentToolContext, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const LATER = "2026-10-11T09:00:00.000Z";

function timeline(videoId: string, title = "Phố cổ"): TimelineV4 {
  return {
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [{ clip_id: "C001", asset_id: "a1", section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } }],
    texts: [{ text_id: "T001", kind: "title", text: title, start: 0, duration: 2, position: "top_left" }],
    narration: { voice: "none", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" }, music: null, source_audio: { muted: false },
    assets: { a1: { title: "Phố", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [],
  };
}

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup() {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "actions-")), project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const thread = await createThread(w.db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW);
  const { turn } = await postUserMessage(w.db, { threadId: thread.id, text: "Render đi", actor: { id: "u", role: "editor" } }, NOW);
  await markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: video.id, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video, workspaceDir: dir, role: "editor", now: () => NOW,
  };
  return { ...w, project, video, thread, turn: turn!, ctx };
}

const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof StudioRunError ? (e.details as { code?: string }).code ?? e.code : String(e); } return null; };

describe("actions a person confirms", () => {
  it("a final render needs a timeline, and is tied to its revision", async () => {
    const s = await setup();
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final" as const, title: "Render bản cuối", summary: "Timeline đã duyệt", createdBy: "u" };
    expect(await codeOf(proposeAction(s.db, { ...base, params: { video_id: s.video.id } }, NOW))).toBe("no_timeline");
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const a = await proposeAction(s.db, { ...base, params: { video_id: s.video.id } }, NOW);
    expect(actionView(a)).toMatchObject({ kind: "render_final", status: "proposed", revision: 1, needs: "producer", params: { video_id: s.video.id, revision: 1 }, expiresAt: "2026-10-11T08:00:00.000Z" });
    expect(await codeOf(proposeAction(s.db, { ...base, params: { video_id: "nope" } }, NOW))).toBe("no_video");
    expect(await codeOf(proposeAction(s.db, { ...base, params: { video_id: s.video.id, extra: 1 } }, NOW))).toBe("bad_params");
  });

  it("confirming needs the role; confirmed, the job is queued for the thread and the thread hears who decided", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const a = await proposeAction(s.db, { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final", title: "Render bản cuối", summary: "…", params: { video_id: s.video.id }, createdBy: "u" }, NOW);
    expect(await codeOf(decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "e", role: "editor" }, NOW))).toBe("role");
    const done = await decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "producer" }, NOW);
    expect(done).toMatchObject({ status: "confirmed", decided_by: "p" });
    expect(await getJob(s.db, done.job_id!)).toMatchObject({ kind: "render_final", video_id: s.video.id, thread_id: s.thread.id, continue_agent: true, actor_role: "producer" });
    expect((await getJob(s.db, done.job_id!))!.request).toEqual({ video_id: s.video.id, revision: 1, action_id: a.id });
    expect((await listMessages(s.db, s.thread.id)).at(-1)).toMatchObject({ role: "system", trigger: "action", text: expect.stringContaining("xác nhận") });
    expect(await codeOf(decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "producer" }, NOW))).toBe("decided");
  });

  it("a final render card can ask for 4K and its job keeps it; no other resolution", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final" as const, title: "Render bản cuối 4K", summary: "…", createdBy: "u" };
    expect(await codeOf(proposeAction(s.db, { ...base, params: { video_id: s.video.id, resolution: "8k" } }, NOW))).toBe("bad_params");
    const a = await proposeAction(s.db, { ...base, params: { video_id: s.video.id, resolution: "4k" } }, NOW);
    const done = await decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "producer" }, NOW);
    expect((await getJob(s.db, done.job_id!))!.request).toMatchObject({ resolution: "4k" });
  });

  it("two people confirming the same card at once: it runs once", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const a = await proposeAction(s.db, { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final", title: "Render bản cuối", summary: "…", params: { video_id: s.video.id }, createdBy: "u" }, NOW);
    const codes = await Promise.all(["p", "q"].map((userId) => codeOf(decideAction(s.db, { actionId: a.id, decision: "confirm", userId, role: "producer" }, NOW))));
    expect(codes.sort()).toEqual(["decided", null].sort());
    expect(await listJobs(s.db, s.project.id)).toHaveLength(1);
    expect((await listMessages(s.db, s.thread.id)).filter((m) => m.trigger === "action")).toHaveLength(1);
  });

  it("a card whose timeline changed, or older than a day, expires", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "export_premiere" as const, title: "Xuất Premiere", summary: "…", params: { video_id: s.video.id }, createdBy: "u" };
    const a = await proposeAction(s.db, base, NOW);
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 1, data: timeline(s.video.id, "Đổi"), authorId: "u" });
    expect(await codeOf(decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "owner" }, NOW))).toBe("expired");
    expect(await getAction(s.db, a.id)).toMatchObject({ status: "expired", error: expect.stringContaining("timeline đã đổi") });
    const b = await proposeAction(s.db, base, NOW);
    expect(await codeOf(decideAction(s.db, { actionId: b.id, decision: "confirm", userId: "p", role: "owner" }, LATER))).toBe("expired");
  });

  it("a confirmed card whose work fails is marked failed, and the thread hears nothing", async () => {
    const s = await setup();
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, summary: "…", createdBy: "u" };
    const crawl = await proposeAction(s.db, { ...base, kind: "crawl_large", title: "Crawl 150 video", params: { crawl: { kind: "topic", q: "phố cổ", max: 150 } } }, NOW);
    await s.db.run("UPDATE agent_actions SET params = ? WHERE id = ?", [JSON.stringify({ crawl: { kind: "nope" } }), crawl.id]);
    expect(await codeOf(decideAction(s.db, { actionId: crawl.id, decision: "confirm", userId: "e", role: "editor" }, NOW))).not.toBeNull();
    expect(await getAction(s.db, crawl.id)).toMatchObject({ status: "failed", decided_by: "e", error: expect.any(String) });
    expect(await listJobs(s.db, s.project.id)).toEqual([]);
    expect((await listMessages(s.db, s.thread.id)).filter((m) => m.trigger === "action")).toHaveLength(0);
  });

  it("a large crawl runs as research; deleting archives the video; rejecting says so", async () => {
    const s = await setup();
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, summary: "…", createdBy: "u" };
    const crawl = await proposeAction(s.db, { ...base, kind: "crawl_large", title: "Crawl 150 video", params: { crawl: { kind: "topic", q: "phố cổ", max: 150 } } }, NOW);
    const c = await decideAction(s.db, { actionId: crawl.id, decision: "confirm", userId: "e", role: "editor" }, NOW);
    expect(await getJob(s.db, c.job_id!)).toMatchObject({ kind: "research", units: 150, continue_agent: true });
    const del = await proposeAction(s.db, { ...base, kind: "delete_video", title: "Xoá video", params: { video_id: s.video.id } }, NOW);
    await decideAction(s.db, { actionId: del.id, decision: "confirm", userId: "p", role: "producer" }, NOW);
    expect((await getVideo(s.db, s.video.id))!.archived_at).toBe(NOW);
    const ref = await proposeAction(s.db, { ...base, kind: "reference_download", title: "Tải 2 video mẫu", params: { video_ids: ["dQw4w9WgXcQ", "U_17EqTHUIo"], purpose: "nhịp dựng" } }, NOW);
    expect(await decideAction(s.db, { actionId: ref.id, decision: "reject", userId: "e", role: "editor" }, NOW)).toMatchObject({ status: "rejected", job_id: null });
    expect((await listMessages(s.db, s.thread.id)).at(-1)!.text).toContain("từ chối");
    expect((await listJobs(s.db, s.project.id)).map((j) => j.kind)).toEqual(["research"]);
    expect(await listActions(s.db, { threadId: s.thread.id, open: true })).toEqual([]);
  });

  it("propose_action: the agent's card defaults to the thread's video", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const r = await callAgentTool(agentTools(), s.ctx, "propose_action", { kind: "render_final", title: "Render bản cuối 1080p", why: "Bản xem trước đã ổn" });
    expect(r.text).toContain("cần vai producer");
    expect((await listActions(s.db, { threadId: s.thread.id }))[0]).toMatchObject({ kind: "render_final", video_id: s.video.id, message_id: s.turn.id, revision: 1 });
  });

  it("propose_action: no reference download card while YouTube blocks the server; it says what to offer instead", async () => {
    const s = await setup();
    const ask = { kind: "reference_download", title: "Tải 2 video mẫu", why: "đo nhịp dựng", params: { video_ids: ["U_17EqTHUIo", "U_17EqTHUIp"], purpose: "nhịp dựng" } };
    await noteYoutubeBlocked(s.db, NOW);
    const r = await callAgentTool(agentTools(), s.ctx, "propose_action", ask);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Chưa tạo thẻ: YouTube đang chặn tải từ máy chủ Studio/);
    expect(r.text).toContain("tả phong cách dựng bằng lời");
    expect(await listActions(s.db, { threadId: s.thread.id })).toHaveLength(0);
    // other cards are not affected; past its 6 hours the block is forgotten
    s.ctx.now = () => "2026-10-10T14:00:01.000Z";
    expect((await callAgentTool(agentTools(), s.ctx, "propose_action", ask)).isError).toBeFalsy();
    expect(await listActions(s.db, { threadId: s.thread.id })).toHaveLength(1);
  });

  it("YouTube blocking the server but a farm machine can fetch: the card is allowed again (through the farm); not when the farm is blocked too", async () => {
    const s = await setup();
    let fetchers: string[] = [];
    s.ctx.referenceFetchers = async () => fetchers;
    const ask = { kind: "reference_download", title: "Tải video mẫu", why: "đo nhịp dựng", params: { video_ids: ["U_17EqTHUIo"], purpose: "nhịp dựng" } };
    await noteYoutubeBlocked(s.db, NOW);
    const refused = await callAgentTool(agentTools(), s.ctx, "propose_action", ask);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("không máy farm nào tải thay được");
    fetchers = ["PC-01"];
    const ok = await callAgentTool(agentTools(), s.ctx, "propose_action", ask);
    expect(ok.isError).toBeFalsy();
    expect(ok.text).toContain("Video mẫu sẽ tải qua máy farm (PC-01)");
    expect(await listActions(s.db, { threadId: s.thread.id })).toHaveLength(1);
    await noteYoutubeBlocked(s.db, NOW, "farm");
    const both = await callAgentTool(agentTools(), s.ctx, "propose_action", ask);
    expect(both.isError).toBe(true);
    expect(both.text).toContain("và cả các máy farm");
  });
});
