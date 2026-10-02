/**
 * The thumbnails of an episode (migration 0017): every picture a person can pick — clean frames and the kit's
 * suggestions from each render, pictures a person drew words on, uploaded, or brought back from Canva — and which
 * one the episode uses.
 */
import { randomUUID } from "node:crypto";
import { ThumbnailStyleSchema, type StudioExport, type ThumbnailStyle } from "@harness/contracts";
import { StudioRunError } from "./run-control.js";
import type { EpisodeRecord, StudioDb } from "./studio-db.js";

export const THUMBNAIL_KINDS = ["frame", "suggestion", "composed", "upload", "canva", "ai"] as const;
export type ThumbnailKind = (typeof THUMBNAIL_KINDS)[number];
/** Pictures a person made (a frame a person captured is a `frame` they made too). */
export const USER_THUMBNAIL_KINDS: readonly ThumbnailKind[] = ["composed", "upload", "canva"];

/** Made by a person, so theirs to delete and kept by a new render. */
export const madeByPerson = (t: Pick<EpisodeThumbnail, "kind" | "created_by">): boolean =>
  USER_THUMBNAIL_KINDS.includes(t.kind) || t.created_by !== "system";

export interface EpisodeThumbnail {
  id: string; episode_id: string; kind: ThumbnailKind;
  source_run_id: string | null; parent_id: string | null;
  t_s: number | null; asset_id: string | null;
  base_key: string | null; image_key: string;
  text: string | null; style: ThumbnailStyle | null;
  width: number; height: number; size_bytes: number;
  created_by: string; created_at: string;
}

type Row = Omit<EpisodeThumbnail, "style"> & { style: string | null };
const fromRow = (r: Row): EpisodeThumbnail => ({ ...r, style: r.style ? ThumbnailStyleSchema.parse(JSON.parse(r.style)) : null });

export type NewThumbnail = Omit<EpisodeThumbnail, "id" | "created_at"> & { id?: string; created_at?: string };

