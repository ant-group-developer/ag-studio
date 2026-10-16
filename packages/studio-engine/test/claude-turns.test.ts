import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { claudeTurn, claudeTurns, createProject, createThread, createVideo, logAudit, postUserMessage, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const PERIOD = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" };

async function call(db: StudioDb, c: { at: string; team: string; project: string; video?: string | null; thread: string; message: string; user: string; cost: number; wall?: number; outcome?: string }) {
  const id = randomUUID();
  await db.run(
    `INSERT INTO llm_calls (id, created_at, source, production_id, episode_id, run_id, stage_key, attempt_id, skill, model, round, outcome, problems,
       input_tokens, output_tokens, cost_usd, wall_seconds, cache_read_tokens, cache_creation_tokens, num_turns, user_id, team_id)
     VALUES (?, ?, 'claude-agent', ?, ?, ?, 'agent', ?, 'agent', 'claude-sonnet', 1, ?, '[]', 1200, 80, ?, ?, 900, 20, 4, ?, ?)`,
    [id, c.at, c.project, c.video ?? null, c.thread, c.message, c.outcome ?? "accepted", c.cost, c.wall ?? 30, c.user, c.team],
  );
  return id;
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
  const tv = await createThread(w.db, { projectId: a.id, videoId: v.id, kind: "video", title: "Tràng An", createdBy: "auth0|lan" }, NOW);
  const tb = await createThread(w.db, { projectId: b.id, kind: "project", title: "Kênh", createdBy: "auth0|minh" }, NOW);
  const asked = await postUserMessage(w.db, { threadId: tv.id, text: "Chọn cảnh thuyền trên sông cho đoạn mở đầu", actor: { id: "auth0|lan", role: "editor" } }, "2026-10-10T01:59:00.000Z");
  const turn = asked.turn!;
  const parts = [
    { kind: "text", text: "Mình tìm cảnh." },
    { kind: "tool", id: "t1", name: "mcp__studio__footage_search", input: { q: "thuyền" }, started_at: "2026-10-10T02:00:01.000Z", ended_at: "2026-10-10T02:00:03.000Z", result: "x".repeat(5000) },
    { kind: "tool", id: "t2", name: "Write", input: { file_path: "videos/v1/edit-plan.json", content: "y".repeat(5000) }, started_at: "2026-10-10T02:00:04.000Z", ended_at: "2026-10-10T02:00:05.000Z", is_error: true, result: "lỗi" },
  ];
  await w.db.run("UPDATE agent_messages SET status = 'done', text = ?, parts = ?, attempts = 1 WHERE id = ?", ["Đã chọn 3 cảnh.", JSON.stringify(parts), turn.id]);
  const big = await call(w.db, { at: "2026-10-10T02:00:00.000Z", team: "team-1", project: a.id, video: v.id, thread: tv.id, message: turn.id, user: "auth0|lan", cost: 0.3, wall: 40 });
  await logAudit(w.db, {
    actorKind: "agent", actorId: "auth0|lan", kind: "turn", action: "turn", outcome: "ok", at: "2026-10-10T02:01:00.000Z", teamId: "team-1", projectId: a.id,
    videoId: v.id, threadId: tv.id, messageId: turn.id, details: { changed: ["videos/v1/edit-plan.json"] },
  });
  const other = (await postUserMessage(w.db, { threadId: tb.id, text: "Món gì", actor: { id: "auth0|minh", role: "owner" } }, "2026-10-10T03:59:00.000Z")).turn!;
  const small = await call(w.db, { at: "2026-10-10T04:00:00.000Z", team: "team-2", project: b.id, thread: tb.id, message: other.id, user: "auth0|minh", cost: 0.05, outcome: "failed" });
  await call(w.db, { at: "2026-09-01T04:00:00.000Z", team: "team-1", project: a.id, thread: tv.id, message: turn.id, user: "auth0|lan", cost: 5 }); // before the period
  return { ...w, a, b, v, tv, tb, turn, big, small };
}

describe("Claude turns one by one", () => {
  it("lists a period's turns newest first, with where, who, how it ended, tokens, cost, time, tools and what asked", async () => {
    const s = await setup();
    const r = await claudeTurns(s.db, PERIOD);
    expect(r.total).toBe(2);
    expect(r.items.map((x) => x.id)).toEqual([s.small, s.big]);
    expect(r.items[1]).toMatchObject({
      projectName: "Du lịch chậm", videoTitle: "Tràng An", threadTitle: "Tràng An", userId: "auth0|lan", model: "claude-sonnet", outcome: "accepted",
      status: "done", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheCreationTokens: 20, costUsd: 0.3, wallSeconds: 40, numTurns: 4,
      toolCount: 2, prompt: "Chọn cảnh thuyền trên sông cho đoạn mở đầu",
    });
  });

  it("filters by team, project, video, person and outcome; sorts by cost; pages", async () => {
    const s = await setup();
    expect((await claudeTurns(s.db, { ...PERIOD, teamIds: ["team-1"] })).items.map((x) => x.id)).toEqual([s.big]);
    expect((await claudeTurns(s.db, { ...PERIOD, teamIds: [] })).total).toBe(0);
    expect((await claudeTurns(s.db, { ...PERIOD, projectId: s.b.id })).items.map((x) => x.id)).toEqual([s.small]);
    expect((await claudeTurns(s.db, { ...PERIOD, videoId: s.v.id })).items.map((x) => x.id)).toEqual([s.big]);
    expect((await claudeTurns(s.db, { ...PERIOD, videoId: "" })).items.map((x) => x.id)).toEqual([s.small]);
    expect((await claudeTurns(s.db, { ...PERIOD, userId: "auth0|minh", outcome: "failed" })).items.map((x) => x.id)).toEqual([s.small]);
    expect((await claudeTurns(s.db, { ...PERIOD, sortBy: "cost", sortOrder: "desc" })).items.map((x) => x.id)).toEqual([s.big, s.small]);
    expect(await claudeTurns(s.db, { ...PERIOD, page: 2, pageSize: 1 })).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: s.big }] });
  });

  it("shows one turn in full: what asked, the answer, each tool (long text shortened), the files changed; only in the teams given", async () => {
    const s = await setup();
    const d = (await claudeTurn(s.db, s.big))!;
    expect(d).toMatchObject({ promptText: "Chọn cảnh thuyền trên sông cho đoạn mở đầu", promptBy: "auth0|lan", text: "Đã chọn 3 cảnh.", attempts: 1, changed: ["videos/v1/edit-plan.json"] });
    expect(d.tools.map((t) => [t.name, t.isError])).toEqual([["mcp__studio__footage_search", false], ["Write", true]]);
    expect(d.tools[0]!.result!.length).toBeLessThan(4100);
    expect((d.tools[1]!.input as { content: string }).content.length).toBeLessThan(4100);
    expect(await claudeTurn(s.db, s.big, { teamIds: ["team-2"] })).toBeUndefined();
    expect(await claudeTurn(s.db, "nope")).toBeUndefined();
  });
});
