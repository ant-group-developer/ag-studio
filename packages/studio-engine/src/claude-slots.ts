/**
 * Claude slots (spec agent-workspace §agent loop): an agent turn, or a thread summary, holds a `claude` slot through a
 * row of the harness `lease` table (owner `agent:<id>`), so every worker process counts against the same cap. A turn
 * that finds the cap full keeps an `agent-wait:<id>` row: it also counts, so the next slot freed goes to the turn that
 * waited. Rows of a process that died expire and are cleared on the next acquire.
 */
import { newId } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

/** Who holds a slot: an agent turn or a thread summary. */
export type SlotKind = "agent";
const RUNNING: Record<SlotKind, string> = { agent: "agent:" };
const WAITING: Record<SlotKind, string> = { agent: "agent-wait:" };
const isWaiting = (owner: string) => owner.startsWith(WAITING.agent);
/** Lease of a slot; the agent loop heartbeats well within it. */
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

/** Slots in use: turns running, and turns waiting for one. */
export function claudeUsage(db: StudioDb, now?: string): { running: number; waiting: number } {
  const rows = db.all<{ owner: string; resources: string }>(
    now ? "SELECT owner, resources FROM lease WHERE expires_at >= ?" : "SELECT owner, resources FROM lease",
    now ? [now] : [],
  );
  let running = 0; let waiting = 0;
  for (const r of rows) {
    if (!(JSON.parse(r.resources) as string[]).includes("claude")) continue;
    if (isWaiting(r.owner)) waiting += 1; else running += 1;
  }
  return { running, waiting };
}

/**
 * Takes a slot for a turn if fewer than `cap` are running; otherwise records (or refreshes) that the turn waits,
 * and returns false — call again until it returns true.
 */
export function acquireClaudeSlot(db: StudioDb, kind: SlotKind, id: string, cap: number, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS): boolean {
  return db.immediate(() => {
    db.run("DELETE FROM lease WHERE (owner LIKE 'agent:%' OR owner LIKE 'agent-wait:%') AND expires_at < ?", [now]);
    const held = db.get("SELECT 1 FROM lease WHERE owner = ?", [RUNNING[kind] + id]) !== undefined;
    const { running } = claudeUsage(db);
    if (held || running < cap) {
      db.run("DELETE FROM lease WHERE owner = ?", [WAITING[kind] + id]);
      putRow(db, RUNNING[kind] + id, plus(now, leaseSeconds));
      return true;
    }
    putRow(db, WAITING[kind] + id, plus(now, leaseSeconds));
    return false;
  });
}

export function heartbeatClaudeSlot(db: StudioDb, kind: SlotKind, id: string, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS): void {
  db.run("UPDATE lease SET expires_at = ? WHERE owner = ?", [plus(now, leaseSeconds), RUNNING[kind] + id]);
}

/** Gives back the slot (or the place in line). */
export function releaseClaudeSlot(db: StudioDb, kind: SlotKind, id: string): void {
  db.run("DELETE FROM lease WHERE owner IN (?, ?)", [RUNNING[kind] + id, WAITING[kind] + id]);
}

/** Ids holding a slot of this kind right now, to tell an orphaned `running` turn from a live one. */
export function idsHoldingSlots(db: StudioDb, kind: SlotKind): string[] {
  return db.all<{ owner: string }>("SELECT owner FROM lease WHERE owner LIKE ?", [`${RUNNING[kind]}%`]).map((r) => r.owner.slice(RUNNING[kind].length));
}
