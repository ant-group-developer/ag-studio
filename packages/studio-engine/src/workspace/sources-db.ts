/**
 * What a project works from (spec 2026-10-10 agent-workspace §4): ag-go projects and videos picked in the web (no more
 * `@folder`), and files uploaded to the workspace. A source belongs to the project (every video can use it) or to one
 * video. ag-go videos are prepared once per project into `inputs/<assetId>/` (`prepared_assets`).
 */
import { randomUUID } from "node:crypto";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { enqueueUsage, sourceUsageEvent } from "./usage-outbox.js";

/**
 * `ag_go_asset`: a video from ag-go; `upload_asset`: a video or photo from someone's computer, kept on the bucket
 * (`footage-upload.ts`). Both are footage: prepared into `inputs/<id>/`, cut into the video, rendered by id.
 */
export type SourceKind = "ag_go_project" | "ag_go_asset" | "upload_asset" | "upload";
export type SourceMediaType = "video" | "image" | "audio" | "document" | "mixed";

/** The kinds of source that are footage of a video. */
export const FOOTAGE_KINDS: readonly SourceKind[] = ["ag_go_asset", "upload_asset"];
export const isFootageKind = (kind: SourceKind): boolean => FOOTAGE_KINDS.includes(kind);
/** The same as an SQL condition on `kind`. */
export const FOOTAGE_KIND_SQL = "kind IN ('ag_go_asset', 'upload_asset')";

export interface SourceRecord {
  id: string; project_id: string; video_id: string | null; kind: SourceKind; ref: string; media_type: SourceMediaType; label: string;
  meta: Record<string, unknown>; added_by: string; added_at: string;
  /** The item of someone's media library it uses (`media-library.ts`); null for ag-go and files kept in the workspace. */
  media_id?: string | null;
}

export interface SourceView {
  id: string; projectId: string; videoId: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string;
  meta: Record<string, unknown>; addedBy: string; addedAt: string; mediaId: string | null;
}

/** A source's meta as an object (anything else stored there reads as empty). */
export const sourceMeta = (s: Pick<SourceRecord, "meta">): Record<string, unknown> =>
  (s.meta && typeof s.meta === "object" && !Array.isArray(s.meta) ? s.meta : {});

export function sourceView(s: SourceRecord): SourceView {
  return {
    id: s.id, projectId: s.project_id, videoId: s.video_id, kind: s.kind, ref: s.ref, mediaType: s.media_type, label: s.label, meta: sourceMeta(s),
    addedBy: s.added_by, addedAt: s.added_at, mediaId: s.media_id ?? null,
  };
}

/**
 * Adds a source; the same ag-go project / video / file added again to the same place is the one already there. An ag-go
 * one actually added is told to ag-go (usage outbox).
 */
