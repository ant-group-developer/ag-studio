/**
 * The skills an agent turn loads (spec 2026-10-10 agent-workspace §3.2, ADR-0001 item 182). Under `--restricted` the
 * CLI ignores the workspace's `.claude/skills`, so each turn gets a plugin folder outside the workspace — rebuilt every
 * turn from Studio's own skills (`agent-skills/`), the team's enabled skills (`team-<name>`) and the project's
 * (`skills/<name>/SKILL.md` in the workspace, as `project-<name>`). The agent calls them `studio:<name>`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectSettingsOf } from "@harness/contracts";
import type { StudioDb } from "../studio-db.js";
import type { ProjectRecord } from "../workspace/project-db.js";
import { readFrontmatter, writeFrontmatter } from "../workspace/frontmatter.js";

export interface SkillEntry {
  /** Folder (and skill) name in the plugin. */
  name: string;
  source: "studio" | "team" | "project";
  description: string;
  /** The SKILL.md to write (frontmatter `name` set to `name`). */
  text: string;
}

/** `Quy chuẩn Thumbnail!` → `quy-chuan-thumbnail`. */
export function skillSlug(name: string): string {
  const s = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "skill";
}

function withName(text: string, name: string, description: string): string {
  const fm = readFrontmatter(text);
  const desc = typeof fm.data.description === "string" && fm.data.description.trim() ? fm.data.description : description;
  if (fm.error) return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}`;
  return writeFrontmatter(text, { name, description: desc });
}

function folderSkills(dir: string, source: "studio" | "project", prefix: string): SkillEntry[] {
  if (!existsSync(dir)) return [];
  const out: SkillEntry[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const file = join(dir, entry, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > 64 * 1024) continue;
    const text = readFileSync(file, "utf8");
    const name = `${prefix}${skillSlug(entry)}`;
    const description = String(readFrontmatter(text).data.description ?? `Skill ${entry} của ${source === "studio" ? "Studio" : "dự án"}.`);
    out.push({ name, source, description, text: withName(text, name, description) });
  }
  return out;
}

/** Every skill of a project's turn: Studio's, then the team's enabled ones (those the project picked, if it did), then its own. */
export function projectSkills(db: StudioDb, o: { project: ProjectRecord; workspaceDir: string; builtinDir: string }): SkillEntry[] {
  const picked = projectSettingsOf(o.project.settings).team_skills;
  const team = db.all<{ id: string; name: string; purpose: string; content: string }>(
    "SELECT id, name, purpose, content FROM team_skills WHERE team_id = ? AND enabled = 1 ORDER BY position, created_at", [o.project.team_id],
  ).filter((s) => !picked || picked.includes(s.id)).map((s): SkillEntry => {
    const name = `team-${skillSlug(s.name)}`;
    const description = s.purpose.trim() || `Quy chuẩn "${s.name}" của team: làm theo khi làm việc liên quan.`;
    return { name, source: "team", description, text: withName(s.content, name, description) };
  });
  const all = [...folderSkills(o.builtinDir, "studio", ""), ...team, ...folderSkills(join(o.workspaceDir, "skills"), "project", "project-")];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** Writes the turn's plugin folder (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`) afresh; answers it. */
export function materializeSkillPlugin(db: StudioDb, o: { project: ProjectRecord; workspaceDir: string; builtinDir: string; pluginsRoot: string }): string {
  const dir = join(o.pluginsRoot, o.project.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "studio", version: "1.0.0", description: "AG Studio: skill của Studio, của team và của dự án",
  }, null, 2));
  for (const s of projectSkills(db, o)) {
    mkdirSync(join(dir, "skills", s.name), { recursive: true });
    writeFileSync(join(dir, "skills", s.name, "SKILL.md"), s.text);
  }
  return dir;
}
