/**
 * How Studio uses ag-go footage, told to ag-go (plan 2026-10-13 P4, contract H3): an ag-go project or video added to or
 * removed from a project, and each video in a finished final render or Premiere export. Events are written to
 * `ag_go_usage_outbox` (migration 0040) next to what they record and sent by the worker later (`usage-send.ts`), so ag-go
 * being down loses nothing; `event_key` is unique, so writing or sending one again never counts twice.
 */
import type { StudioDb } from "../studio-db.js";
import type { SourceRecord } from "./sources-db.js";

export type UsageKind = "source_added" | "source_removed" | "final_render" | "premiere_export";

/** One event as `POST /usage/studio-events` takes it. */
export interface UsageEvent {
  eventKey: string;
  kind: UsageKind;
  occurredAt: string;
  assetId: string | null;
  agGoProjectId: string | null;
  studioProjectId: string;
  studioProjectName: string;
  studioVideoId: string | null;
  studioVideoTitle: string | null;
  studioUserId: string | null;
}

/** Writes events to the outbox, due now; one already there (same key) is left as it is. Returns how many were new. */
export function enqueueUsage(db: StudioDb, events: readonly UsageEvent[], now = new Date().toISOString()): number {
  let added = 0;
  for (const e of events) {
    added += db.run(
      "INSERT OR IGNORE INTO ag_go_usage_outbox (event_key, payload, created_at, next_at) VALUES (?, ?, ?, ?)",
      [e.eventKey, JSON.stringify(e), now, now],
    ).changes;
  }
  return added;
}

function names(db: StudioDb, projectId: string, videoId: string | null): { project: string; video: string | null } {
  const p = db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", [projectId]);
  const v = videoId ? db.get<{ title: string }>("SELECT title FROM videos WHERE id = ?", [videoId]) : undefined;
  return { project: (p?.name ?? "").slice(0, 500), video: v ? v.title.slice(0, 500) : null };
}

/** The event of an ag-go project or video added to (or removed from) a project; null for an uploaded file. */
export function sourceUsageEvent(db: StudioDb, s: SourceRecord, kind: "source_added" | "source_removed", at: string, by: string | null): UsageEvent | null {
  if (s.kind !== "ag_go_asset" && s.kind !== "ag_go_project") return null;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(s.meta) as Record<string, unknown>; } catch { /* none */ }
  const n = names(db, s.project_id, s.video_id);
  return {
    eventKey: `src:${s.id}:${kind === "source_added" ? "added" : "removed"}`, kind, occurredAt: at,
    assetId: s.kind === "ag_go_asset" ? s.ref : null,
    agGoProjectId: s.kind === "ag_go_project" ? s.ref : typeof meta.agGoProjectId === "string" ? meta.agGoProjectId : null,
    studioProjectId: s.project_id, studioProjectName: n.project, studioVideoId: s.video_id, studioVideoTitle: n.video, studioUserId: by,
  };
}

/** One event per ag-go video in a finished final render or Premiere export of a video. */
export function renderUsageEvents(
  db: StudioDb, job: { id: string; project_id: string; created_by: string }, kind: "render_final" | "export_premiere", videoId: string,
  assetIds: readonly string[], at: string,
): UsageEvent[] {
  const n = names(db, job.project_id, videoId);
  return [...new Set(assetIds)].map((assetId) => ({
    eventKey: `job:${job.id}:${assetId}`, kind: kind === "render_final" ? "final_render" : "premiere_export", occurredAt: at, assetId, agGoProjectId: null,
    studioProjectId: job.project_id, studioProjectName: n.project, studioVideoId: videoId, studioVideoTitle: n.video, studioUserId: job.created_by,
  }));
}
