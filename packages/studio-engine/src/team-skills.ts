/**
 * Team skills ("quy chuẩn & skill" of a team, migration 0014): markdown a team writes about how it makes videos.
 * Every Claude stage of one of the team's productions gets the enabled ones that apply to its step, read when the
 * call is made (so always the latest; the call log keeps the exact text that was sent).
 */
import { randomUUID } from "node:crypto";
import { TEAM_SKILL_LIMITS, TEAM_SKILL_STEPS, type TeamGuide, type TeamSkillStep } from "@harness/contracts";
import { StudioRunError } from "./run-control.js";
import { episodeForRun, getProduction, productionForRun, type StudioDb } from "./studio-db.js";

export interface TeamSkill {
  id: string; team_id: string; name: string; purpose: string;
  /** Empty = every step. */
  applies_to: TeamSkillStep[];
  content: string; enabled: boolean; position: number;
  created_by: string; updated_by: string; created_at: string; updated_at: string;
}

export interface TeamSkillInput {
  name: string;
  purpose?: string;
  appliesTo?: TeamSkillStep[];
  content: string;
  enabled?: boolean;
  position?: number;
}

interface TeamSkillRow extends Omit<TeamSkill, "applies_to" | "enabled"> { applies_to: string; enabled: number }

const STEPS = new Set<string>(TEAM_SKILL_STEPS);

function fromRow(r: TeamSkillRow): TeamSkill {
  let steps: unknown = [];
  try { steps = JSON.parse(r.applies_to); } catch { steps = []; }
  return {
    ...r,
    applies_to: Array.isArray(steps) ? steps.filter((s): s is TeamSkillStep => typeof s === "string" && STEPS.has(s)) : [],
    enabled: r.enabled === 1,
  };
}

/** The steps in their canonical order, each once. */
function normalizeSteps(steps: readonly string[] | undefined): TeamSkillStep[] {
  const wanted = new Set(steps ?? []);
  for (const s of wanted) if (!STEPS.has(s)) throw new StudioRunError("invalid", `"${s}" không phải một bước AI`, { code: "team_skill_invalid_step", step: s });
  return TEAM_SKILL_STEPS.filter((s) => wanted.has(s));
}

function checkLengths(skill: { name: string; purpose: string; content: string }): void {
  const name = skill.name.trim();
  if (!name || name.length > TEAM_SKILL_LIMITS.name) {
    throw new StudioRunError("invalid", `tên quy chuẩn phải có 1–${TEAM_SKILL_LIMITS.name} ký tự`, { code: "team_skill_too_long", field: "name" });
  }
  if (skill.purpose.length > TEAM_SKILL_LIMITS.purpose) {
    throw new StudioRunError("invalid", `mục đích tối đa ${TEAM_SKILL_LIMITS.purpose} ký tự`, { code: "team_skill_too_long", field: "purpose" });
  }
  if (!skill.content.trim() || skill.content.length > TEAM_SKILL_LIMITS.content) {
    throw new StudioRunError("invalid", `nội dung phải có 1–${TEAM_SKILL_LIMITS.content} ký tự`, { code: "team_skill_too_long", field: "content" });
  }
}

/** Enabled content of the team except `exceptId`, plus `adding`, must stay within the team total. */
function checkTeamTotal(db: StudioDb, teamId: string, exceptId: string | null, adding: number): void {
  const used = db.get<{ n: number | null }>(
    "SELECT SUM(LENGTH(content)) AS n FROM team_skills WHERE team_id = ? AND enabled = 1 AND id != ?", [teamId, exceptId ?? ""],
  )?.n ?? 0;
  if (used + adding > TEAM_SKILL_LIMITS.enabledTotal) {
    throw new StudioRunError("invalid", `các quy chuẩn đang bật của nhóm vượt ${TEAM_SKILL_LIMITS.enabledTotal} ký tự; tắt bớt hoặc rút gọn`, {
      code: "team_skills_too_long", used, adding, limit: TEAM_SKILL_LIMITS.enabledTotal,
    });
  }
}

function checkNameFree(db: StudioDb, teamId: string, name: string, exceptId: string | null): void {
  const taken = db.get<{ id: string }>("SELECT id FROM team_skills WHERE team_id = ? AND name = ? AND id != ?", [teamId, name, exceptId ?? ""]);
  if (taken) throw new StudioRunError("conflict", `nhóm đã có quy chuẩn tên "${name}"`, { code: "team_skill_name_taken" });
}

