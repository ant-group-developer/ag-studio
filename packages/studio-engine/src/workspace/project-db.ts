/**
 * Projects (one YouTube channel of a team) and the videos added to them one at a time (spec 2026-10-10
 * agent-workspace §3.1, ADR-0001 items 179–181). Every write of several statements, and every read-then-write, runs in
 * one transaction because the API and the worker share the database.
 */
import { randomUUID } from "node:crypto";
import {
  HarnessError, ProjectSettingsSchema, TextLookSchema, TimelineV4Schema, VIDEO_LOOKS,
  type CreateProject, type ProjectAspect, type ProjectSettings, type TextLook, type TimelineV4, type UpdateProject, type VideoLook, type VideoStatus,
} from "@harness/contracts";
import { StudioRunError } from "../errors.js";
import { RevisionConflictError, type StudioDb } from "../studio-db.js";

export interface ProjectRecord {
  id: string; team_id: string; name: string; channel_url: string | null; description: string; language: string;
  aspect: ProjectAspect; settings: Record<string, unknown>; owner_user_id: string; created_by: string;
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

/** A project's settings, the defaults where they are missing or broken. */
export function projectSettings(p: Pick<ProjectRecord, "settings"> | null | undefined): ProjectSettings {
  const parsed = ProjectSettingsSchema.safeParse(p?.settings ?? {});
  return parsed.success ? parsed.data : ProjectSettingsSchema.parse({});
}

export function projectView(p: ProjectRecord): ProjectView {
  return {
    id: p.id, teamId: p.team_id, name: p.name, channelUrl: p.channel_url, description: p.description, language: p.language,
    aspect: p.aspect, settings: projectSettings(p), ownerUserId: p.owner_user_id, createdBy: p.created_by,
    createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at,
  };
}

export async function createProject(db: StudioDb, teamId: string, input: CreateProject, userId: string, now = new Date().toISOString()): Promise<ProjectRecord> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO projects (id, team_id, name, channel_url, description, language, aspect, settings, owner_user_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    [id, teamId, input.name, input.channelUrl ?? null, input.description ?? "", input.language ?? "vi", input.aspect ?? "16:9", userId, userId, now, now],
  );
  return (await getProject(db, id))!;
}

export async function getProject(db: StudioDb, id: string): Promise<ProjectRecord | undefined> {
  return db.get<ProjectRecord>("SELECT * FROM projects WHERE id = ?", [id]);
}

export async function requireProject(db: StudioDb, id: string): Promise<ProjectRecord> {
  const p = await getProject(db, id);
  if (!p) throw new StudioRunError("not_found", `dự án ${id} không tồn tại`);
  return p;
}

/** A team's projects, most recently active first; archived ones only with `{archived: true}` (and then only those). */
export async function listProjects(db: StudioDb, teamId: string, opts: { archived?: boolean } = {}): Promise<ProjectListRow[]> {
  return db.all<ProjectListRow>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM videos v WHERE v.project_id = p.id AND v.archived_at IS NULL) AS video_count,
            GREATEST(p.updated_at, (SELECT MAX(v.updated_at) FROM videos v WHERE v.project_id = p.id)) AS last_activity_at
       FROM projects p
      WHERE p.team_id = ? AND (p.archived_at IS NOT NULL) = ?
      ORDER BY last_activity_at DESC, p.created_at DESC`,
    [teamId, !!opts.archived],
  );
}

export async function updateProject(db: StudioDb, id: string, patch: UpdateProject, now = new Date().toISOString()): Promise<ProjectRecord> {
  return db.tx(async () => {
    const current = await requireProject(db, id);
    const settings = patch.settings ? ProjectSettingsSchema.parse(patch.settings) : current.settings;
    await db.run(
      `UPDATE projects SET name = ?, channel_url = ?, description = ?, language = ?, aspect = ?, settings = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? current.name,
        patch.channelUrl === undefined ? current.channel_url : patch.channelUrl,
        patch.description ?? current.description,
        patch.language ?? current.language,
        patch.aspect ?? current.aspect,
        JSON.stringify(settings), now, id,
      ],
    );
    return requireProject(db, id);
  });
}

