/**
 * Team skills ("quy chuẩn & skill"): stored per team, limited in length; the agent gets the enabled ones a project
 * turned on as skills of its turns (agent-skills.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTeamSkill, deleteTeamSkill, listTeamSkills, StudioRunError, updateTeamSkill, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

async function seedTeam(db: StudioDb): Promise<void> {
  const now = new Date().toISOString();
  await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?) ON CONFLICT DO NOTHING", [now, now]);
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { if (e instanceof StudioRunError) return String(e.details.code ?? e.code); throw e; }
  return undefined;
}

describe("team skills", () => {
  let w: Awaited<ReturnType<typeof world>> | undefined;
  afterEach(async () => { await w?.db.close(); w = undefined; });

  it("creates, orders, updates and deletes the skills of a team", async () => {
    w = await world();
    const db = w.db;
    await seedTeam(db);
    const a = await createTeamSkill(db, "team-1", { name: "Tiêu đề", content: "# Tiêu đề\n- ≤ 60 ký tự", position: 2 }, "auth0|owner");
    const b = await createTeamSkill(db, "team-1", { name: "Mục đích", purpose: "Vì sao làm kênh", content: "Kể chuyện ẩm thực", appliesTo: ["rnd", "branding"], position: 1 }, "auth0|owner");
    expect((await listTeamSkills(db, "team-1")).map((s) => s.name)).toEqual(["Mục đích", "Tiêu đề"]);
    expect(b).toMatchObject({ applies_to: ["rnd", "branding"], enabled: true, purpose: "Vì sao làm kênh", created_by: "auth0|owner" });

    const updated = await updateTeamSkill(db, "team-1", a.id, { enabled: false, content: "đã sửa" }, "auth0|editor");
    expect(updated).toMatchObject({ enabled: false, content: "đã sửa", updated_by: "auth0|editor", created_by: "auth0|owner" });

    await deleteTeamSkill(db, "team-1", a.id);
    expect((await listTeamSkills(db, "team-1")).map((s) => s.id)).toEqual([b.id]);
    expect(await code(deleteTeamSkill(db, "team-1", a.id))).toBe("not_found");
    // a skill of another team is not found through this team
    expect(await code(updateTeamSkill(db, "team-2", b.id, { name: "x" }, "u"))).toBe("not_found");
  });

  it("refuses a name used twice in a team, and enabled content above the team's total", async () => {
    w = await world();
    const db = w.db;
    await seedTeam(db);
    await createTeamSkill(db, "team-1", { name: "Quy chuẩn", content: "a" }, "u");
    expect(await code(createTeamSkill(db, "team-1", { name: "Quy chuẩn", content: "b" }, "u"))).toBe("team_skill_name_taken");

    const big = "x".repeat(20_000);
    await createTeamSkill(db, "team-1", { name: "A", content: big }, "u");
    await createTeamSkill(db, "team-1", { name: "B", content: big }, "u");
    // 1 + 40 000 enabled so far; a third full skill would pass 60 000
    expect(await code(createTeamSkill(db, "team-1", { name: "C", content: big }, "u"))).toBe("team_skills_too_long");
    // disabled ones do not count, and enabling one again is checked too
    const c = await createTeamSkill(db, "team-1", { name: "C", content: big, enabled: false }, "u");
    expect(await code(updateTeamSkill(db, "team-1", c.id, { enabled: true }, "u"))).toBe("team_skills_too_long");
    expect(await code(createTeamSkill(db, "team-1", { name: "D", content: "x".repeat(20_001) }, "u"))).toBe("team_skill_too_long");
  });

  it("two skills saved at once cannot pass the team's total together", async () => {
    w = await world();
    const db = w.db;
    await seedTeam(db);
    const big = "x".repeat(20_000);
    await createTeamSkill(db, "team-1", { name: "A", content: big }, "u");
    await createTeamSkill(db, "team-1", { name: "B", content: big }, "u");
    const same = await Promise.all([code(createTeamSkill(db, "team-1", { name: "E", content: "e" }, "u")), code(createTeamSkill(db, "team-1", { name: "E", content: "e" }, "u"))]);
    expect(same.sort()).toEqual(["team_skill_name_taken", undefined].sort());
    // 40 001 enabled: one more of 19 999 fits, two do not
    const rest = "x".repeat(19_999);
    const codes = await Promise.all([code(createTeamSkill(db, "team-1", { name: "C", content: rest }, "u")), code(createTeamSkill(db, "team-1", { name: "D", content: rest }, "u"))]);
    expect(codes.sort()).toEqual(["team_skills_too_long", undefined].sort());
  });

  it("goes away with its team", async () => {
    w = await world();
    await seedTeam(w.db);
    await createTeamSkill(w.db, "team-1", { name: "A", content: "a" }, "u");
    await w.db.run("DELETE FROM teams WHERE id = 'team-1'");
    expect((await w.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM team_skills"))?.n).toBe(0);
  });
});
