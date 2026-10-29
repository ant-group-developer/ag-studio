/**
 * Someone's media library (plan 2026-10-29 P1): every video, photo or audio file a person uploads goes to the bucket
 * under them (`library/studio/users/<owner>/media/<id><ext>`, a link Studio signs) and stays there, never on the
 * server's disk. A project uses an item through a source that points at it (`project_sources.media_id`), so the same
 * file serves any number of projects, and any number of videos of one project, without being uploaded again:
 *
 *   - footage (`upload_asset`, ref = the item's id): prepared once per project into `inputs/<id>/`, or copied from a
 *     project that already prepared it;
 *   - audio (`upload`, ref = `context/audio/<name>`): the voice sample or the music, normalised from the bucket;
 *   - a reference video (`upload`, ref = `context/references/<name>`, `meta.reference`): measured from the bucket.
 *
 * The audio and reference refs look like workspace paths so the agent and the web name them as before; no file is there.
 * An item still used by a project cannot be deleted; a deleted one leaves the bucket with the cleanup sweep.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { AUDIO_MAX_BYTES } from "../audio-import.js";
import type { StudioBucket } from "../bucket.js";
import { StudioRunError } from "../errors.js";
import type { Param, StudioDb } from "../studio-db.js";
import { FOOTAGE_IMAGE_MAX_BYTES, FOOTAGE_VIDEO_MAX_BYTES, footageMedia } from "./footage-upload.js";
import { AUDIO_FILE_EXTS, PROJECT_AUDIO_DIR } from "./project-audio.js";
import { requireProject, requireVideo } from "./project-db.js";
import { addSource, removeSource, type SourceRecord } from "./sources-db.js";
import { REFERENCE_UPLOAD_DIR, REFERENCE_UPLOAD_MAX_BYTES, REFERENCE_VIDEO_EXTS } from "./style-watch.js";

export type MediaKind = "video" | "image" | "audio";
/** What a project uses an item as. */
export type MediaUse = "footage" | "audio" | "reference";

export interface MediaItem {
  id: string; owner_id: string; kind: MediaKind; key: string; name: string; bytes: number; clip_key: string | null;
  created_at: string; deleted_at: string | null;
}

/** An item as the library lists it: where it is used (projects the owner can open or not, by name). */
export interface MediaItemView {
  id: string; kind: MediaKind; name: string; bytes: number; createdAt: string;
  usedIn: { projectId: string; name: string }[];
}

/** The largest file of each kind (a whole video, a photo, a whole music track). */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = { video: FOOTAGE_VIDEO_MAX_BYTES, image: FOOTAGE_IMAGE_MAX_BYTES, audio: AUDIO_MAX_BYTES.music };

/** What a file is, by its extension; null for none of them. */
export function mediaKindOf(name: string): MediaKind | null {
  const ext = extname(name).toLowerCase();
  if ((AUDIO_FILE_EXTS as readonly string[]).includes(ext)) return "audio";
  return footageMedia(name);
}

/** The owner's folder: their id made safe for a key (an auth0 `sub` has `|`), with a hash so two ids never share one. */
export function mediaPrefix(ownerId: string): string {
  const slug = ownerId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  const hash = createHash("sha256").update(ownerId).digest("hex").slice(0, 10);
  return `library/studio/users/${slug}-${hash}/media/`;
}

