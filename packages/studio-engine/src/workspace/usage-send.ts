/**
 * Sends the usage outbox (`usage-outbox.ts`) to ag-go `POST /usage/studio-events` (contract H3), from the worker every
 * 30 s: the due events in batches of 200, marked sent once ag-go took them. A failed send (ag-go down, a key without
 * `usage:write`: 401/403) keeps them and tries again later, waiting twice as long each time up to an hour. An event ag-go
 * could never take (an id that is not a UUID) is set aside, not retried, so it never holds the others back. A batch is
 * claimed before it is sent (its `next_at` pushed past `USAGE_CLAIM_MS`), so two workers polling at once never send the
 * same event; a worker that stops mid-send leaves its batch due again once the claim runs out.
 */
import type { HarnessLogger } from "@harness/core";
import type { StudioDb } from "../studio-db.js";
import type { UsageEvent } from "./usage-outbox.js";

/** ag-go's side: `AgGoClient.sendUsageEvents`. */
export interface UsageSink {
  send(events: UsageEvent[]): Promise<{ accepted: number; duplicates: number }>;
}

export const USAGE_BATCH = 200;
/** How long a claimed batch is kept from other senders. */
export const USAGE_CLAIM_MS = 10 * 60_000;
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
  // claimed in one statement: rows another sender holds (locked or claimed) are not due here
  const rows = await db.all<{ event_key: string; payload: unknown; attempts: number; due: string; created_at: string; seq: number }>(
    `WITH due AS (
       SELECT event_key, next_at FROM ag_go_usage_outbox WHERE sent_at IS NULL AND next_at <= ?
        ORDER BY next_at, created_at, seq LIMIT ? FOR UPDATE SKIP LOCKED)
     UPDATE ag_go_usage_outbox o SET next_at = ? FROM due WHERE o.event_key = due.event_key
     RETURNING o.event_key, o.payload, o.attempts, due.next_at AS due, o.created_at, o.seq`,
    [at, o.batch ?? USAGE_BATCH, new Date(now.getTime() + USAGE_CLAIM_MS).toISOString()],
  );
  rows.sort((a, b) => a.due.localeCompare(b.due) || a.created_at.localeCompare(b.created_at) || a.seq - b.seq);
  const report: UsageSendReport = { sent: 0, failed: 0, setAside: 0, accepted: 0, duplicates: 0 };
  const setAside = async (key: string, why: string) => {
    await db.run("UPDATE ag_go_usage_outbox SET sent_at = ?, last_error = ? WHERE event_key = ?", [at, `set aside: ${why}`.slice(0, 500), key]);
    report.setAside++;
    o.log?.warn("usage event set aside: ag-go would never take it", { event_key: key, why });
  };
  const ready: { key: string; attempts: number; event: UsageEvent }[] = [];
  for (const r of rows) {
    if (!r.payload || typeof r.payload !== "object" || Array.isArray(r.payload)) { await setAside(r.event_key, "payload is not an event"); continue; }
    const s = sendableUsage(r.payload as UsageEvent);
    if ("problem" in s) await setAside(r.event_key, s.problem);
    else ready.push({ key: r.event_key, attempts: r.attempts, event: s.event });
  }
  if (!ready.length) return report;

  const markSent = async (keys: string[], r: { accepted: number; duplicates: number }) => {
    await db.tx(async () => {
      for (const k of keys) await db.run("UPDATE ag_go_usage_outbox SET sent_at = ?, last_error = NULL WHERE event_key = ?", [at, k]);
    });
    report.sent += keys.length;
    report.accepted += r.accepted;
    report.duplicates += r.duplicates;
  };
  const markFailed = async (items: typeof ready, error: string) => {
    await db.tx(async () => {
      for (const i of items) {
        const next = new Date(now.getTime() + usageBackoffMs(i.attempts + 1)).toISOString();
        await db.run("UPDATE ag_go_usage_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE event_key = ?", [next, error, i.key]);
      }
    });
    report.failed += items.length;
  };

  try {
    await markSent(ready.map((i) => i.key), await sink.send(ready.map((i) => i.event)));
    return report;
  } catch (e) {
    const error = errorText(e);
    // a batch ag-go refuses as a whole: one at a time, so the event it refuses does not hold back the others
    if ((e as { status?: unknown }).status === 400 && ready.length > 1) {
      for (const i of ready) {
        try {
          await markSent([i.key], await sink.send([i.event]));
        } catch (one) {
          if ((one as { status?: unknown }).status === 400) await setAside(i.key, errorText(one));
          else await markFailed([i], errorText(one));
        }
      }
    } else {
      await markFailed(ready, error);
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
