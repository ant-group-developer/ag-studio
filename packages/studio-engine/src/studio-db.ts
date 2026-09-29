/**
 * Studio's own tables (migrations 0008–0010) in the same SQLite file as the harness state (`studio.db`):
 * the API and the worker open it separately; every write here is a single statement or an IMMEDIATE
 * transaction, so the two processes never interleave half a revision.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HarnessError, TimelineV2Schema, type TimelineV2 } from "@harness/contracts";

type Param = string | number | null;

export class StudioDb {
  readonly db: DatabaseSync;
  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.db.exec("PRAGMA busy_timeout = 5000");
  }
  get<T>(sql: string, params: Param[] = []): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, params: Param[] = []): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, params: Param[] = []): { changes: number } { return this.db.prepare(sql).run(...params) as { changes: number }; }
  immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

export interface ProductionRecord {
  id: string; team_id: string; title: string; status: string; brief: string | null; canvas: string | null; run_id: string | null;
  owner_user_id: string | null; target_seconds: number | null; aspect: string | null; language: string | null; voice: string | null; music: string | null;
  created_at: string; updated_at: string;
}

export function getProduction(db: StudioDb, id: string): ProductionRecord | null {
  return db.get<ProductionRecord>("SELECT * FROM productions WHERE id = ?", [id]) ?? null;
}
export function productionForRun(db: StudioDb, runId: string): ProductionRecord | null {
  return db.get<ProductionRecord>("SELECT * FROM productions WHERE run_id = ?", [runId]) ?? null;
}
export function productionSources(db: StudioDb, id: string): string[] {
  return db.all<{ source_id: string }>("SELECT source_id FROM production_sources WHERE production_id = ? ORDER BY added_at, source_id", [id]).map((r) => r.source_id);
}
/** "Chủ production" (plan 3.1): the recorded owner, else the team's first owner (productions made before GĐ4). */
export function productionOwner(db: StudioDb, p: ProductionRecord): string | null {
  if (p.owner_user_id) return p.owner_user_id;
  return db.get<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = ? AND role = 'owner' ORDER BY joined_at LIMIT 1", [p.team_id])?.user_id ?? null;
}

export interface TimelineRevision { revision: number; base_revision: number; data: TimelineV2; author_id: string; label: string | null; created_at: string }

export function latestRevision(db: StudioDb, productionId: string): TimelineRevision | null {
  const row = db.get<{ revision: number; base_revision: number; data: string; author_id: string; label: string | null; created_at: string }>(
    "SELECT revision, base_revision, data, author_id, label, created_at FROM timeline_revisions WHERE production_id = ? ORDER BY revision DESC LIMIT 1", [productionId]);
  return row ? { ...row, data: TimelineV2Schema.parse(JSON.parse(row.data)) } : null;
}
export function getRevision(db: StudioDb, productionId: string, revision: number): TimelineRevision | null {
  const row = db.get<{ revision: number; base_revision: number; data: string; author_id: string; label: string | null; created_at: string }>(
    "SELECT revision, base_revision, data, author_id, label, created_at FROM timeline_revisions WHERE production_id = ? AND revision = ?", [productionId, revision]);
  return row ? { ...row, data: TimelineV2Schema.parse(JSON.parse(row.data)) } : null;
}
export function listRevisions(db: StudioDb, productionId: string): Omit<TimelineRevision, "data">[] {
  return db.all("SELECT revision, base_revision, author_id, label, created_at FROM timeline_revisions WHERE production_id = ? ORDER BY revision DESC", [productionId]);
}

/** Thrown when a save's `base_revision` is not the latest revision any more (the API answers 409). */
export class RevisionConflictError extends Error {
  constructor(readonly current: number, readonly base: number) {
    super(`timeline đã có revision ${current}, bản lưu dựa trên revision ${base}`);
    this.name = "RevisionConflictError";
  }
}

/**
 * Append a revision if and only if `baseRevision` is still the latest (0 = no revision yet). Check and insert
 * run in one IMMEDIATE transaction, so two editors saving at once cannot both win.
 */
export function saveRevision(db: StudioDb, productionId: string, p: { baseRevision: number; data: TimelineV2; authorId: string; label?: string | null }): { revision: number } {
  const data = TimelineV2Schema.parse(p.data);
  if (data.production_id !== productionId) throw new HarnessError("SCHEMA_INVALID", `timeline belongs to production ${data.production_id}`, {});
  return db.immediate(() => {
    const current = db.get<{ r: number | null }>("SELECT MAX(revision) AS r FROM timeline_revisions WHERE production_id = ?", [productionId])?.r ?? 0;
    if (current !== p.baseRevision) throw new RevisionConflictError(current, p.baseRevision);
    const revision = current + 1;
    db.run("INSERT INTO timeline_revisions (id, production_id, revision, base_revision, data, author_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), productionId, revision, p.baseRevision, JSON.stringify(data), p.authorId, p.label ?? null, new Date().toISOString()]);
    db.run("UPDATE productions SET updated_at = ? WHERE id = ?", [new Date().toISOString(), productionId]);
    return { revision };
  });
}
