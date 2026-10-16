import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { claudeStats, createProject, createThread, createVideo, postUserMessage, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

async function call(db: StudioDb, c: { at: string; team: string; project: string; video?: string | null; thread: string; user: string; cost: number; outcome?: string; input?: number; read?: number }) {
  await db.run(
    `INSERT INTO llm_calls (id, created_at, source, production_id, episode_id, run_id, stage_key, attempt_id, skill, model, round, outcome, problems,
       input_tokens, output_tokens, cost_usd, wall_seconds, cache_read_tokens, cache_creation_tokens, num_turns, user_id, team_id)
     VALUES (?, ?, 'claude-agent', ?, ?, ?, 'agent', ?, 'agent', 'sonnet', 1, ?, '[]', ?, 50, ?, 12.5, ?, 10, 3, ?, ?)`,
    [randomUUID(), c.at, c.project, c.video ?? null, c.thread, randomUUID(), c.outcome ?? "accepted", c.input ?? 1000, c.cost, c.read ?? 800, c.user, c.team],
  );
}

let open: StudioDb | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function setup() {
  const w = await world();
  open = w.db;
  for (const t of ["team-1", "team-2"]) await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [t, `Nhóm ${t}`, NOW, NOW]);
  const a = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|lan", NOW);
  const b = await createProject(w.db, "team-2", { name: "Ẩm thực", description: "", language: "vi", aspect: "16:9" }, "auth0|minh", NOW);
  const v = await createVideo(w.db, a.id, { title: "Tràng An", createdBy: "auth0|lan" }, NOW);
  const ta = await createThread(w.db, { projectId: a.id, kind: "project", title: "Kênh", createdBy: "auth0|lan" }, NOW);
  const tv = await createThread(w.db, { projectId: a.id, videoId: v.id, kind: "video", title: "Tràng An", createdBy: "auth0|lan" }, NOW);
  const tb = await createThread(w.db, { projectId: b.id, kind: "project", title: "Kênh", createdBy: "auth0|minh" }, NOW);
  await call(w.db, { at: "2026-10-09T23:30:00.000Z", team: "team-1", project: a.id, thread: ta.id, user: "auth0|lan", cost: 0.1 });
  await call(w.db, { at: "2026-10-10T02:00:00.000Z", team: "team-1", project: a.id, video: v.id, thread: tv.id, user: "auth0|lan", cost: 0.3 });
  await call(w.db, { at: "2026-10-10T03:00:00.000Z", team: "team-1", project: a.id, video: v.id, thread: tv.id, user: "auth0|an", cost: 0.2, outcome: "failed" });
  await call(w.db, { at: "2026-10-10T04:00:00.000Z", team: "team-2", project: b.id, thread: tb.id, user: "auth0|minh", cost: 1, outcome: "rate_limited" });
  await call(w.db, { at: "2026-09-01T04:00:00.000Z", team: "team-1", project: a.id, thread: ta.id, user: "auth0|lan", cost: 5 }); // before the period
  await postUserMessage(w.db, { threadId: tv.id, text: "Chọn cảnh", actor: { id: "auth0|lan", role: "editor" } }, "2026-10-10T01:59:00.000Z");
  await postUserMessage(w.db, { threadId: tv.id, text: "Thêm nữa", actor: { id: "auth0|an", role: "editor" } }, "2026-10-10T02:59:00.000Z");
  await postUserMessage(w.db, { threadId: tb.id, text: "Món gì", actor: { id: "auth0|minh", role: "owner" } }, "2026-10-10T03:59:00.000Z");
  return { ...w, a, b, v, ta, tv, tb };
}

const PERIOD = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" };

describe("Claude chat stats", () => {
  it("totals a period: turns, threads, messages, tokens with the cache, cost, failures", async () => {
    const s = await setup();
    const { totals } = await claudeStats(s.db, { ...PERIOD, groupBy: "team" });
    expect(totals).toEqual({
      turns: 4, threads: 3, userMessages: 3, inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3200, cacheCreationTokens: 40, costUsd: 1.6,
      wallSeconds: 50, failed: 1, rateLimited: 1,
    });
  });

  it("groups by team, project, video (project chats apart) and person, most costly first", async () => {
    const s = await setup();
    const teams = (await claudeStats(s.db, { ...PERIOD, groupBy: "team" })).rows;
    expect(teams.map((r) => [r.label, r.turns, r.costUsd, r.userMessages])).toEqual([["Nhóm team-2", 1, 1, 1], ["Nhóm team-1", 3, 0.6, 2]]);
    const projects = (await claudeStats(s.db, { ...PERIOD, groupBy: "project" })).rows;
    expect(projects.map((r) => [r.label, r.teamId])).toEqual([["Ẩm thực", "team-2"], ["Du lịch chậm", "team-1"]]);
    const videos = (await claudeStats(s.db, { ...PERIOD, groupBy: "video", teamIds: ["team-1"] })).rows;
    expect(videos.map((r) => [r.key, r.label, r.turns, r.userMessages])).toEqual([[s.v.id, "Du lịch chậm · Tràng An", 2, 2], [null, null, 1, 0]]);
    const people = (await claudeStats(s.db, { ...PERIOD, groupBy: "user", teamIds: ["team-1"] })).rows;
    expect(people.map((r) => [r.key, r.turns, r.costUsd, r.failed, r.userMessages])).toEqual([["auth0|lan", 2, 0.4, 0, 1], ["auth0|an", 1, 0.2, 1, 1]]);
  });

  it("keeps to the teams and project asked; days follow the viewer's time zone", async () => {
    const s = await setup();
    expect((await claudeStats(s.db, { ...PERIOD, groupBy: "team", teamIds: [] })).totals.turns).toBe(0);
    expect((await claudeStats(s.db, { ...PERIOD, groupBy: "video", projectId: s.b.id })).totals).toMatchObject({ turns: 1, userMessages: 1 });
    const utc = (await claudeStats(s.db, { ...PERIOD, groupBy: "team", teamIds: ["team-1"] })).daily;
    expect(utc.map((d) => [d.day, d.turns])).toEqual([["2026-10-09", 1], ["2026-10-10", 2]]);
    const vn = (await claudeStats(s.db, { ...PERIOD, groupBy: "team", teamIds: ["team-1"], tzOffsetMinutes: 420 })).daily;
    expect(vn).toEqual([{ day: "2026-10-10", turns: 3, costUsd: 0.6, inputTokens: 3000, outputTokens: 150 }]);
  });
});
