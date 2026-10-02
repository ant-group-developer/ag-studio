/**
 * Team skills ("quy chuẩn & skill"): stored per team, limited in length, and read at call time for the run a Claude
 * stage belongs to (plan run -> production -> team; episode run -> episode -> production -> team).
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createStudioWorker, createTeamSkill, deleteTeamSkill, listLlmCalls, listTeamSkills, readLlmCallPayload, startEpisodeRun,
  startPlanRun, StudioRunError, teamGuidesForRun, updateTeamSkill,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, ROOT, seedProduction, world } from "./helpers.js";

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof StudioRunError) return String(e.details.code ?? e.code); throw e; }
  return undefined;
}

describe("team skills", () => {
  let w: ReturnType<typeof world>;
  afterEach(() => w?.core.close());

  it("creates, orders, updates and deletes the skills of a team", () => {
    w = world();
    seedProduction(w.db);
    const a = createTeamSkill(w.db, "team-1", { name: "Tiêu đề", content: "# Tiêu đề\n- ≤ 60 ký tự", position: 2 }, "auth0|owner");
    const b = createTeamSkill(w.db, "team-1", { name: "Mục đích", purpose: "Vì sao làm kênh", content: "Kể chuyện ẩm thực", appliesTo: ["rnd", "branding"], position: 1 }, "auth0|owner");
    expect(listTeamSkills(w.db, "team-1").map((s) => s.name)).toEqual(["Mục đích", "Tiêu đề"]);
    expect(b).toMatchObject({ applies_to: ["rnd", "branding"], enabled: true, purpose: "Vì sao làm kênh", created_by: "auth0|owner" });

    const updated = updateTeamSkill(w.db, "team-1", a.id, { enabled: false, content: "đã sửa" }, "auth0|editor");
    expect(updated).toMatchObject({ enabled: false, content: "đã sửa", updated_by: "auth0|editor", created_by: "auth0|owner" });

    deleteTeamSkill(w.db, "team-1", a.id);
    expect(listTeamSkills(w.db, "team-1").map((s) => s.id)).toEqual([b.id]);
    expect(code(() => deleteTeamSkill(w.db, "team-1", a.id))).toBe("not_found");
    // a skill of another team is not found through this team
    expect(code(() => updateTeamSkill(w.db, "team-2", b.id, { name: "x" }, "u"))).toBe("not_found");
  });

  it("refuses a name used twice in a team, and enabled content above the team's total", () => {
    w = world();
    seedProduction(w.db);
    createTeamSkill(w.db, "team-1", { name: "Quy chuẩn", content: "a" }, "u");
    expect(code(() => createTeamSkill(w.db, "team-1", { name: "Quy chuẩn", content: "b" }, "u"))).toBe("team_skill_name_taken");

    const big = "x".repeat(20_000);
    createTeamSkill(w.db, "team-1", { name: "A", content: big }, "u");
    createTeamSkill(w.db, "team-1", { name: "B", content: big }, "u");
    // 1 + 40 000 enabled so far; a third full skill would pass 60 000
    expect(code(() => createTeamSkill(w.db, "team-1", { name: "C", content: big }, "u"))).toBe("team_skills_too_long");
    // disabled ones do not count, and enabling one again is checked too
    const c = createTeamSkill(w.db, "team-1", { name: "C", content: big, enabled: false }, "u");
    expect(code(() => updateTeamSkill(w.db, "team-1", c.id, { enabled: true }, "u"))).toBe("team_skills_too_long");
    expect(code(() => createTeamSkill(w.db, "team-1", { name: "D", content: "x".repeat(20_001) }, "u"))).toBe("team_skill_too_long");
  });

  it("gives a plan run and an episode run the enabled skills of the production's team, in order", () => {
    w = world();
    const prodId = seedProduction(w.db);
    createTeamSkill(w.db, "team-1", { name: "Hai", content: "hai", position: 2 }, "u");
    createTeamSkill(w.db, "team-1", { name: "Một", content: "một", purpose: "p", appliesTo: ["youtube-kit"], position: 1 }, "u");
    createTeamSkill(w.db, "team-1", { name: "Tắt", content: "tắt", enabled: false }, "u");

    const { runId } = startPlanRun(w.core, w.db, prodId);
    expect(teamGuidesForRun(w.db, runId)).toEqual([
      { name: "Một", purpose: "p", applies_to: ["youtube-kit"], content: "một" },
      { name: "Hai", purpose: "", applies_to: [], content: "hai" },
    ]);

    const now = new Date().toISOString();
    w.db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES ('e1', ?, 1, 'T', 'h', '{}', ?, ?)", [prodId, now, now]);
    const ep = startEpisodeRun(w.core, w.db, "e1");
    expect(teamGuidesForRun(w.db, ep.runId).map((g) => g.name)).toEqual(["Một", "Hai"]);
    expect(teamGuidesForRun(w.db, "run_unknown")).toEqual([]);
  });

  it("goes away with its team", () => {
    w = world();
    seedProduction(w.db);
    w.db.run("DELETE FROM productions");
    createTeamSkill(w.db, "team-1", { name: "A", content: "a" }, "u");
    w.db.run("DELETE FROM teams WHERE id = 'team-1'");
    expect(w.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM team_skills")?.n).toBe(0);
  });
});

describe("team skills in the Claude calls of a production", () => {
  let w: ReturnType<typeof world>;
  afterEach(() => w?.core.close());

  it("sends the team's skills of the step with the plan-episodes call and keeps them in the call log", async () => {
    w = world();
    const prodId = seedProduction(w.db);
    createTeamSkill(w.db, "team-1", { name: "Nhịp tập", content: "Mỗi tập mở bằng cảnh đẹp nhất.", appliesTo: ["plan-episodes"] }, "u");
    createTeamSkill(w.db, "team-1", { name: "Chỉ cho tiêu đề", content: "KHÔNG-ĐƯỢC-THẤY", appliesTo: ["youtube-kit"] }, "u");
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(6, 30), farm: fakeFarm(w.bucket) as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner",
    });
    startPlanRun(w.core, w.db, prodId);
    for (let i = 0; i < 200 && (await worker.runOnce()) !== "idle"; i++);
    const calls = listLlmCalls(w.db, { productionId: prodId, page: 1, pageSize: 20 }).items.filter((c) => c.stage_key === "plan-episodes");
    expect(calls).toHaveLength(1);
    const payload = await readLlmCallPayload(w.bucket, calls[0]!.payload_key!);
    expect(payload.prompt).toContain('<team_guide name="Nhịp tập">\nMỗi tập mở bằng cảnh đẹp nhất.\n</team_guide>');
    expect(payload.prompt).not.toContain("KHÔNG-ĐƯỢC-THẤY");
  });
});
