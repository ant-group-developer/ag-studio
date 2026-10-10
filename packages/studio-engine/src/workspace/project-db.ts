/**
 * Projects (one YouTube channel of a team) and the videos added to them one at a time (spec 2026-10-10
 * agent-workspace §3.1, ADR-0001 items 179–181). Rows live in `studio.db` (migration 0030); every write is a single
 * statement or an IMMEDIATE transaction because the API and the worker share the file.
 */
import { randomUUID } from "node:crypto";
import {
  HarnessError, projectSettingsOf, ProjectSettingsSchema, TimelineV4Schema,
  type CreateProject, type ProjectAspect, type ProjectSettings, type TimelineV4, type UpdateProject, type VideoStatus,
} from "@harness/contracts";
import { StudioRunError } from "../errors.js";
import { RevisionConflictError, type StudioDb } from "../studio-db.js";

export interface ProjectRecord {
  id: string; team_id: string; name: string; channel_url: string | null; description: string; language: string;
  aspect: ProjectAspect; settings: string; owner_user_id: string; created_by: string;
  created_at: string; updated_at: string; archived_at: string | null;
}

export interface ProjectListRow extends ProjectRecord {
  video_count: number;
  /** The latest of the project's and its videos' `updated_at`. */
  last_activity_at: string;
}

/** A project as the API answers it. */
export interface ProjectView {
  id: string; teamId: string; name: string; channelUrl: string | null; description: string; language: string;
  aspect: ProjectAspect; settings: ProjectSettings; ownerUserId: string; createdBy: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}

export function projectView(p: ProjectRecord): ProjectView {
  return {
    id: p.id, teamId: p.team_id, name: p.name, channelUrl: p.channel_url, description: p.description, language: p.language,
    aspect: p.aspect, settings: projectSettingsOf(p.settings), ownerUserId: p.owner_user_id, createdBy: p.created_by,
    createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at,
  };
}

export function createProject(db: StudioDb, teamId: string, input: CreateProject, userId: string, now = new Date().toISOString()): ProjectRecord {
  const id = randomUUID();
  db.run(
    `INSERT INTO projects (id, team_id, name, channel_url, description, language, aspect, settings, owner_user_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    [id, teamId, input.name, input.channelUrl ?? null, input.description ?? "", input.language ?? "vi", input.aspect ?? "16:9", userId, userId, now, now],
  );
  return getProject(db, id)!;
}

export function getProject(db: StudioDb, id: string): ProjectRecord | undefined {
  return db.get<ProjectRecord>("SELECT * FROM projects WHERE id = ?", [id]);
}

export function requireProject(db: StudioDb, id: string): ProjectRecord {
  const p = getProject(db, id);
  if (!p) throw new StudioRunError("not_found", `dự án ${id} không tồn tại`);
  return p;
}

/** A team's projects, most recently active first; archived ones only with `{archived: true}` (and then only those). */
export function listProjects(db: StudioDb, teamId: string, opts: { archived?: boolean } = {}): ProjectListRow[] {
  return db.all<ProjectListRow>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM videos v WHERE v.project_id = p.id AND v.archived_at IS NULL) AS video_count,
            MAX(p.updated_at, COALESCE((SELECT MAX(v.updated_at) FROM videos v WHERE v.project_id = p.id), '')) AS last_activity_at
       FROM projects p
      WHERE p.team_id = ? AND (p.archived_at IS NOT NULL) = ?
      ORDER BY last_activity_at DESC, p.created_at DESC`,
    [teamId, opts.archived ? 1 : 0],
  );
}

export function updateProject(db: StudioDb, id: string, patch: UpdateProject, now = new Date().toISOString()): ProjectRecord {
  const current = requireProject(db, id);
  const settings = patch.settings ? JSON.stringify(ProjectSettingsSchema.parse(patch.settings)) : current.settings;
  db.run(
    `UPDATE projects SET name = ?, channel_url = ?, description = ?, language = ?, aspect = ?, settings = ?, updated_at = ? WHERE id = ?`,
    [
      patch.name ?? current.name,
      patch.channelUrl === undefined ? current.channel_url : patch.channelUrl,
      patch.description ?? current.description,
      patch.language ?? current.language,
      patch.aspect ?? current.aspect,
      settings, now, id,
    ],
  );
  return requireProject(db, id);
}

