/**
 * How Studio uses ag-go footage, told to ag-go (plan 2026-10-13 P4, contract H3): an ag-go project or video added to or
 * removed from a project, and each video in a finished final render or Premiere export. Events are written to
 * `ag_go_usage_outbox` next to what they record and sent by the worker later (`usage-send.ts`), so ag-go being down
 * loses nothing; `event_key` is unique, so writing or sending one again never counts twice.
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
export async function enqueueUsage(db: StudioDb, events: readonly UsageEvent[], now = new Date().toISOString()): Promise<number> {
  if (!events.length) return 0;
  return db.tx(async () => {
    let added = 0;
    for (const e of events) {
      added += (await db.run(
        "INSERT INTO ag_go_usage_outbox (event_key, payload, created_at, next_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING",
        [e.eventKey, JSON.stringify(e), now, now],
      )).changes;
    }
    return added;
  });
}

async function names(db: StudioDb, projectId: string, videoId: string | null): Promise<{ project: string; video: string | null }> {
  const p = await db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", [projectId]);
  const v = videoId ? await db.get<{ title: string }>("SELECT title FROM videos WHERE id = ?", [videoId]) : undefined;
  return { project: (p?.name ?? "").slice(0, 500), video: v ? v.title.slice(0, 500) : null };
}

/** The event of an ag-go project or video added to (or removed from) a project; null for an uploaded file. */
export async function sourceUsageEvent(db: StudioDb, s: SourceRecord, kind: "source_added" | "source_removed", at: string, by: string | null): Promise<UsageEvent | null> {
  if (s.kind !== "ag_go_asset" && s.kind !== "ag_go_project") return null;
  const meta: Record<string, unknown> = s.meta && typeof s.meta === "object" ? s.meta : {};
  const n = await names(db, s.project_id, s.video_id);
  return {
    eventKey: `src:${s.id}:${kind === "source_added" ? "added" : "removed"}`, kind, occurredAt: at,
    assetId: s.kind === "ag_go_asset" ? s.ref : null,
    agGoProjectId: s.kind === "ag_go_project" ? s.ref : typeof meta.agGoProjectId === "string" ? meta.agGoProjectId : null,
    studioProjectId: s.project_id, studioProjectName: n.project, studioVideoId: s.video_id, studioVideoTitle: n.video, studioUserId: by,
  };
}

/** One event per ag-go video in a finished final render or Premiere export of a video (footage uploaded to Studio is not ag-go's). */
export async function renderUsageEvents(
  db: StudioDb, job: { id: string; project_id: string; created_by: string }, kind: "render_final" | "export_premiere", videoId: string,
  assetIds: readonly string[], at: string,
): Promise<UsageEvent[]> {
  const n = await names(db, job.project_id, videoId);
  const uploaded = new Set((await db.all<{ ref: string }>("SELECT DISTINCT ref FROM project_sources WHERE project_id = ? AND kind = 'upload_asset'", [job.project_id])).map((r) => r.ref));
  return [...new Set(assetIds)].filter((id) => !uploaded.has(id)).map((assetId) => ({
    eventKey: `job:${job.id}:${assetId}`, kind: kind === "render_final" ? "final_render" : "premiere_export", occurredAt: at, assetId, agGoProjectId: null,
    studioProjectId: job.project_id, studioProjectName: n.project, studioVideoId: videoId, studioVideoTitle: n.video, studioUserId: job.created_by,
  }));
}
