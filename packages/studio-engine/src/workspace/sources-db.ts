/**
 * What a project works from (spec 2026-10-10 agent-workspace §4): ag-go projects and videos picked in the web (no more
 * `@folder`), and files uploaded to the workspace. A source belongs to the project (every video can use it) or to one
 * video. ag-go videos are prepared once per project into `inputs/<assetId>/` (`prepared_assets`).
 */
import { randomUUID } from "node:crypto";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { enqueueUsage, sourceUsageEvent } from "./usage-outbox.js";

export type SourceKind = "ag_go_project" | "ag_go_asset" | "upload";
export type SourceMediaType = "video" | "image" | "audio" | "document" | "mixed";

export interface SourceRecord {
  id: string; project_id: string; video_id: string | null; kind: SourceKind; ref: string; media_type: SourceMediaType; label: string;
  meta: Record<string, unknown>; added_by: string; added_at: string;
}

export interface SourceView {
  id: string; projectId: string; videoId: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string;
  meta: Record<string, unknown>; addedBy: string; addedAt: string;
}

/** A source's meta as an object (anything else stored there reads as empty). */
export const sourceMeta = (s: Pick<SourceRecord, "meta">): Record<string, unknown> =>
  (s.meta && typeof s.meta === "object" && !Array.isArray(s.meta) ? s.meta : {});

export function sourceView(s: SourceRecord): SourceView {
  return {
    id: s.id, projectId: s.project_id, videoId: s.video_id, kind: s.kind, ref: s.ref, mediaType: s.media_type, label: s.label, meta: sourceMeta(s),
    addedBy: s.added_by, addedAt: s.added_at,
  };
}

/**
 * Adds a source; the same ag-go project / video / file added again to the same place is the one already there. An ag-go
 * one actually added is told to ag-go (usage outbox).
 */
export async function addSource(db: StudioDb, p: {
  projectId: string; videoId?: string | null; kind: SourceKind; ref: string; mediaType: SourceMediaType; label: string; meta?: Record<string, unknown>; addedBy: string;
}, now = new Date().toISOString()): Promise<SourceRecord> {
  const ref = p.ref.trim();
  if (!ref) throw new StudioRunError("invalid", "nguồn thiếu ref");
  return db.tx(async () => {
    const { changes } = await db.run(
      `INSERT INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [randomUUID(), p.projectId, p.videoId ?? null, p.kind, ref, p.mediaType, p.label.trim() || ref, JSON.stringify(p.meta ?? {}), p.addedBy, now],
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

/** ag-go video ids a video is made from: picked for it alone, in the order they were added. */
export async function videoAssetIds(db: StudioDb, projectId: string, videoId: string): Promise<string[]> {
  return (await db.all<{ ref: string }>(
    "SELECT ref FROM project_sources WHERE project_id = ? AND video_id = ? AND kind = 'ag_go_asset' ORDER BY added_at, id", [projectId, videoId],
  )).map((r) => r.ref);
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

/** The user ag-go is asked as for a project's footage: its owner, else the team's first owner (as `/farm/sign`). */
export async function projectActAs(db: StudioDb, projectId: string): Promise<string | null> {
  return (await db.get<{ user_id: string | null }>(
    `SELECT COALESCE(p.owner_user_id,
              (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = p.team_id AND tm.role = 'owner' ORDER BY tm.joined_at LIMIT 1)) AS user_id
       FROM projects p WHERE p.id = ?`, [projectId],
  ))?.user_id ?? null;
}
