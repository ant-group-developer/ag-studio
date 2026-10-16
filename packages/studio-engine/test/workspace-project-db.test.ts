import { afterEach, describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  archiveProject, archiveVideo, createProject, createVideo, getProject, getVideo, latestVideoRevision, listProjects, listVideoRevisions,
  listVideos, projectView, RevisionConflictError, saveVideoRevision, StudioRunError, updateProject, updateVideo, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const LATER = "2026-10-10T09:00:00.000Z";

let opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened) await db.close(); opened = []; });
async function open() {
  const w = await world();
  opened.push(w.db);
  return w;
}

async function team(db: StudioDb, id = "team-1") {
  await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, 'Team', ?, ?) ON CONFLICT DO NOTHING", [id, NOW, NOW]);
  return id;
}

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

describe("projects", () => {
  it("creates a project for a team with the creator as owner and default settings", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "Du lịch Việt", channelUrl: "@dulichviet", description: "Kênh đi bộ", language: "vi", aspect: "16:9" }, "auth0|u1", NOW);
    expect(p).toMatchObject({ team_id: "team-1", name: "Du lịch Việt", channel_url: "@dulichviet", owner_user_id: "auth0|u1", created_by: "auth0|u1", archived_at: null });
    expect(projectView(p)).toMatchObject({ id: p.id, teamId: "team-1", channelUrl: "@dulichviet", settings: { auto_fix: true, auto_continue: true } });
    expect((await getProject(db, p.id))?.name).toBe("Du lịch Việt");
  });

  it("lists a team's projects with video counts, newest activity first; archived ones only on request", async () => {
    const { db } = await open();
    const a = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const b = await createProject(db, await team(db), { name: "B", description: "", language: "vi", aspect: "9:16" }, "u", NOW);
    await createVideo(db, b.id, { title: "v1", createdBy: "u" }, LATER);
    await createVideo(db, b.id, { title: "v2", createdBy: "u" }, LATER);
    expect((await listProjects(db, "team-1")).map((p) => [p.name, p.video_count, p.last_activity_at])).toEqual([["B", 2, LATER], ["A", 0, NOW]]);
    await archiveProject(db, a.id, LATER);
    expect((await listProjects(db, "team-1")).map((p) => p.name)).toEqual(["B"]);
    expect((await listProjects(db, "team-1", { archived: true })).map((p) => p.name)).toEqual(["A"]);
  });

  it("an edit changes only what it names and keeps settings valid", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const out = await updateProject(db, p.id, { description: "mới", channelUrl: null, settings: { model: "sonnet", auto_fix: false, auto_continue: true } }, LATER);
    expect(out).toMatchObject({ name: "A", description: "mới", channel_url: null, updated_at: LATER });
    expect(projectView(out).settings).toEqual({ model: "sonnet", auto_fix: false, auto_continue: true });
    expect(projectView(await updateProject(db, p.id, { name: "B" }, LATER)).settings).toEqual({ model: "sonnet", auto_fix: false, auto_continue: true });
    await expect(updateProject(db, "nope", { name: "x" }, LATER)).rejects.toThrow(StudioRunError);
  });
});

describe("videos", () => {
  it("numbers videos in order within a project and keeps the numbers after one is archived", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const v1 = await createVideo(db, p.id, { title: "Hội An", createdBy: "u" }, NOW);
    const v2 = await createVideo(db, p.id, { title: "Huế", createdBy: "u" }, NOW);
    expect([v1.idx, v2.idx, v1.status]).toEqual([1, 2, "draft"]);
    await archiveVideo(db, v1.id, LATER);
    const v3 = await createVideo(db, p.id, { title: "Đà Lạt", createdBy: "u" }, LATER);
    expect(v3.idx).toBe(3);
    expect((await listVideos(db, p.id)).map((v) => v.title)).toEqual(["Đà Lạt", "Huế"]);
    expect(await updateVideo(db, v2.id, { status: "in_progress", title: "Huế mưa" }, LATER)).toMatchObject({ status: "in_progress", title: "Huế mưa" });
    await expect(createVideo(db, "nope", { title: "x", createdBy: "u" }, NOW)).rejects.toThrow(StudioRunError);
    expect((await getVideo(db, v2.id))?.project_id).toBe(p.id);
  });

  it("videos created at once get different numbers", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const made = await Promise.all(Array.from({ length: 5 }, (_, i) => createVideo(db, p.id, { title: `v${i}`, createdBy: "u" }, NOW)));
    expect(made.map((v) => v.idx).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("video timeline revisions", () => {
  it("saves v4 revisions on top of the latest one and refuses a stale base or another video's timeline", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const v = await createVideo(db, p.id, { title: "Hội An", createdBy: "u" }, NOW);
    expect(await latestVideoRevision(db, v.id)).toBeNull();
    expect(await saveVideoRevision(db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: "agent:m1", label: "fit" })).toEqual({ revision: 1 });
    expect(await saveVideoRevision(db, v.id, { baseRevision: 1, data: timeline(v.id, "Đèn lồng"), authorId: "u" })).toEqual({ revision: 2 });
    await expect(saveVideoRevision(db, v.id, { baseRevision: 1, data: timeline(v.id), authorId: "u" })).rejects.toThrow(RevisionConflictError);
    await expect(saveVideoRevision(db, v.id, { baseRevision: 2, data: timeline("other"), authorId: "u" })).rejects.toThrow(/belongs to/);
    expect((await latestVideoRevision(db, v.id))?.revision).toBe(2);
    expect((await latestVideoRevision(db, v.id))?.data.texts[0]?.text).toBe("Đèn lồng");
    expect((await listVideoRevisions(db, v.id)).map((r) => [r.revision, r.label])).toEqual([[2, null], [1, "fit"]]);
  });

  it("two saves on the same base at once: one lands, the other is a conflict", async () => {
    const { db } = await open();
    const p = await createProject(db, await team(db), { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const v = await createVideo(db, p.id, { title: "Hội An", createdBy: "u" }, NOW);
    const out = await Promise.allSettled([1, 2].map((n) => saveVideoRevision(db, v.id, { baseRevision: 0, data: timeline(v.id, `bản ${n}`), authorId: "u" })));
    expect(out.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ revision: number }>).value)).toEqual([{ revision: 1 }]);
    expect((out.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    expect((await listVideoRevisions(db, v.id)).map((r) => r.revision)).toEqual([1]);
  });
});
