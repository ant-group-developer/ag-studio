import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  actionView, agentTools, callAgentTool, createProject, createThread, createVideo, decideAction, getAction, getJob, getVideo, listActions, listJobs,
  listMessages, markAgentTurnRunning, postUserMessage, proposeAction, saveVideoRevision, seedWorkspace, StudioRunError, type AgentToolContext,
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

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "actions-")), project, NOW);
  const video = createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const thread = createThread(w.db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW);
  const { turn } = postUserMessage(w.db, { threadId: thread.id, text: "Render đi", actor: { id: "u", role: "editor" } }, NOW);
  markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: video.id, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video, workspaceDir: dir, role: "editor", now: () => NOW,
  };
  return { ...w, project, video, thread, turn: turn!, ctx };
}

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof StudioRunError ? (e.details as { code?: string }).code ?? e.code : String(e); } return null; };

describe("actions a person confirms", () => {
  it("a final render needs a timeline, and is tied to its revision", () => {
    const s = setup();
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final" as const, title: "Render bản cuối", summary: "Timeline đã duyệt", createdBy: "u" };
    expect(codeOf(() => proposeAction(s.db, { ...base, params: { video_id: s.video.id } }, NOW))).toBe("no_timeline");
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const a = proposeAction(s.db, { ...base, params: { video_id: s.video.id } }, NOW);
    expect(actionView(a)).toMatchObject({ kind: "render_final", status: "proposed", revision: 1, needs: "producer", params: { video_id: s.video.id, revision: 1 }, expiresAt: "2026-10-11T08:00:00.000Z" });
    expect(codeOf(() => proposeAction(s.db, { ...base, params: { video_id: "nope" } }, NOW))).toBe("no_video");
    expect(codeOf(() => proposeAction(s.db, { ...base, params: { video_id: s.video.id, extra: 1 } }, NOW))).toBe("bad_params");
  });

  it("confirming needs the role; confirmed, the job is queued for the thread and the thread hears who decided", () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const a = proposeAction(s.db, { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "render_final", title: "Render bản cuối", summary: "…", params: { video_id: s.video.id }, createdBy: "u" }, NOW);
    expect(codeOf(() => decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "e", role: "editor" }, NOW))).toBe("role");
    const done = decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "producer" }, NOW);
    expect(done).toMatchObject({ status: "confirmed", decided_by: "p" });
    expect(getJob(s.db, done.job_id!)).toMatchObject({ kind: "render_final", video_id: s.video.id, thread_id: s.thread.id, continue_agent: 1, actor_role: "producer" });
    expect(JSON.parse(getJob(s.db, done.job_id!)!.request)).toEqual({ video_id: s.video.id, revision: 1, action_id: a.id });
    expect(listMessages(s.db, s.thread.id).at(-1)).toMatchObject({ role: "system", trigger: "action", text: expect.stringContaining("xác nhận") });
    expect(codeOf(() => decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "producer" }, NOW))).toBe("decided");
  });

  it("a card whose timeline changed, or older than a day, expires", () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, kind: "export_premiere" as const, title: "Xuất Premiere", summary: "…", params: { video_id: s.video.id }, createdBy: "u" };
    const a = proposeAction(s.db, base, NOW);
    saveVideoRevision(s.db, s.video.id, { baseRevision: 1, data: timeline(s.video.id, "Đổi"), authorId: "u" });
    expect(codeOf(() => decideAction(s.db, { actionId: a.id, decision: "confirm", userId: "p", role: "owner" }, NOW))).toBe("expired");
    expect(getAction(s.db, a.id)).toMatchObject({ status: "expired", error: expect.stringContaining("timeline đã đổi") });
    const b = proposeAction(s.db, base, NOW);
    expect(codeOf(() => decideAction(s.db, { actionId: b.id, decision: "confirm", userId: "p", role: "owner" }, LATER))).toBe("expired");
  });

  it("a large crawl runs as research; deleting archives the video; rejecting says so", () => {
    const s = setup();
    const base = { projectId: s.project.id, threadId: s.thread.id, messageId: s.turn.id, summary: "…", createdBy: "u" };
    const crawl = proposeAction(s.db, { ...base, kind: "crawl_large", title: "Crawl 150 video", params: { crawl: { kind: "topic", q: "phố cổ", max: 150 } } }, NOW);
    const c = decideAction(s.db, { actionId: crawl.id, decision: "confirm", userId: "e", role: "editor" }, NOW);
    expect(getJob(s.db, c.job_id!)).toMatchObject({ kind: "research", units: 150, continue_agent: 1 });
    const del = proposeAction(s.db, { ...base, kind: "delete_video", title: "Xoá video", params: { video_id: s.video.id } }, NOW);
    decideAction(s.db, { actionId: del.id, decision: "confirm", userId: "p", role: "producer" }, NOW);
    expect(getVideo(s.db, s.video.id)!.archived_at).toBe(NOW);
    const ref = proposeAction(s.db, { ...base, kind: "reference_download", title: "Tải 2 video mẫu", params: { video_ids: ["dQw4w9WgXcQ", "U_17EqTHUIo"], purpose: "nhịp dựng" } }, NOW);
    expect(decideAction(s.db, { actionId: ref.id, decision: "reject", userId: "e", role: "editor" }, NOW)).toMatchObject({ status: "rejected", job_id: null });
    expect(listMessages(s.db, s.thread.id).at(-1)!.text).toContain("từ chối");
    expect(listJobs(s.db, s.project.id).map((j) => j.kind)).toEqual(["research"]);
    expect(listActions(s.db, { threadId: s.thread.id, open: true })).toEqual([]);
  });

  it("propose_action: the agent's card defaults to the thread's video", async () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const r = await callAgentTool(agentTools(), s.ctx, "propose_action", { kind: "render_final", title: "Render bản cuối 1080p", why: "Bản xem trước đã ổn" });
    expect(r.text).toContain("cần vai producer");
    expect(listActions(s.db, { threadId: s.thread.id })[0]).toMatchObject({ kind: "render_final", video_id: s.video.id, message_id: s.turn.id, revision: 1 });
  });
});