export function archiveProject(db: StudioDb, id: string, now = new Date().toISOString()): void {
  requireProject(db, id);
  db.run("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export interface VideoRecord {
  id: string; project_id: string; idx: number; title: string; status: VideoStatus; created_by: string;
  created_at: string; updated_at: string; archived_at: string | null;
}

export interface VideoView {
  id: string; projectId: string; idx: number; title: string; status: VideoStatus; createdBy: string;
  createdAt: string; updatedAt: string; archivedAt: string | null;
}

export function videoView(v: VideoRecord): VideoView {
  return {
    id: v.id, projectId: v.project_id, idx: v.idx, title: v.title, status: v.status, createdBy: v.created_by,
    createdAt: v.created_at, updatedAt: v.updated_at, archivedAt: v.archived_at,
  };
}

/** The next number in the project (archived videos keep theirs, so a number is never reused). */
export function createVideo(db: StudioDb, projectId: string, input: { title: string; createdBy: string }, now = new Date().toISOString()): VideoRecord {
  requireProject(db, projectId);
  const id = randomUUID();
  db.immediate(() => {
    const next = (db.get<{ n: number | null }>("SELECT MAX(idx) AS n FROM videos WHERE project_id = ?", [projectId])?.n ?? 0) + 1;
    db.run(
      "INSERT INTO videos (id, project_id, idx, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      [id, projectId, next, input.title, input.createdBy, now, now],
    );
    db.run("UPDATE projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  });
  return getVideo(db, id)!;
}

export function getVideo(db: StudioDb, id: string): VideoRecord | undefined {
  return db.get<VideoRecord>("SELECT * FROM videos WHERE id = ?", [id]);
}

export function requireVideo(db: StudioDb, id: string): VideoRecord {
  const v = getVideo(db, id);
  if (!v) throw new StudioRunError("not_found", `video ${id} không tồn tại`);
  return v;
}

/** A project's videos, newest first; archived ones only with `{archived: true}`. */
export function listVideos(db: StudioDb, projectId: string, opts: { archived?: boolean } = {}): VideoRecord[] {
  return db.all<VideoRecord>(
    "SELECT * FROM videos WHERE project_id = ? AND (archived_at IS NOT NULL) = ? ORDER BY idx DESC",
    [projectId, opts.archived ? 1 : 0],
  );
}

export function updateVideo(db: StudioDb, id: string, patch: { title?: string; status?: VideoStatus }, now = new Date().toISOString()): VideoRecord {
  const v = requireVideo(db, id);
  db.run("UPDATE videos SET title = ?, status = ?, updated_at = ? WHERE id = ?", [patch.title ?? v.title, patch.status ?? v.status, now, id]);
  return requireVideo(db, id);
}

export function archiveVideo(db: StudioDb, id: string, now = new Date().toISOString()): void {
  requireVideo(db, id);
  db.run("UPDATE videos SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

// ---------------------------------------------------------------------------
// Timeline revisions (v4 only)
// ---------------------------------------------------------------------------

export interface VideoRevision {
  revision: number; base_revision: number; data: TimelineV4; author_id: string; label: string | null; created_at: string;
}

type RevisionRow = Omit<VideoRevision, "data"> & { data: string };
const REVISION_COLUMNS = "revision, base_revision, data, author_id, label, created_at";

export function latestVideoRevision(db: StudioDb, videoId: string): VideoRevision | null {
  const row = db.get<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM video_revisions WHERE video_id = ? ORDER BY revision DESC LIMIT 1`, [videoId]);
  return row ? { ...row, data: TimelineV4Schema.parse(JSON.parse(row.data)) } : null;
}

export function getVideoRevision(db: StudioDb, videoId: string, revision: number): VideoRevision | null {
  const row = db.get<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM video_revisions WHERE video_id = ? AND revision = ?`, [videoId, revision]);
  return row ? { ...row, data: TimelineV4Schema.parse(JSON.parse(row.data)) } : null;
}

export function listVideoRevisions(db: StudioDb, videoId: string): Omit<VideoRevision, "data">[] {
  return db.all("SELECT revision, base_revision, author_id, label, created_at FROM video_revisions WHERE video_id = ? ORDER BY revision DESC", [videoId]);
}

/** A new revision on top of `baseRevision` (409 `RevisionConflictError` when it is not the latest any more). */
export function saveVideoRevision(
  db: StudioDb, videoId: string, p: { baseRevision: number; data: TimelineV4; authorId: string; label?: string | null },
): { revision: number } {
  const data = TimelineV4Schema.parse(p.data);
  if (data.episode_id !== videoId) throw new HarnessError("SCHEMA_INVALID", `timeline belongs to video ${data.episode_id}`, {});
  return db.immediate(() => {
    const current = db.get<{ r: number | null }>("SELECT MAX(revision) AS r FROM video_revisions WHERE video_id = ?", [videoId])?.r ?? 0;
    if (current !== p.baseRevision) throw new RevisionConflictError(current, p.baseRevision);
    const revision = current + 1;
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO video_revisions (id, video_id, revision, base_revision, data, author_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), videoId, revision, p.baseRevision, JSON.stringify(data), p.authorId, p.label ?? null, now],
    );
    db.run("UPDATE videos SET updated_at = ? WHERE id = ?", [now, videoId]);
    return { revision };
  });
}
