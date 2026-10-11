import { describe, expect, it } from "vitest";
import {
  auditActors, createJob, createProject, createThread, createVideo, listAudit, logAudit, redactDetails, scopeOf, sweepAuditLog,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-11T08:00:00.000Z";

function setup() {
  const w = world();
  for (const t of ["team-1", "team-2"]) w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [t, `Nhóm ${t}`, NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  const other = createProject(w.db, "team-2", { name: "Ẩm thực", description: "", language: "vi", aspect: "16:9" }, "auth0|other", NOW);
  const video = createVideo(w.db, project.id, { title: "Tràng An", createdBy: "auth0|owner" }, NOW);
  const thread = createThread(w.db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "auth0|owner" }, NOW);
  return { ...w, project, other, video, thread };
}

describe("activity log", () => {
  it("keeps details without secrets, cut short", () => {
    const out = redactDetails({
      name: "Kênh A", accessToken: "x", nested: { apiKey: "k", password: "p", ok: 1 }, long: "a".repeat(400), list: Array.from({ length: 25 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("accessToken");
    expect(out.nested).toEqual({ ok: 1 });
    expect(String(out.long)).toMatch(/^a{300}…\(400\)$/);
    expect((out.list as unknown[]).length).toBe(21);
    const huge = redactDetails(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(200)]))) as { truncated: boolean };
    expect(huge.truncated).toBe(true);
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(4096);
  });

  it("finds the team, project and video of a thread, a video or a job", () => {
    const s = setup();
    expect(scopeOf(s.db, { threadId: s.thread.id })).toEqual({ teamId: "team-1", projectId: s.project.id, videoId: s.video.id, threadId: s.thread.id });
    expect(scopeOf(s.db, { videoId: s.video.id })).toMatchObject({ teamId: "team-1", projectId: s.project.id });
    const job = createJob(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "research", title: "Crawl", request: {}, createdBy: "u" }, NOW);
    expect(scopeOf(s.db, { jobId: job.id })).toMatchObject({ teamId: "team-1", projectId: s.project.id, videoId: s.video.id });
    expect(scopeOf(s.db, { projectId: "gone" })).toEqual({ teamId: null, projectId: "gone", videoId: null, threadId: null });
  });

  it("lists newest first with names; an owner sees their teams only; filters; old rows are swept", () => {
    const s = setup();
    logAudit(s.db, { at: "2026-10-01T00:00:00.000Z", actorKind: "user", actorId: "auth0|owner", kind: "http", action: "VideosController.create", outcome: "ok",
      method: "POST", route: "/api/projects/:projectId/videos", statusCode: 201, projectId: s.project.id, details: { body: { title: "Tràng An", token: "t" } } });
    logAudit(s.db, { at: "2026-10-11T07:00:00.000Z", actorKind: "agent", actorId: "auth0|owner", kind: "tool", action: "footage_search", outcome: "error",
      threadId: s.thread.id, durationMs: 12.4 });
    logAudit(s.db, { at: "2026-10-11T07:30:00.000Z", actorKind: "user", actorId: "auth0|other", kind: "http", action: "ProjectsController.update", outcome: "ok",
      projectId: s.other.id });
    logAudit(s.db, { at: "2026-10-11T07:40:00.000Z", actorKind: "user", actorId: "auth0|admin", kind: "http", action: "StudioOverviewController.settings", outcome: "ok" });

    const all = listAudit(s.db, {});
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.action)).toEqual(["StudioOverviewController.settings", "ProjectsController.update", "footage_search", "VideosController.create"]);
    const tool = all.items[2]!;
    expect(tool).toMatchObject({ team: { id: "team-1", name: "Nhóm team-1" }, project: { name: "Du lịch chậm" }, video: { title: "Tràng An" }, durationMs: 12, outcome: "error" });
    expect(all.items[3]!.details).toEqual({ body: { title: "Tràng An" } });

    const mine = listAudit(s.db, { teamIds: ["team-1"] });
    expect(mine.items.map((i) => i.action)).toEqual(["footage_search", "VideosController.create"]);
    expect(listAudit(s.db, { teamIds: [] }).total).toBe(0);
    expect(listAudit(s.db, { teamIds: ["team-1"], kind: "tool", outcome: "error" }).total).toBe(1);
    expect(listAudit(s.db, { from: "2026-10-11T00:00:00.000Z", to: "2026-10-11T07:35:00.000Z" }).total).toBe(2);
    expect(listAudit(s.db, {}, 2, 3).items.map((i) => i.action)).toEqual(["VideosController.create"]);
    expect(auditActors(s.db, { teamIds: ["team-1"] })).toEqual(["auth0|owner"]);

    expect(sweepAuditLog(s.db, "2026-10-05T00:00:00.000Z")).toBe(1);
    expect(listAudit(s.db, {}).total).toBe(3);
  });

  it("never throws: a broken write is reported and the work goes on", () => {
    const s = setup();
    const errors: unknown[] = [];
    expect(logAudit(s.db, { actorKind: "nobody" as never, kind: "http", action: "x", outcome: "ok" }, (e) => errors.push(e))).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