export function listTeamSkills(db: StudioDb, teamId: string): TeamSkill[] {
  return db.all<TeamSkillRow>("SELECT * FROM team_skills WHERE team_id = ? ORDER BY position, created_at, name", [teamId]).map(fromRow);
}

export function getTeamSkill(db: StudioDb, teamId: string, id: string): TeamSkill | null {
  const row = db.get<TeamSkillRow>("SELECT * FROM team_skills WHERE id = ? AND team_id = ?", [id, teamId]);
  return row ? fromRow(row) : null;
}

function requireSkill(db: StudioDb, teamId: string, id: string): TeamSkill {
  const skill = getTeamSkill(db, teamId, id);
  if (!skill) throw new StudioRunError("not_found", `quy chuẩn ${id} không có trong nhóm`, { code: "not_found" });
  return skill;
}

export function createTeamSkill(db: StudioDb, teamId: string, input: TeamSkillInput, userId: string): TeamSkill {
  const name = input.name.trim();
  const skill = { name, purpose: (input.purpose ?? "").trim(), content: input.content };
  checkLengths(skill);
  const steps = normalizeSteps(input.appliesTo);
  const enabled = input.enabled ?? true;
  const id = randomUUID();
  return db.immediate(() => {
    checkNameFree(db, teamId, name, null);
    if (enabled) checkTeamTotal(db, teamId, null, skill.content.length);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO team_skills (id, team_id, name, purpose, applies_to, content, enabled, position, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, teamId, name, skill.purpose, JSON.stringify(steps), skill.content, enabled ? 1 : 0, input.position ?? 0, userId, userId, now, now],
    );
    return requireSkill(db, teamId, id);
  });
}

export function updateTeamSkill(db: StudioDb, teamId: string, id: string, patch: Partial<TeamSkillInput>, userId: string): TeamSkill {
  return db.immediate(() => {
    const current = requireSkill(db, teamId, id);
    const next = {
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      purpose: patch.purpose !== undefined ? patch.purpose.trim() : current.purpose,
      content: patch.content ?? current.content,
      applies_to: patch.appliesTo !== undefined ? normalizeSteps(patch.appliesTo) : current.applies_to,
      enabled: patch.enabled ?? current.enabled,
      position: patch.position ?? current.position,
    };
    checkLengths(next);
    if (next.name !== current.name) checkNameFree(db, teamId, next.name, id);
    if (next.enabled) checkTeamTotal(db, teamId, id, next.content.length);
    db.run(
      `UPDATE team_skills SET name = ?, purpose = ?, applies_to = ?, content = ?, enabled = ?, position = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND team_id = ?`,
      [next.name, next.purpose, JSON.stringify(next.applies_to), next.content, next.enabled ? 1 : 0, next.position, userId,
        new Date().toISOString(), id, teamId],
    );
    return requireSkill(db, teamId, id);
  });
}

export function deleteTeamSkill(db: StudioDb, teamId: string, id: string): void {
  const res = db.run("DELETE FROM team_skills WHERE id = ? AND team_id = ?", [id, teamId]);
  if (res.changes === 0) throw new StudioRunError("not_found", `quy chuẩn ${id} không có trong nhóm`, { code: "not_found" });
}

/** The enabled skills of a team as prompt guides, in order. */
export function teamGuides(db: StudioDb, teamId: string): TeamGuide[] {
  return listTeamSkills(db, teamId)
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, purpose: s.purpose, applies_to: s.applies_to, content: s.content }));
}

/** The team a run works for: the production of a plan run, or the production of an episode run's episode. */
export function teamIdForRun(db: StudioDb, runId: string): string | null {
  const plan = productionForRun(db, runId);
  if (plan) return plan.team_id;
  const ep = episodeForRun(db, runId);
  return ep ? getProduction(db, ep.production_id)?.team_id ?? null : null;
}

/** The guides every Claude stage of `runId` gets (before picking the ones of its step); [] for an unknown run. */
export function teamGuidesForRun(db: StudioDb, runId: string): TeamGuide[] {
  const teamId = teamIdForRun(db, runId);
  return teamId ? teamGuides(db, teamId) : [];
}
