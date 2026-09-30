/**
 * Studio's own tables in the same SQLite file as the harness state (`studio.db`).
 * Migrations 0008–0011 (GĐ2 adds episodes, episode_revisions, episode_jobs).
 * The API and the worker open it separately; every write is a single statement or an IMMEDIATE
 * transaction so the two processes never interleave half a revision.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HarnessError, TimelineV3Schema, type TimelineV3 } from "@harness/contracts";

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

// ---------------------------------------------------------------------------
// Productions
// ---------------------------------------------------------------------------

export interface ProductionRecord {
  id: string; team_id: string; title: string; status: string;
  brief: string | null; canvas: string | null; run_id: string | null;
  owner_user_id: string | null; target_seconds: number | null; aspect: string | null;
  language: string | null; voice: string | null; music: string | null;
  goal: string | null; audience: string | null; tone: string | null; notes: string | null;
  youtube_channels: string | null; keywords: string | null;
  episode_target_seconds: number | null; max_episodes: number | null;
  trend_report: string | null;
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
/** "Chủ production": the recorded owner, else the team's first owner (productions made before GĐ4). */
export function productionOwner(db: StudioDb, p: ProductionRecord): string | null {
  if (p.owner_user_id) return p.owner_user_id;
  return db.get<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = ? AND role = 'owner' ORDER BY joined_at LIMIT 1", [p.team_id])?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface EpisodeRecord {
  id: string; production_id: string; idx: number; title: string; hook: string; run_id: string | null; plan: string | null;
  youtube: string | null; selected_title: number | null; selected_thumbnail: number | null;
  created_at: string; updated_at: string;
}

export function getEpisode(db: StudioDb, episodeId: string): EpisodeRecord | null {
  return db.get<EpisodeRecord>("SELECT * FROM episodes WHERE id = ?", [episodeId]) ?? null;
}
export function episodeForRun(db: StudioDb, runId: string): EpisodeRecord | null {
  return db.get<EpisodeRecord>("SELECT * FROM episodes WHERE run_id = ?", [runId]) ?? null;
}
export function listEpisodes(db: StudioDb, productionId: string): EpisodeRecord[] {
  return db.all<EpisodeRecord>("SELECT * FROM episodes WHERE production_id = ? ORDER BY idx", [productionId]);
}

/**
 * Replace all episodes of a production with a fresh set (called by studio-spawn-episodes).
 * The deletion is safe because no episode is in a non-terminal state when we get here.
 */
export function replaceEpisodes(db: StudioDb, productionId: string, rows: { id: string; idx: number; title: string; hook: string; plan: string }[]): void {
  db.immediate(() => {
    db.run("DELETE FROM episode_revisions WHERE episode_id IN (SELECT id FROM episodes WHERE production_id = ?)", [productionId]);
    db.run("DELETE FROM episode_jobs WHERE episode_id IN (SELECT id FROM episodes WHERE production_id = ?)", [productionId]);
    db.run("DELETE FROM episodes WHERE production_id = ?", [productionId]);
    const now = new Date().toISOString();
    for (const r of rows) {
      db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [r.id, productionId, r.idx, r.title, r.hook, r.plan, now, now]);
    }
  });
}

export function updateEpisodeRunId(db: StudioDb, episodeId: string, runId: string): void {
  db.run("UPDATE episodes SET run_id = ?, updated_at = ? WHERE id = ?", [runId, new Date().toISOString(), episodeId]);
}

export function saveTrendReport(db: StudioDb, productionId: string, report: unknown): void {
  db.run("UPDATE productions SET trend_report = ?, updated_at = ? WHERE id = ?", [JSON.stringify(report), new Date().toISOString(), productionId]);
}

// ---------------------------------------------------------------------------
// Episode revisions (per-episode timeline revisions)
// ---------------------------------------------------------------------------

export interface EpisodeRevision {
  revision: number; base_revision: number; data: TimelineV3;
  author_id: string; label: string | null; created_at: string;
}

