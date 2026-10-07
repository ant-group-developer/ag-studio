/**
 * Claude slots for chat replies (spec local-chat §3.2). Worker stages hold a `claude` slot through their lease row;
 * a chat reply holds one through a lease row of its own (owner `chat:<turn>`), so `claim()` — in the worker, in any worker
 * process — counts both against the same cap. A reply that finds the cap full keeps a `chat-wait:<turn>` row: it
 * also counts against the cap, so a slot freed by a stage is not claimed by the next stage but taken by the reply on
 * its next try. That is how a person's message goes ahead of automatic steps without touching `claim()`.
 * Rows of a process that died expire and the worker's reaper deletes them: their ids are well-formed (the reaper
 * parses every row) but name no stage run or attempt, so the reaper drops them and moves on.
 */
import { newId } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

const RUNNING = "chat:";
const WAITING = "chat-wait:";
/** Lease of a chat slot; the chat loop heartbeats well within it. */
export const CHAT_SLOT_LEASE_SECONDS = 120;

const plus = (now: string, s: number) => new Date(Date.parse(now) + s * 1000).toISOString();

function putRow(db: StudioDb, owner: string, expiresAt: string): void {
  const res = db.run("UPDATE lease SET expires_at = ? WHERE owner = ?", [expiresAt, owner]);
  if (res.changes > 0) return;
  db.run(
    "INSERT INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES (?, ?, ?, ?, 1, '[\"claude\"]')",
    [newId("stage_run"), newId("attempt"), owner, expiresAt],
  );
}

/** Slots in use: replies and stages running, and replies waiting for one. */
export function claudeUsage(db: StudioDb, now?: string): { running: number; waiting: number } {
  const rows = db.all<{ owner: string; resources: string }>(
    now ? "SELECT owner, resources FROM lease WHERE expires_at >= ?" : "SELECT owner, resources FROM lease",
    now ? [now] : [],
  );
  let running = 0; let waiting = 0;
  for (const r of rows) {
    if (!(JSON.parse(r.resources) as string[]).includes("claude")) continue;
    if (r.owner.startsWith(WAITING)) waiting += 1; else running += 1;
  }
  return { running, waiting };
}

/**
 * Takes a slot for a reply if fewer than `cap` are running; otherwise records (or refreshes) that the reply waits,
 * and returns false — call again until it returns true.
 */
export function acquireChatSlot(db: StudioDb, turnId: string, cap: number, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS): boolean {
  return db.immediate(() => {
    db.run("DELETE FROM lease WHERE (owner LIKE 'chat:%' OR owner LIKE 'chat-wait:%') AND expires_at < ?", [now]);
    const held = db.get("SELECT 1 FROM lease WHERE owner = ?", [RUNNING + turnId]) !== undefined;
    const { running } = claudeUsage(db);
    if (held || running < cap) {
      db.run("DELETE FROM lease WHERE owner = ?", [WAITING + turnId]);
      putRow(db, RUNNING + turnId, plus(now, leaseSeconds));
      return true;
    }
    putRow(db, WAITING + turnId, plus(now, leaseSeconds));
    return false;
  });
}

export function heartbeatChatSlot(db: StudioDb, turnId: string, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS): void {
  db.run("UPDATE lease SET expires_at = ? WHERE owner = ?", [plus(now, leaseSeconds), RUNNING + turnId]);
}

/** Gives back the slot (or the place in line) of a reply. */
export function releaseChatSlot(db: StudioDb, turnId: string): void {
  db.run("DELETE FROM lease WHERE owner IN (?, ?)", [RUNNING + turnId, WAITING + turnId]);
}

/** Replies holding a slot right now (by turn id), to tell an orphaned `running` turn from a live one. */
export function chatTurnsHoldingSlots(db: StudioDb): string[] {
  return db.all<{ owner: string }>("SELECT owner FROM lease WHERE owner LIKE 'chat:%'").map((r) => r.owner.slice(RUNNING.length));
}
