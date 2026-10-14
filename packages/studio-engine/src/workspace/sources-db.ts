/**
 * What a project works from (spec 2026-10-10 agent-workspace §4): ag-go projects and videos picked in the web (no more
 * `@folder`), and files uploaded to the workspace. A source belongs to the project (every video can use it) or to one
 * video. ag-go videos are prepared once per project into `inputs/<assetId>/` (`prepared_assets`, migration 0033).
 */
import { randomUUID } from "node:crypto";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { enqueueUsage, sourceUsageEvent } from "./usage-outbox.js";

export type SourceKind = "ag_go_project" | "ag_go_asset" | "upload";
export type SourceMediaType = "video" | "image" | "audio" | "document" | "mixed";

export interface SourceRecord {
  id: string; project_id: string; video_id: string | null; kind: SourceKind; ref: string; media_type: SourceMediaType; label: string;
  meta: string; added_by: string; added_at: string;
}

export interface SourceView {
  id: string; projectId: string; videoId: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string;
  meta: Record<string, unknown>; addedBy: string; addedAt: string;
}

export function sourceView(s: SourceRecord): SourceView {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(s.meta) as Record<string, unknown>; } catch { /* kept empty */ }
  return {
    id: s.id, projectId: s.project_id, videoId: s.video_id, kind: s.kind, ref: s.ref, mediaType: s.media_type, label: s.label, meta,
    addedBy: s.added_by, addedAt: s.added_at,
  };
}

/**
 * Adds a source; the same ag-go project / video / file added again to the same place is the one already there. An ag-go
 * one actually added is told to ag-go (usage outbox).
 */
export function addSource(db: StudioDb, p: {
  projectId: string; videoId?: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string; meta?: Record<string, unknown>; addedBy: string;
}, now = new Date().toISOString()): SourceRecord {
  const ref = p.ref.trim();
  if (!ref) throw new StudioRunError("invalid", "nguồn thiếu ref");
  const { changes } = db.run(
    `INSERT OR IGNORE INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), p.projectId, p.videoId ?? null, p.kind, ref, p.mediaType, p.label.trim() || ref, JSON.stringify(p.meta ?? {}), p.addedBy, now],
  );
  const s = db.get<SourceRecord>(
    "SELECT * FROM project_sources WHERE project_id = ? AND COALESCE(video_id, '') = ? AND kind = ? AND ref = ?",
    [p.projectId, p.videoId ?? "", p.kind, ref],
  )!;
  if (changes > 0) {
    const e = sourceUsageEvent(db, s, "source_added", s.added_at, s.added_by);
    if (e) enqueueUsage(db, [e], now);
  }
  return s;
}

export function getSource(db: StudioDb, id: string): SourceRecord | undefined {
  return db.get<SourceRecord>("SELECT * FROM project_sources WHERE id = ?", [id]);
}

/**
 * A project's sources: with `videoId`, the project's own (every video uses them) and that video's; with
 * `projectOnly`, the project's own only; otherwise all of them.
 */
export function listSources(db: StudioDb, projectId: string, opts: { videoId?: string; projectOnly?: boolean } = {}): SourceRecord[] {
  if (opts.videoId) {
    return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? AND (video_id IS NULL OR video_id = ?) ORDER BY added_at, id", [projectId, opts.videoId]);
  }
  if (opts.projectOnly) return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? AND video_id IS NULL ORDER BY added_at, id", [projectId]);
  return db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? ORDER BY added_at, id", [projectId]);
}

/** Removes a source; an ag-go one is told to ag-go (usage outbox), `by` being who removed it. */
export function removeSource(db: StudioDb, id: string, by: string | null = null, now = new Date().toISOString()): void {
  const s = getSource(db, id);
  if (!s) return;
  const e = sourceUsageEvent(db, s, "source_removed", now, by);
  db.run("DELETE FROM project_sources WHERE id = ?", [id]);
  if (e) enqueueUsage(db, [e], now);
}

/** ag-go video ids a video is made from: picked for it alone, in the order they were added. */
export function videoAssetIds(db: StudioDb, projectId: string, videoId: string): string[] {
  return db.all<{ ref: string }>(
    "SELECT ref FROM project_sources WHERE project_id = ? AND video_id = ? AND kind = 'ag_go_asset' ORDER BY added_at, id", [projectId, videoId],
  ).map((r) => r.ref);
}

export interface PreparedAsset {
  project_id: string; asset_id: string; status: "ready" | "failed"; name: string | null; duration_s: number | null; width: number | null;
  height: number | null; has_audio: number | null; shots: number | null; transcript: number; source_kind: string | null; watermarked: number | null;
  error: string | null; prepared_at: string;
}

export function getPrepared(db: StudioDb, projectId: string, assetId: string): PreparedAsset | undefined {
  return db.get<PreparedAsset>("SELECT * FROM prepared_assets WHERE project_id = ? AND asset_id = ?", [projectId, assetId]);
}

export function listPrepared(db: StudioDb, projectId: string): PreparedAsset[] {
  return db.all<PreparedAsset>("SELECT * FROM prepared_assets WHERE project_id = ? ORDER BY prepared_at DESC", [projectId]);
}

export function savePrepared(db: StudioDb, p: Omit<PreparedAsset, "prepared_at">, now: string): void {
  db.run(
    `INSERT INTO prepared_assets (project_id, asset_id, status, name, duration_s, width, height, has_audio, shots, transcript, source_kind, watermarked, error, prepared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, asset_id) DO UPDATE SET status = excluded.status, name = excluded.name, duration_s = excluded.duration_s,
       width = excluded.width, height = excluded.height, has_audio = excluded.has_audio, shots = excluded.shots, transcript = excluded.transcript,
       source_kind = excluded.source_kind, watermarked = excluded.watermarked, error = excluded.error, prepared_at = excluded.prepared_at`,
    [p.project_id, p.asset_id, p.status, p.name, p.duration_s, p.width, p.height, p.has_audio, p.shots, p.transcript, p.source_kind, p.watermarked, p.error, now],
  );
}

/** The user ag-go is asked as for a project's footage: its owner, else the team's first owner (as `/farm/sign`). */
export function projectActAs(db: StudioDb, projectId: string): string | null {
  return db.get<{ user_id: string | null }>(
    `SELECT COALESCE(p.owner_user_id,
              (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = p.team_id AND tm.role = 'owner' ORDER BY tm.joined_at LIMIT 1)) AS user_id
       FROM projects p WHERE p.id = ?`, [projectId],
  )?.user_id ?? null;
}
