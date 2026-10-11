/**
 * Team skills ("quy chuẩn & skill"): stored per team, limited in length; the agent gets the enabled ones a project
 * turned on as skills of its turns (agent-skills.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTeamSkill, deleteTeamSkill, listTeamSkills, StudioRunError, updateTeamSkill, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

function seedTeam(db: StudioDb): void {
  const now = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [now, now]);
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof StudioRunError) return String(e.details.code ?? e.code); throw e; }
  return undefined;
}

describe("team skills", () => {
  let w: ReturnType<typeof world>;
  afterEach(() => w?.core.close());

  it("creates, orders, updates and deletes the skills of a team", () => {
    w = world();
    seedTeam(w.db);
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
    seedTeam(w.db);
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

  it("goes away with its team", () => {
    w = world();
    seedTeam(w.db);
    createTeamSkill(w.db, "team-1", { name: "A", content: "a" }, "u");
    w.db.run("DELETE FROM teams WHERE id = 'team-1'");
    expect(w.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM team_skills")?.n).toBe(0);
  });
});