/** Insert a picture; the same `image_key` twice keeps the first row (a retried stage registers nothing new). */
export function insertThumbnail(db: StudioDb, t: NewThumbnail): EpisodeThumbnail {
  db.run(
    `INSERT OR IGNORE INTO episode_thumbnails (id, episode_id, kind, source_run_id, parent_id, t_s, asset_id, base_key, image_key, text, style,
       width, height, size_bytes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.id ?? randomUUID(), t.episode_id, t.kind, t.source_run_id, t.parent_id, t.t_s, t.asset_id, t.base_key, t.image_key, t.text,
      t.style ? JSON.stringify(t.style) : null, t.width, t.height, t.size_bytes, t.created_by, t.created_at ?? new Date().toISOString()],
  );
  return fromRow(db.get<Row>("SELECT * FROM episode_thumbnails WHERE image_key = ?", [t.image_key])!);
}

/** In the order they were made (a render's frames in time order). */
export function listThumbnails(db: StudioDb, episodeId: string): EpisodeThumbnail[] {
  return db.all<Row>("SELECT * FROM episode_thumbnails WHERE episode_id = ? ORDER BY created_at, t_s, image_key", [episodeId]).map(fromRow);
}

export function getThumbnail(db: StudioDb, episodeId: string, id: string): EpisodeThumbnail | null {
  const r = db.get<Row>("SELECT * FROM episode_thumbnails WHERE id = ? AND episode_id = ?", [id, episodeId]);
  return r ? fromRow(r) : null;
}

export function requireThumbnail(db: StudioDb, episodeId: string, id: string): EpisodeThumbnail {
  const t = getThumbnail(db, episodeId, id);
  if (!t) throw new StudioRunError("not_found", `thumbnail ${id} không có trong tập`, { code: "not_found" });
  return t;
}

/** The picture the episode uses; null clears it. */
export function selectThumbnail(db: StudioDb, episodeId: string, id: string | null): void {
  if (id !== null) requireThumbnail(db, episodeId, id);
  db.run("UPDATE episodes SET selected_thumbnail_id = ?, updated_at = ? WHERE id = ?", [id, new Date().toISOString(), episodeId]);
}

/** The episode's picture: the selected one, else the first suggestion, else the first frame. */
export function selectedThumbnail(db: StudioDb, ep: Pick<EpisodeRecord, "id" | "selected_thumbnail_id">): EpisodeThumbnail | null {
  const all = listThumbnails(db, ep.id);
  return all.find((t) => t.id === ep.selected_thumbnail_id) ?? all.find((t) => t.kind === "suggestion") ?? all[0] ?? null;
}

/**
 * A render's frames and suggestions replace those of earlier renders of the episode: the earlier rows go (their
 * files stay in the bucket, so pictures a person drew on them keep working) and a pick among them moves to the new
 * first suggestion. Pictures a person made, and a pick of one, stay. Returns how many rows went.
 */
export function replaceRenderThumbnails(db: StudioDb, episodeId: string, runId: string, firstSuggestionId: string | null): number {
  return db.immediate(() => {
    const ep = db.get<{ selected_thumbnail_id: string | null }>("SELECT selected_thumbnail_id FROM episodes WHERE id = ?", [episodeId]);
    const picked = ep?.selected_thumbnail_id ? getThumbnail(db, episodeId, ep.selected_thumbnail_id) : null;
    const stale = (t: EpisodeThumbnail) => !madeByPerson(t) && (t.kind === "frame" || t.kind === "suggestion") && t.source_run_id !== runId;
    if (!picked || stale(picked)) {
      db.run("UPDATE episodes SET selected_thumbnail_id = ?, updated_at = ? WHERE id = ?", [firstSuggestionId, new Date().toISOString(), episodeId]);
    }
    return db.run(
      `DELETE FROM episode_thumbnails WHERE episode_id = ? AND kind IN ('frame', 'suggestion') AND created_by = 'system'
         AND (source_run_id IS NULL OR source_run_id <> ?)`,
      [episodeId, runId],
    ).changes;
  });
}

/** Delete a picture a person made (a render's frames and suggestions stay); a deleted selection is cleared. */
export function deleteThumbnail(db: StudioDb, episodeId: string, id: string): EpisodeThumbnail {
  const t = requireThumbnail(db, episodeId, id);
  if (!madeByPerson(t)) {
    throw new StudioRunError("invalid", "chỉ xoá được ảnh do người dùng tạo (thêm chữ, chụp, tải lên, từ Canva)", { code: "not_user_made" });
  }
  db.immediate(() => {
    db.run("UPDATE episodes SET selected_thumbnail_id = NULL WHERE id = ? AND selected_thumbnail_id = ?", [episodeId, id]);
    db.run("DELETE FROM episode_thumbnails WHERE id = ?", [id]);
  });
  return t;
}

/**
 * An episode exported before migration 0017 has its 3 thumbnails (words burnt in) only in `export.json`: turn them
 * into suggestion rows once, and the old pick (`selected_thumbnail` index) into the selection.
 */
export function backfillExportThumbnails(db: StudioDb, ep: EpisodeRecord, exp: StudioExport | null, size: { width: number; height: number }): void {
  if (!exp || listThumbnails(db, ep.id).length) return;
  const files = exp.files.filter((f) => f.kind === "thumbnail").sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  const at = Date.now();
  const rows = files.map((f, i) => insertThumbnail(db, {
    episode_id: ep.id, kind: "suggestion", source_run_id: exp.run_id, parent_id: null, t_s: null, asset_id: null, base_key: null,
    image_key: f.key, text: null, style: null, width: size.width, height: size.height, size_bytes: f.size_bytes, created_by: "system",
    created_at: new Date(at + i).toISOString(),
  }));
  const pick = rows[ep.selected_thumbnail ?? 0] ?? rows[0];
  if (pick && !ep.selected_thumbnail_id) selectThumbnail(db, ep.id, pick.id);
}

/** The Canva design a user opened for a thumbnail (migration 0018). */
export interface ThumbnailCanvaDesign { thumbnail_id: string; user_id: string; design_id: string; imported: number; created_at: string; updated_at: string }

export function getCanvaDesign(db: StudioDb, thumbnailId: string, userId: string): ThumbnailCanvaDesign | null {
  return db.get<ThumbnailCanvaDesign>("SELECT * FROM thumbnail_canva_designs WHERE thumbnail_id = ? AND user_id = ?", [thumbnailId, userId]) ?? null;
}

export function saveCanvaDesign(db: StudioDb, d: { thumbnail_id: string; user_id: string; design_id: string; imported: boolean }): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO thumbnail_canva_designs (thumbnail_id, user_id, design_id, imported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (thumbnail_id, user_id) DO UPDATE SET design_id = excluded.design_id, imported = excluded.imported, updated_at = excluded.updated_at`,
    [d.thumbnail_id, d.user_id, d.design_id, d.imported ? 1 : 0, now, now],
  );
}

/** Thumbnails of the episode the user has a Canva design for. */
export function canvaDesignThumbnailIds(db: StudioDb, episodeId: string, userId: string): Set<string> {
  return new Set(db.all<{ thumbnail_id: string }>(
    `SELECT d.thumbnail_id FROM thumbnail_canva_designs d JOIN episode_thumbnails t ON t.id = d.thumbnail_id
     WHERE t.episode_id = ? AND d.user_id = ?`, [episodeId, userId],
  ).map((r) => r.thumbnail_id));
}
