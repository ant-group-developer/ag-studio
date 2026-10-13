/**
 * Sends the usage outbox (`usage-outbox.ts`) to ag-go `POST /usage/studio-events` (contract H3), from the worker every
 * 30 s: the due events in batches of 200, marked sent once ag-go took them. A failed send (ag-go down, a key without
 * `usage:write`: 401/403) keeps them and tries again later, waiting twice as long each time up to an hour. An event ag-go
 * could never take (an id that is not a UUID) is set aside, not retried, so it never holds the others back.
 */
import type { HarnessLogger } from "@harness/core";
import type { StudioDb } from "../studio-db.js";
import type { UsageEvent } from "./usage-outbox.js";

/** ag-go's side: `AgGoClient.sendUsageEvents`. */
export interface UsageSink {
  send(events: UsageEvent[]): Promise<{ accepted: number; duplicates: number }>;
}

export const USAGE_BATCH = 200;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long after the `attempts`-th failure an event is tried again: 30 s, 1 min, 2 min… at most an hour. */
export function usageBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(attempts, 20) - 1));
}

/** The event as ag-go takes it (an ag-go project id that is not a UUID is left out), or why it never would. */
export function sendableUsage(e: UsageEvent): { event: UsageEvent } | { problem: string } {
  if (!e.eventKey || e.eventKey.length > 200) return { problem: "eventKey" };
  if (e.assetId !== null && !UUID.test(e.assetId)) return { problem: `assetId ${e.assetId} is not a UUID` };
  const agGoProjectId = e.agGoProjectId !== null && UUID.test(e.agGoProjectId) ? e.agGoProjectId : null;
  if (e.assetId === null && agGoProjectId === null) return { problem: "neither assetId nor agGoProjectId" };
  if (!e.studioProjectId || e.studioProjectId.length > 100) return { problem: "studioProjectId" };
  return {
    event: {
      ...e, agGoProjectId, studioProjectName: e.studioProjectName.slice(0, 500), studioVideoId: e.studioVideoId?.slice(0, 100) ?? null,
      studioVideoTitle: e.studioVideoTitle?.slice(0, 500) ?? null, studioUserId: e.studioUserId?.slice(0, 200) ?? null,
    },
  };
}

export interface UsageSendReport { sent: number; failed: number; setAside: number; accepted: number; duplicates: number }

const errorText = (e: unknown): string => {
  const status = (e as { status?: unknown }).status;
  const msg = e instanceof Error ? e.message : String(e);
  return (typeof status === "number" && !msg.includes(String(status)) ? `HTTP ${status}: ${msg}` : msg).slice(0, 500);
};

/** Sends one batch of due events (`batch`, default 200). */
export async function sendDueUsage(db: StudioDb, sink: UsageSink, o: { now?: () => Date; batch?: number; log?: HarnessLogger } = {}): Promise<UsageSendReport> {
  const now = (o.now ?? (() => new Date()))();
  const at = now.toISOString();
  const rows = db.all<{ event_key: string; payload: string; attempts: number }>(
    "SELECT event_key, payload, attempts FROM ag_go_usage_outbox WHERE sent_at IS NULL AND next_at <= ? ORDER BY next_at, created_at, rowid LIMIT ?",
    [at, o.batch ?? USAGE_BATCH],
  );
  const report: UsageSendReport = { sent: 0, failed: 0, setAside: 0, accepted: 0, duplicates: 0 };
  const setAside = (key: string, why: string) => {
    db.run("UPDATE ag_go_usage_outbox SET sent_at = ?, last_error = ? WHERE event_key = ?", [at, `set aside: ${why}`.slice(0, 500), key]);
    report.setAside++;
    o.log?.warn("usage event set aside: ag-go would never take it", { event_key: key, why });
  };
  const ready: { key: string; attempts: number; event: UsageEvent }[] = [];
  for (const r of rows) {
    let parsed: UsageEvent;
    try { parsed = JSON.parse(r.payload) as UsageEvent; } catch { setAside(r.event_key, "payload is not JSON"); continue; }
    const s = sendableUsage(parsed);
    if ("problem" in s) setAside(r.event_key, s.problem);
    else ready.push({ key: r.event_key, attempts: r.attempts, event: s.event });
  }
  if (!ready.length) return report;

  const markSent = (keys: string[], r: { accepted: number; duplicates: number }) => {
    db.immediate(() => {
      for (const k of keys) db.run("UPDATE ag_go_usage_outbox SET sent_at = ?, last_error = NULL WHERE event_key = ?", [at, k]);
    });
    report.sent += keys.length;
    report.accepted += r.accepted;
    report.duplicates += r.duplicates;
  };
  const markFailed = (items: typeof ready, error: string) => {
    db.immediate(() => {
      for (const i of items) {
        const next = new Date(now.getTime() + usageBackoffMs(i.attempts + 1)).toISOString();
        db.run("UPDATE ag_go_usage_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE event_key = ?", [next, error, i.key]);
      }
    });
    report.failed += items.length;
  };

  try {
    markSent(ready.map((i) => i.key), await sink.send(ready.map((i) => i.event)));
    return report;
  } catch (e) {
    const error = errorText(e);
    // a batch ag-go refuses as a whole: one at a time, so the event it refuses does not hold back the others
    if ((e as { status?: unknown }).status === 400 && ready.length > 1) {
      for (const i of ready) {
        try {
          markSent([i.key], await sink.send([i.event]));
        } catch (one) {
          if ((one as { status?: unknown }).status === 400) setAside(i.key, errorText(one));
          else markFailed([i], errorText(one));
        }
      }
    } else {
      markFailed(ready, error);
    }
    if (report.failed) {
      o.log?.warn("usage events not sent to ag-go: tried again later", {
        error, events: report.failed, attempts: Math.min(...ready.map((i) => i.attempts)) + 1,
      });
    }
    return report;
  }
}

/** Every `everyMs` (default 30 s), one round at a time: due batches until one is not full (at most `rounds`). */
export function startUsageSender(o: {
  db: StudioDb; sink: UsageSink; log: HarnessLogger; everyMs?: number; firstMs?: number; rounds?: number; now?: () => Date;
}): { stop: () => void; tick: () => Promise<void> } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let round = 0; round < (o.rounds ?? 25); round++) {
        const r = await sendDueUsage(o.db, o.sink, { log: o.log, ...(o.now ? { now: o.now } : {}) });
        if (r.sent) o.log.info("usage events sent to ag-go", { ...r });
        if (r.failed || r.sent + r.setAside < USAGE_BATCH) break;
      }
    } catch (e) {
      o.log.warn("usage sending failed", { error: e instanceof Error ? e.message : String(e) });
    } finally { running = false; }
  };
  const every = o.everyMs ?? 30_000;
  const first = setTimeout(() => void tick(), o.firstMs ?? Math.min(5_000, every));
  const timer = setInterval(() => void tick(), every);
  return { stop: () => { clearTimeout(first); clearInterval(timer); }, tick };
}
