/**
 * Errors kept in the database that would otherwise only be in a container's log (migration 0012, plan 2026-11-07
 * prod-diagnostics P2): what an API request that ended in a 5xx said, a worker's error and warning lines. The admin's
 * diagnostics read them with the other errors of a period. Writing one never fails the caller.
 */
import { randomUUID } from "node:crypto";
import { errorSignature } from "./diagnostics.js";
import type { StudioDb } from "./studio-db.js";

export interface ErrorEvent {
  service: string;
  level: "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
  projectId?: string | null;
  videoId?: string | null;
  requestId?: string | null;
  at?: string;
}

/** The same message from one recorder within this adds to the row before (`repeats`). */
export const ERROR_EVENT_REPEAT_MS = 60_000;
const MAX_MESSAGE = 4000;
const MAX_CONTEXT = 8000;

export interface ErrorEventRecorder {
  /** Records `e`; resolves once written (or dropped). Never throws. */
  record(e: ErrorEvent): Promise<void>;
  /** A worker's logger line (JSON from `createLogger`): its warn and error lines are recorded. */
  fromLogLine(line: string): void;
  /** The database to write to; until then events are dropped (a worker logs before it connects). */
  attach(db: StudioDb): void;
}

const LOG_KEYS = new Set(["level", "time", "msg", "service", "owner"]);
const ID = /^[0-9a-zA-Z-]{8,64}$/;

export function errorEventRecorder(o: { db?: StudioDb; service: string; now?: () => number; onError?: (e: unknown) => void }): ErrorEventRecorder {
  let db = o.db ?? null;
  const now = o.now ?? Date.now;
  const last = new Map<string, { id: string; at: number }>();
  const onError = o.onError ?? ((e: unknown) => process.stderr.write(`error_events: ${e instanceof Error ? e.message : String(e)}\n`));

  async function record(e: ErrorEvent): Promise<void> {
    if (!db) return;
    try {
      const t = e.at ? Date.parse(e.at) : now();
      const at = new Date(t).toISOString();
      const service = e.service || o.service;
      const signature = errorSignature(e.message);
      const key = `${service}|${e.level}|${signature}`;
      const prev = last.get(key);
      if (prev && t - prev.at < ERROR_EVENT_REPEAT_MS) {
        const { changes } = await db.run("UPDATE error_events SET repeats = repeats + 1, last_at = ? WHERE id = ?", [at, prev.id]);
        if (changes) return;
      }
      const id = randomUUID();
      let context = e.context ? JSON.stringify(e.context) : null;
      if (context && context.length > MAX_CONTEXT) context = JSON.stringify({ truncated: context.slice(0, MAX_CONTEXT) });
      await db.run(
        `INSERT INTO error_events (id, at, last_at, service, level, signature, message, context, project_id, video_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [id, at, at, service, e.level, signature, e.message.slice(0, MAX_MESSAGE), context, e.projectId ?? null, e.videoId ?? null, e.requestId ?? null],
      );
      last.set(key, { id, at: t });
      if (last.size > 500) last.delete(last.keys().next().value!);
    } catch (err) {
      onError(err);
    }
  }

  return {
    record,
    attach(d) { db = d; },
    fromLogLine(line) {
      if (!db || !line.includes('"level":"warn"') && !line.includes('"level":"error"')) return;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (entry.level !== "warn" && entry.level !== "error") return;
      const context = Object.fromEntries(Object.entries(entry).filter(([k]) => !LOG_KEYS.has(k)));
      const pick = (...keys: string[]) => {
        for (const k of keys) { const v = entry[k]; if (typeof v === "string" && ID.test(v)) return v; }
        return null;
      };
      const detail = typeof entry.error === "string" ? `: ${entry.error}` : "";
      void record({
        service: typeof entry.service === "string" ? entry.service : o.service,
        level: entry.level,
        message: `${String(entry.msg ?? "")}${detail}`,
        context,
        projectId: pick("projectId", "project_id", "project"),
        videoId: pick("videoId", "video_id", "video"),
        ...(typeof entry.time === "string" ? { at: entry.time } : {}),
      });
    },
  };
}

/** Rows of the activity log's age go with it (`cleanup`). */
export async function sweepErrorEvents(db: StudioDb, cutoff: string): Promise<number> {
  return (await db.run("DELETE FROM error_events WHERE at < ?", [cutoff])).changes;
}