export async function addSource(db: StudioDb, p: {
  projectId: string; videoId?: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string; meta?: Record<string, unknown>; addedBy: string;
  mediaId?: string | null;
}, now = new Date().toISOString()): Promise<SourceRecord> {
  const ref = p.ref.trim();
  if (!ref) throw new StudioRunError("invalid", "nguồn thiếu ref");
  return db.tx(async () => {
    const { changes } = await db.run(
      `INSERT INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at, media_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [randomUUID(), p.projectId, p.videoId ?? null, p.kind, ref, p.mediaType, p.label.trim() || ref, JSON.stringify(p.meta ?? {}), p.addedBy, now, p.mediaId ?? null],
    );
    const s = (await db.get<SourceRecord>(
      "SELECT * FROM project_sources WHERE project_id = ? AND COALESCE(video_id, '') = ? AND kind = ? AND ref = ?",
      [p.projectId, p.videoId ?? "", p.kind, ref],
    ))!;
    if (changes > 0) {
      const e = await sourceUsageEvent(db, s, "source_added", s.added_at, s.added_by);
      if (e) await enqueueUsage(db, [e], now);
    }
    return s;
  });
}

export async function getSource(db: StudioDb, id: string): Promise<SourceRecord | undefined> {
  return db.get<SourceRecord>("SELECT * FROM project_sources WHERE id = ?", [id]);
}

/**
 * A project's sources: with `videoId`, the project's own (every video uses them) and that video's; with
 * `projectOnly`, the project's own only; otherwise all of them.
 */
export async function listSources(db: StudioDb, projectId: string, opts: { videoId?: string; projectOnly?: boolean } = {}): Promise<SourceRecord[]> {
  if (opts.videoId) {
    return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? AND (video_id IS NULL OR video_id = ?) ORDER BY added_at, id", [projectId, opts.videoId]);
  }
  if (opts.projectOnly) return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? AND video_id IS NULL ORDER BY added_at, id", [projectId]);
  return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? ORDER BY added_at, id", [projectId]);
}

/** Removes a source; an ag-go one is told to ag-go (usage outbox), `by` being who removed it. */
export async function removeSource(db: StudioDb, id: string, by: string | null = null, now = new Date().toISOString()): Promise<void> {
  await db.tx(async () => {
    const s = await getSource(db, id);
    if (!s) return;
    const e = await sourceUsageEvent(db, s, "source_removed", now, by);
    await db.run("DELETE FROM project_sources WHERE id = ?", [id]);
    if (e) await enqueueUsage(db, [e], now);
  });
}

/** The footage ids a video is made from (ag-go videos and uploads): picked for it alone, in the order they were added. */
export async function videoAssetIds(db: StudioDb, projectId: string, videoId: string): Promise<string[]> {
  return (await db.all<{ ref: string }>(
    `SELECT ref FROM project_sources WHERE project_id = ? AND video_id = ? AND ${FOOTAGE_KIND_SQL} ORDER BY added_at, id`, [projectId, videoId],
  )).map((r) => r.ref);
}

/** The uploaded footage `assetId` of the project (any of its sources: they share the file), if it is one. */
export async function uploadedAsset(db: StudioDb, projectId: string, assetId: string): Promise<SourceRecord | undefined> {
  return db.get<SourceRecord>(
    "SELECT * FROM project_sources WHERE project_id = ? AND kind = 'upload_asset' AND ref = ? ORDER BY added_at, id LIMIT 1", [projectId, assetId],
  );
}

export interface PreparedAsset {
  project_id: string; asset_id: string; status: "ready" | "failed"; name: string | null; duration_s: number | null; width: number | null;
  height: number | null; has_audio: boolean | null; shots: number | null; transcript: boolean; source_kind: string | null; watermarked: boolean | null;
  error: string | null; prepared_at: string;
}

export async function getPrepared(db: StudioDb, projectId: string, assetId: string): Promise<PreparedAsset | undefined> {
  return db.get<PreparedAsset>("SELECT * FROM prepared_assets WHERE project_id = ? AND asset_id = ?", [projectId, assetId]);
}

export async function listPrepared(db: StudioDb, projectId: string): Promise<PreparedAsset[]> {
  return db.all<PreparedAsset>("SELECT * FROM prepared_assets WHERE project_id = ? ORDER BY prepared_at DESC", [projectId]);
}

/** ag-go videos of a project whose prepared file has no audio stream: their clips render silent. */
export async function silentAssetIds(db: StudioDb, projectId: string): Promise<Set<string>> {
  return new Set((await db.all<{ asset_id: string }>(
    "SELECT asset_id FROM prepared_assets WHERE project_id = ? AND has_audio = FALSE", [projectId],
  )).map((r) => r.asset_id));
}

export async function savePrepared(db: StudioDb, p: Omit<PreparedAsset, "prepared_at">, now: string): Promise<void> {
  await db.run(
    `INSERT INTO prepared_assets (project_id, asset_id, status, name, duration_s, width, height, has_audio, shots, transcript, source_kind, watermarked, error, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, asset_id) DO UPDATE SET status = excluded.status, name = excluded.name, duration_s = excluded.duration_s,
       width = excluded.width, height = excluded.height, has_audio = excluded.has_audio, shots = excluded.shots, transcript = excluded.transcript,
       source_kind = excluded.source_kind, watermarked = excluded.watermarked, error = excluded.error, prepared_at = excluded.prepared_at`,
    [p.project_id, p.asset_id, p.status, p.name, p.duration_s, p.width, p.height, p.has_audio, p.shots, p.transcript, p.source_kind, p.watermarked, p.error, now],
  );
}

/**
 * The ag-go projects added to a project, in the order they were added: ag-go's trusted mode for Studio serves the
 * project the videos of these and nothing else, whoever asks (plan 2026-10-24: someone who could download their
 * originals added them).
 */
export async function agGoProjectIds(db: StudioDb, projectId: string): Promise<string[]> {
  return (await db.all<{ ref: string }>(
    "SELECT ref FROM project_sources WHERE project_id = ? AND kind = 'ag_go_project' ORDER BY added_at, id", [projectId],
  )).map((r) => r.ref);
}