export async function archiveProject(db: StudioDb, id: string, now = new Date().toISOString()): Promise<void> {
  await requireProject(db, id);
  await db.run("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
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
export async function createVideo(db: StudioDb, projectId: string, input: { title: string; createdBy: string }, now = new Date().toISOString()): Promise<VideoRecord> {
  const id = randomUUID();
  await db.tx(async () => {
    await requireProject(db, projectId);
    const next = ((await db.get<{ n: number | null }>("SELECT MAX(idx) AS n FROM videos WHERE project_id = ?", [projectId]))?.n ?? 0) + 1;
    await db.run(
      "INSERT INTO videos (id, project_id, idx, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      [id, projectId, next, input.title, input.createdBy, now, now],
    );
    await db.run("UPDATE projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  });
  return (await getVideo(db, id))!;
}

export async function getVideo(db: StudioDb, id: string): Promise<VideoRecord | undefined> {
  return db.get<VideoRecord>("SELECT * FROM videos WHERE id = ?", [id]);
}

export async function requireVideo(db: StudioDb, id: string): Promise<VideoRecord> {
  const v = await getVideo(db, id);
  if (!v) throw new StudioRunError("not_found", `video ${id} không tồn tại`);
  return v;
}

/** A project's videos, newest first; archived ones only with `{archived: true}`. */
export async function listVideos(db: StudioDb, projectId: string, opts: { archived?: boolean } = {}): Promise<VideoRecord[]> {
  return db.all<VideoRecord>(
    "SELECT * FROM videos WHERE project_id = ? AND (archived_at IS NOT NULL) = ? ORDER BY idx DESC",
    [projectId, !!opts.archived],
  );
}

export async function updateVideo(db: StudioDb, id: string, patch: { title?: string; status?: VideoStatus }, now = new Date().toISOString()): Promise<VideoRecord> {
  return db.tx(async () => {
    const v = await requireVideo(db, id);
    await db.run("UPDATE videos SET title = ?, status = ?, updated_at = ? WHERE id = ?", [patch.title ?? v.title, patch.status ?? v.status, now, id]);
    return requireVideo(db, id);
  });
}

/** What a person picked for a video's words and picture (plan 2026-10-28 P3); null = not picked. */
export interface VideoOwnLook { text_look: TextLook | null; look: VideoLook | null; color_match: boolean | null }

type LookRow = { text_look: unknown; look: string | null; color_match: boolean | null };

function lookOfRow(row: LookRow | undefined): VideoOwnLook {
  const text = row?.text_look ? TextLookSchema.safeParse(typeof row.text_look === "string" ? JSON.parse(row.text_look) : row.text_look) : null;
  return {
    text_look: text?.success ? text.data : null,
    look: row?.look && (VIDEO_LOOKS as readonly string[]).includes(row.look) ? (row.look as VideoLook) : null,
    color_match: typeof row?.color_match === "boolean" ? row.color_match : null,
  };
}

const lookParams = (own: VideoOwnLook) => [own.text_look ? JSON.stringify(TextLookSchema.parse(own.text_look)) : null, own.look, own.color_match];

export async function videoOwnLook(db: StudioDb, videoId: string): Promise<VideoOwnLook> {
  return lookOfRow(await db.get<LookRow>("SELECT text_look, look, color_match FROM videos WHERE id = ?", [videoId]));
}

export async function setVideoOwnLook(db: StudioDb, videoId: string, own: VideoOwnLook, now = new Date().toISOString()): Promise<VideoOwnLook> {
  await requireVideo(db, videoId);
  await db.run("UPDATE videos SET text_look = ?, look = ?, color_match = ?, updated_at = ? WHERE id = ?", [...lookParams(own), now, videoId]);
  return videoOwnLook(db, videoId);
}

/** What a person picked for every video of the project (plan 2026-10-29): a video's own pick wins over it. */
export async function projectOwnLook(db: StudioDb, projectId: string): Promise<VideoOwnLook> {
  return lookOfRow(await db.get<LookRow>("SELECT text_look, look, color_match FROM projects WHERE id = ?", [projectId]));
}

export async function setProjectOwnLook(db: StudioDb, projectId: string, own: VideoOwnLook, now = new Date().toISOString()): Promise<VideoOwnLook> {
  await requireProject(db, projectId);
  await db.run("UPDATE projects SET text_look = ?, look = ?, color_match = ?, updated_at = ? WHERE id = ?", [...lookParams(own), now, projectId]);
  return projectOwnLook(db, projectId);
}

/** What a person picked for a video, each part its own pick else the project's (both null: the plan and branding decide). */
export async function pickedLook(db: StudioDb, videoId: string): Promise<VideoOwnLook> {
  const video = await requireVideo(db, videoId);
  const own = await videoOwnLook(db, videoId);
  const project = await projectOwnLook(db, video.project_id);
  return { text_look: own.text_look ?? project.text_look, look: own.look ?? project.look, color_match: own.color_match ?? project.color_match };
}

export async function archiveVideo(db: StudioDb, id: string, now = new Date().toISOString()): Promise<void> {
  await requireVideo(db, id);
  await db.run("UPDATE videos SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
}

// ---------------------------------------------------------------------------
// Timeline revisions (v4 only)
// ---------------------------------------------------------------------------

export interface VideoRevision {
  revision: number; base_revision: number; data: TimelineV4; author_id: string; label: string | null; created_at: string;
}

type RevisionRow = Omit<VideoRevision, "data"> & { data: unknown };
const REVISION_COLUMNS = "revision, base_revision, data, author_id, label, created_at";

export async function latestVideoRevision(db: StudioDb, videoId: string): Promise<VideoRevision | null> {
  const row = await db.get<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM video_revisions WHERE video_id = ? ORDER BY revision DESC LIMIT 1`, [videoId]);
  return row ? { ...row, data: TimelineV4Schema.parse(row.data) } : null;
}

export async function getVideoRevision(db: StudioDb, videoId: string, revision: number): Promise<VideoRevision | null> {
  const row = await db.get<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM video_revisions WHERE video_id = ? AND revision = ?`, [videoId, revision]);
  return row ? { ...row, data: TimelineV4Schema.parse(row.data) } : null;
}

export async function listVideoRevisions(db: StudioDb, videoId: string): Promise<Omit<VideoRevision, "data">[]> {
  return db.all("SELECT revision, base_revision, author_id, label, created_at FROM video_revisions WHERE video_id = ? ORDER BY revision DESC", [videoId]);
}

/** A new revision on top of `baseRevision` (409 `RevisionConflictError` when it is not the latest any more). */
export async function saveVideoRevision(
  db: StudioDb, videoId: string, p: { baseRevision: number; data: TimelineV4; authorId: string; label?: string | null },
): Promise<{ revision: number }> {
  const data = TimelineV4Schema.parse(p.data);
  if (data.episode_id !== videoId) throw new HarnessError("SCHEMA_INVALID", `timeline belongs to video ${data.episode_id}`, {});
  return db.tx(async () => {
    const current = (await db.get<{ r: number | null }>("SELECT MAX(revision) AS r FROM video_revisions WHERE video_id = ?", [videoId]))?.r ?? 0;
    if (current !== p.baseRevision) throw new RevisionConflictError(current, p.baseRevision);
    const revision = current + 1;
    const now = new Date().toISOString();
    await db.run(
      "INSERT INTO video_revisions (id, video_id, revision, base_revision, data, author_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), videoId, revision, p.baseRevision, JSON.stringify(data), p.authorId, p.label ?? null, now],
    );
    await db.run("UPDATE videos SET updated_at = ? WHERE id = ?", [now, videoId]);
    return { revision };
  });
}