/** Where a new upload goes: a fresh id (a uuid: the farm's `scan.prep` takes no other) and the file's own extension. */
export function newMediaKey(ownerId: string, name: string): { mediaId: string; key: string; kind: MediaKind } {
  const kind = mediaKindOf(name);
  if (!kind) throw new StudioRunError("invalid", `Chưa nhận loại file ${extname(name) || "(không đuôi)"}`, { code: "file_type" });
  const mediaId = randomUUID();
  return { mediaId, key: `${mediaPrefix(ownerId)}${mediaId}${extname(name).toLowerCase()}`, kind };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id and kind of the upload at `key`, when it is one of the owner's (a key from a browser is checked first). */
export function mediaAt(ownerId: string, key: string): { mediaId: string; kind: MediaKind } | null {
  const prefix = mediaPrefix(ownerId);
  if (!key.startsWith(prefix)) return null;
  const file = key.slice(prefix.length);
  const ext = extname(file);
  const mediaId = file.slice(0, file.length - ext.length);
  const kind = mediaKindOf(file);
  return UUID.test(mediaId) && kind && ext === ext.toLowerCase() ? { mediaId, kind } : null;
}

export async function getMediaItem(db: StudioDb, id: string): Promise<MediaItem | undefined> {
  return db.get<MediaItem>("SELECT * FROM media_items WHERE id = ?", [id]);
}

/** The owner's item `id`, not deleted; `not_found` otherwise (someone else's item is not found either). */
export async function requireMediaItem(db: StudioDb, ownerId: string, id: string): Promise<MediaItem> {
  const item = await getMediaItem(db, id);
  if (!item || item.owner_id !== ownerId || item.deleted_at) throw new StudioRunError("not_found", "Không có file này trong thư viện của bạn", { code: "media_not_found" });
  return item;
}

/**
 * The file a browser put at `key` becomes an item of the owner's library (the same key again is the item already
 * there). Larger than its kind takes: the object is dropped and `invalid` (`file_too_large`).
 */
export async function addMediaItem(db: StudioDb, bucket: StudioBucket, p: { ownerId: string; key: string; name: string }, now = new Date().toISOString()): Promise<MediaItem> {
  const at = mediaAt(p.ownerId, p.key);
  if (!at) throw new StudioRunError("invalid", "Mã tải lên không hợp lệ", { code: "upload_key" });
  const known = await getMediaItem(db, at.mediaId);
  if (known) {
    if (known.owner_id !== p.ownerId || known.key !== p.key || known.deleted_at) throw new StudioRunError("invalid", "Mã tải lên không hợp lệ", { code: "upload_key" });
    return known;
  }
  const head = await bucket.exists(p.key);
  if (!head) throw new StudioRunError("not_found", "Không thấy file đã tải lên: tải lại", { code: "upload_missing" });
  const max = MEDIA_MAX_BYTES[at.kind];
  if (head.size > max) {
    await bucket.deleteMany([p.key]).catch(() => undefined);
    throw new StudioRunError("invalid", `File lớn hơn ${Math.round(max / 1024 ** 2)} MB`, { code: "file_too_large" });
  }
  const name = p.name.trim().slice(0, 255) || `${at.mediaId}${extname(p.key)}`;
  await db.run(
    "INSERT INTO media_items (id, owner_id, kind, key, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [at.mediaId, p.ownerId, at.kind, p.key, name, head.size, now],
  );
  return (await getMediaItem(db, at.mediaId))!;
}

/** The owner's library, newest first: by kind and a part of the name, with the projects each is used in. */
export async function listMediaItems(db: StudioDb, ownerId: string, o: { kind?: MediaKind; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: MediaItemView[]; total: number; bytes: number }> {
  const where = ["owner_id = ?", "deleted_at IS NULL"];
  const params: Param[] = [ownerId];
  if (o.kind) { where.push("kind = ?"); params.push(o.kind); }
  if (o.q?.trim()) { where.push("name ILIKE ?"); params.push(`%${o.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  const sql = where.join(" AND ");
  const totals = await db.get<{ n: number; bytes: number | null }>(`SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM media_items WHERE ${sql}`, params);
  const rows = await db.all<MediaItem>(
    `SELECT * FROM media_items WHERE ${sql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    [...params, Math.min(Math.max(o.limit ?? 60, 1), 200), Math.max(o.offset ?? 0, 0)],
  );
  const used = await mediaUsage(db, rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, bytes: Number(r.bytes), createdAt: r.created_at, usedIn: used.get(r.id) ?? [] })),
    total: Number(totals?.n ?? 0), bytes: Number(totals?.bytes ?? 0),
  };
}

/** The projects each item is used in (by any source of theirs), by name. */
export async function mediaUsage(db: StudioDb, ids: string[]): Promise<Map<string, { projectId: string; name: string }[]>> {
  const out = new Map<string, { projectId: string; name: string }[]>();
  if (!ids.length) return out;
  const rows = await db.all<{ media_id: string; project_id: string; name: string }>(
    `SELECT DISTINCT s.media_id, s.project_id, p.name FROM project_sources s JOIN projects p ON p.id = s.project_id
      WHERE s.media_id IN (${ids.map(() => "?").join(", ")}) ORDER BY p.name`,
    ids,
  );
  for (const r of rows) out.set(r.media_id, [...(out.get(r.media_id) ?? []), { projectId: r.project_id, name: r.name }]);
  return out;
}

/** Renames an item in the library (the projects' sources keep the name they were added under). */
export async function renameMediaItem(db: StudioDb, ownerId: string, id: string, name: string): Promise<MediaItem> {
  await requireMediaItem(db, ownerId, id);
  const clean = name.trim().slice(0, 255);
  if (!clean) throw new StudioRunError("invalid", "Tên không được để trống", { code: "bad_name" });
  await db.run("UPDATE media_items SET name = ? WHERE id = ?", [clean, id]);
  return (await getMediaItem(db, id))!;
}

/**
 * Takes an item out of the library. Refused (`conflict`, `media_in_use` with the projects) while a project uses it:
 * remove it there first. Its file leaves the bucket with the cleanup sweep.
 */
export async function deleteMediaItem(db: StudioDb, ownerId: string, id: string, now = new Date().toISOString()): Promise<void> {
  await requireMediaItem(db, ownerId, id);
  const used = (await mediaUsage(db, [id])).get(id) ?? [];
  if (used.length) {
    throw new StudioRunError("conflict", `File đang được dùng ở ${used.map((u) => `"${u.name}"`).join(", ")}: bỏ khỏi các dự án đó trước`, { code: "media_in_use", projects: used });
  }
  await db.run("UPDATE media_items SET deleted_at = ? WHERE id = ?", [now, id]);
}

/** What an item can be used as: footage (a video or photo), audio, a reference video (≤ 300 MB). */
function checkUse(item: MediaItem, use: MediaUse): void {
  if (use === "footage" && item.kind === "audio") throw new StudioRunError("invalid", `${item.name} là file audio, không làm footage được`, { code: "wrong_use" });
  if (use === "audio" && item.kind !== "audio") throw new StudioRunError("invalid", `${item.name} không phải file audio`, { code: "wrong_use" });
  if (use === "reference") {
    if (item.kind !== "video" || !(REFERENCE_VIDEO_EXTS as readonly string[]).includes(extname(item.key))) {
      throw new StudioRunError("invalid", `Video mẫu phải là file video (${REFERENCE_VIDEO_EXTS.join(", ")})`, { code: "not_video" });
    }
    if (item.bytes > REFERENCE_UPLOAD_MAX_BYTES) throw new StudioRunError("invalid", `Video mẫu lớn hơn ${REFERENCE_UPLOAD_MAX_BYTES / 1024 ** 2} MB`, { code: "file_too_large" });
  }
}

/** A workspace-looking path under `folder` for `name` that no source of the project and no file of its workspace has. */
async function freeRef(db: StudioDb, projectId: string, workspaceDir: string | null, folder: string, name: string): Promise<string> {
  const taken = new Set((await db.all<{ ref: string }>("SELECT ref FROM project_sources WHERE project_id = ? AND ref LIKE ?", [projectId, `${folder}/%`])).map((r) => r.ref));
  const base = name.split(/[\\/]/).pop()!.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim() || "file";
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  for (let n = 1; ; n += 1) {
    const ref = `${folder}/${n === 1 ? base : `${stem} (${n})${ext}`}`;
    if (!taken.has(ref) && !(workspaceDir && existsSync(join(workspaceDir, ...ref.split("/"))))) return ref;
  }
}

/**
 * The owner's items into a project: footage into each of `videoIds` (none: the project's own footage, every video may
 * pick it), audio and reference videos into the project. An item the project already uses the same way is the source
 * already there. Answers the sources, one per item and video.
 */
export async function addMediaToProject(db: StudioDb, p: {
  projectId: string; ownerId: string; mediaIds: string[]; use: MediaUse; videoIds?: string[]; workspaceDir?: string | null;
}, now = new Date().toISOString()): Promise<SourceRecord[]> {
  await requireProject(db, p.projectId);
  const videoIds = [...new Set(p.videoIds ?? [])];
  for (const v of videoIds) {
    const video = await requireVideo(db, v);
    if (video.project_id !== p.projectId) throw new StudioRunError("invalid", "video thuộc dự án khác", { code: "other_project" });
  }
  const items: MediaItem[] = [];
  for (const id of [...new Set(p.mediaIds)]) {
    const item = await requireMediaItem(db, p.ownerId, id);
    checkUse(item, p.use);
    items.push(item);
  }
  const out: SourceRecord[] = [];
  for (const item of items) {
    const meta = { key: item.key, bytes: Number(item.bytes), ...(item.clip_key ? { clip_key: item.clip_key } : {}) };
    if (p.use === "footage") {
      for (const videoId of videoIds.length ? videoIds : [null]) {
        out.push(await addSource(db, {
          projectId: p.projectId, videoId, kind: "upload_asset", ref: item.id, mediaType: item.kind, label: item.name, meta, addedBy: p.ownerId, mediaId: item.id,
        }, now));
      }
      continue;
    }
    const reference = p.use === "reference";
    const already = (await db.all<SourceRecord>(
      "SELECT * FROM project_sources WHERE project_id = ? AND kind = 'upload' AND media_id = ? AND video_id IS NULL ORDER BY added_at, id", [p.projectId, item.id],
    )).find((s) => ((s.meta as Record<string, unknown>)?.reference === true) === reference);
    if (already) { out.push(already); continue; }
    const ref = await freeRef(db, p.projectId, p.workspaceDir ?? null, reference ? REFERENCE_UPLOAD_DIR : PROJECT_AUDIO_DIR, item.name);
    out.push(await addSource(db, {
      projectId: p.projectId, kind: "upload", ref, mediaType: reference ? "video" : "audio", label: item.name,
      meta: { ...meta, ...(reference ? { reference: true } : {}) }, addedBy: p.ownerId, mediaId: item.id,
    }, now));
  }
  return out;
}

/**
 * The videos footage `assetId` of the project is picked for: exactly `videoIds` afterwards (sources added or removed;
 * the project's own row, if any, stays). Answers the videos it is in now.
 */
export async function setFootageVideos(db: StudioDb, p: { projectId: string; assetId: string; videoIds: string[]; by: string }, now = new Date().toISOString()): Promise<string[]> {
  const rows = await db.all<SourceRecord>(
    "SELECT * FROM project_sources WHERE project_id = ? AND kind IN ('ag_go_asset', 'upload_asset') AND ref = ? ORDER BY added_at, id", [p.projectId, p.assetId],
  );
  const first = rows[0];
  if (!first) throw new StudioRunError("not_found", "Dự án không có footage này", { code: "source_not_found" });
  const want = new Set(p.videoIds);
  for (const v of want) {
    const video = await requireVideo(db, v);
    if (video.project_id !== p.projectId) throw new StudioRunError("invalid", "video thuộc dự án khác", { code: "other_project" });
  }
  for (const r of rows) if (r.video_id && !want.has(r.video_id)) await removeSource(db, r.id, p.by, now);
  const have = new Set(rows.map((r) => r.video_id).filter((v): v is string => !!v));
  for (const v of want) {
    if (have.has(v)) continue;
    await addSource(db, {
      projectId: p.projectId, videoId: v, kind: first.kind, ref: first.ref, mediaType: first.media_type, label: first.label,
      meta: first.meta as Record<string, unknown>, addedBy: p.by, mediaId: first.media_id ?? null,
    }, now);
  }
  return [...want];
}

/** A project other than `projectId` that has footage `assetId` prepared and ready, whose files can be copied. */
export async function preparedElsewhere(db: StudioDb, assetId: string, projectId: string): Promise<string | null> {
  const row = await db.get<{ project_id: string }>(
    "SELECT project_id FROM prepared_assets WHERE asset_id = ? AND project_id <> ? AND status = 'ready' ORDER BY prepared_at DESC LIMIT 1", [assetId, projectId],
  );
  return row?.project_id ?? null;
}

/** A source's file on the bucket (an item of someone's library, or older uploaded footage), if it has one. */
export function sourceKey(s: Pick<SourceRecord, "meta">): string | null {
  const m = s.meta as Record<string, unknown> | null;
  return m && typeof m.key === "string" ? m.key : null;
}

/**
 * The file on the bucket a project's audio or reference video is named by (`context/audio/…`, `context/references/…`),
 * or null when the path is no such source (a file of the workspace, or nothing).
 */
export async function projectMediaFile(db: StudioDb, projectId: string, ref: string): Promise<{ sourceId: string; key: string; bytes: number; name: string } | null> {
  const row = await db.get<SourceRecord>(
    "SELECT * FROM project_sources WHERE project_id = ? AND kind = 'upload' AND ref = ? AND media_id IS NOT NULL ORDER BY added_at, id LIMIT 1", [projectId, ref],
  );
  const key = row ? sourceKey(row) : null;
  return row && key ? { sourceId: row.id, key, bytes: Number((row.meta as Record<string, unknown>).bytes) || 0, name: row.label } : null;
}
