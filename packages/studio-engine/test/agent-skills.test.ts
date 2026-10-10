import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProject, materializeSkillPlugin, projectSkills, readFrontmatter, seedWorkspace, skillSlug, updateProject } from "../src/index.js";
import { world } from "./helpers.js";

const BUILTIN = fileURLToPath(new URL("../../../agent-skills", import.meta.url));
const NOW = "2026-10-10T08:00:00.000Z";

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'T', ?, ?)", [NOW, NOW]);
  const add = (id: string, name: string, enabled = 1) => w.db.run(
    "INSERT INTO team_skills (id, team_id, name, purpose, content, enabled, position, created_by, updated_by, created_at, updated_at) VALUES (?, 'team-1', ?, ?, ?, ?, 0, 'u', 'u', ?, ?)",
    [id, name, `Quy chuẩn ${name}`, `# ${name}\nLuôn viết hoa tên địa danh.`, enabled, NOW, NOW]);
  add("s1", "Quy chuẩn Thumbnail!");
  add("s2", "Giọng văn");
  add("s3", "Cũ", 0);
  const project = createProject(w.db, "team-1", { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "skills-ws-")), project, NOW);
  mkdirSync(join(dir, "skills", "Kiểu Mở Đầu"), { recursive: true });
  writeFileSync(join(dir, "skills", "Kiểu Mở Đầu", "SKILL.md"), "# Mở đầu\n5 giây đầu là cảnh đẹp nhất.\n");
  return { ...w, project, dir };
}

describe("agent skills", () => {
  it("slugs names for folders", () => {
    expect(skillSlug("Quy chuẩn Thumbnail!")).toBe("quy-chuan-thumbnail");
    expect(skillSlug("Đường phố")).toBe("duong-pho");
    expect(skillSlug("!!!")).toBe("skill");
  });

  it("gathers Studio's skills, the team's enabled ones and the project's, each named for its folder", () => {
    const { db, project, dir } = setup();
    const skills = projectSkills(db, { project, workspaceDir: dir, builtinDir: BUILTIN });
    expect(skills.map((s) => s.name)).toEqual([
      "branding", "channel-strategy", "research-report", "video-brief", "youtube-kit",
      "team-quy-chuan-thumbnail", "team-giong-van", "project-kieu-mo-dau",
    ]);
    const team = skills.find((s) => s.name === "team-giong-van")!;
    expect(readFrontmatter(team.text).data).toMatchObject({ name: "team-giong-van", description: "Quy chuẩn Giọng văn" });
    expect(readFrontmatter(skills.find((s) => s.name === "project-kieu-mo-dau")!.text).data.name).toBe("project-kieu-mo-dau");
    expect(readFrontmatter(skills[0]!.text).data.description).toContain("branding");
  });

  it("keeps only the team skills the project picked, when it picked", () => {
    const { db, project, dir } = setup();
    const picked = updateProject(db, project.id, { settings: { team_skills: ["s2"], auto_fix: true, auto_continue: true } }, NOW);
    expect(projectSkills(db, { project: picked, workspaceDir: dir, builtinDir: BUILTIN }).filter((s) => s.source === "team").map((s) => s.name)).toEqual(["team-giong-van"]);
  });

  it("writes the plugin folder afresh each time", () => {
    const { db, project, dir } = setup();
    const root = mkdtempSync(join(tmpdir(), "plugins-"));
    const plugin = materializeSkillPlugin(db, { project, workspaceDir: dir, builtinDir: BUILTIN, pluginsRoot: root });
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "studio" });
    expect(existsSync(join(plugin, "skills", "team-giong-van", "SKILL.md"))).toBe(true);
    db.run("UPDATE team_skills SET enabled = 0 WHERE id = 's2'");
    materializeSkillPlugin(db, { project, workspaceDir: dir, builtinDir: BUILTIN, pluginsRoot: root });
    expect(existsSync(join(plugin, "skills", "team-giong-van"))).toBe(false);
  });
});