export function latestEpisodeRevision(db: StudioDb, episodeId: string): EpisodeRevision | null {
  const row = db.get<{ revision: number; base_revision: number; data: string; author_id: string; label: string | null; created_at: string }>(
    "SELECT revision, base_revision, data, author_id, label, created_at FROM episode_revisions WHERE episode_id = ? ORDER BY revision DESC LIMIT 1", [episodeId]);
  return row ? { ...row, data: TimelineV3Schema.parse(JSON.parse(row.data)) } : null;
}
export function getEpisodeRevision(db: StudioDb, episodeId: string, revision: number): EpisodeRevision | null {
  const row = db.get<{ revision: number; base_revision: number; data: string; author_id: string; label: string | null; created_at: string }>(
    "SELECT revision, base_revision, data, author_id, label, created_at FROM episode_revisions WHERE episode_id = ? AND revision = ?", [episodeId, revision]);
  return row ? { ...row, data: TimelineV3Schema.parse(JSON.parse(row.data)) } : null;
}
export function listEpisodeRevisions(db: StudioDb, episodeId: string): Omit<EpisodeRevision, "data">[] {
  return db.all("SELECT revision, base_revision, author_id, label, created_at FROM episode_revisions WHERE episode_id = ? ORDER BY revision DESC", [episodeId]);
}

/** Thrown when a save's `base_revision` is not the latest revision any more (the API answers 409). */
export class RevisionConflictError extends Error {
  constructor(readonly current: number, readonly base: number) {
    super(`timeline đã có revision ${current}, bản lưu dựa trên revision ${base}`);
    this.name = "RevisionConflictError";
  }
}

export function saveEpisodeRevision(db: StudioDb, episodeId: string, p: { baseRevision: number; data: TimelineV3; authorId: string; label?: string | null }): { revision: number } {
  const data = TimelineV3Schema.parse(p.data);
  if (data.episode_id !== episodeId) throw new HarnessError("SCHEMA_INVALID", `timeline belongs to episode ${data.episode_id}`, {});
  return db.immediate(() => {
    const current = db.get<{ r: number | null }>("SELECT MAX(revision) AS r FROM episode_revisions WHERE episode_id = ?", [episodeId])?.r ?? 0;
    if (current !== p.baseRevision) throw new RevisionConflictError(current, p.baseRevision);
    const revision = current + 1;
    db.run("INSERT INTO episode_revisions (id, episode_id, revision, base_revision, data, author_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), episodeId, revision, p.baseRevision, JSON.stringify(data), p.authorId, p.label ?? null, new Date().toISOString()]);
    db.run("UPDATE episodes SET updated_at = ? WHERE id = ?", [new Date().toISOString(), episodeId]);
    return { revision };
  });
}

// ---------------------------------------------------------------------------
// Episode jobs (render_preview / export_premiere outside the workflow)
// ---------------------------------------------------------------------------

export interface EpisodeJobRecord {
  id: string; episode_id: string; kind: "render_preview" | "export_premiere";
  status: "queued" | "running" | "completed" | "failed";
  farm_job_id: string | null; request: string; result: string | null; error: string | null;
  created_by: string; created_at: string; updated_at: string;
}

export function insertEpisodeJob(db: StudioDb, p: { id: string; episodeId: string; kind: EpisodeJobRecord["kind"]; request: unknown; userId: string }): void {
  const now = new Date().toISOString();
  db.run("INSERT INTO episode_jobs (id, episode_id, kind, status, request, created_by, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
    [p.id, p.episodeId, p.kind, JSON.stringify(p.request), p.userId, now, now]);
}
export function updateEpisodeJob(db: StudioDb, id: string, patch: Partial<Pick<EpisodeJobRecord, "farm_job_id" | "status" | "result" | "error">>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  db.run(`UPDATE episode_jobs SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
    [...Object.values(patch).map((v) => (v === undefined ? null : v)), new Date().toISOString(), id] as (string | null)[]);
}
export function getEpisodeJob(db: StudioDb, episodeId: string, id: string): EpisodeJobRecord | null {
  return db.get<EpisodeJobRecord>("SELECT * FROM episode_jobs WHERE id = ? AND episode_id = ?", [id, episodeId]) ?? null;
}
