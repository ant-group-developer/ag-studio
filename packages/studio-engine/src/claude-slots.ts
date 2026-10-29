/**
 * Claude slots (spec agent-workspace §agent loop): an agent turn, or a thread summary, holds a `claude` slot through a
 * row of the harness `lease` table (owner `agent:<id>`), so every worker process counts against the same cap. A turn
 * that finds the cap full keeps an `agent-wait:<id>` row: it also counts, so the next slot freed goes to the turn that
 * waited. Rows of a process that died expire and are cleared on the next acquire. A slot taken on a Claude account
 * (plan 2026-10-30) also names it (`claude:<accountId>` in `resources`), so an account's own cap counts across workers.
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

const accountTag = (accountId: string) => `claude:${accountId}`;

async function putRow(db: StudioDb, owner: string, expiresAt: string, accountId?: string): Promise<void> {
  const res = await db.run("UPDATE lease SET expires_at = ? WHERE owner = ?", [expiresAt, owner]);
  if (res.changes > 0) return;
  await db.run(
    "INSERT INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES (?, ?, ?, ?, 1, ?)",
    [newId("stage_run"), newId("attempt"), owner, expiresAt, JSON.stringify(accountId ? ["claude", accountTag(accountId)] : ["claude"])],
  );
}

/** Slots in use: turns running, and turns waiting for one. */
export async function claudeUsage(db: StudioDb, now?: string): Promise<{ running: number; waiting: number }> {
  const rows = await db.all<{ owner: string; resources: unknown }>(
    now ? "SELECT owner, resources FROM lease WHERE expires_at >= ?" : "SELECT owner, resources FROM lease",
    now ? [now] : [],
  );
  let running = 0; let waiting = 0;
  for (const r of rows) {
    if (!Array.isArray(r.resources) || !r.resources.includes("claude")) continue;
    if (isWaiting(r.owner)) waiting += 1; else running += 1;
  }
  return { running, waiting };
}

/** Slots running on each Claude account (`claude:<id>` in `resources`), by account id. */
export async function claudeUsageByAccount(db: StudioDb, now?: string): Promise<Map<string, number>> {
  const rows = await db.all<{ owner: string; resources: unknown }>(
    now ? "SELECT owner, resources FROM lease WHERE expires_at >= ?" : "SELECT owner, resources FROM lease",
    now ? [now] : [],
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!Array.isArray(r.resources) || isWaiting(r.owner)) continue;
    for (const t of r.resources) {
      if (typeof t === "string" && t.startsWith("claude:")) out.set(t.slice(7), (out.get(t.slice(7)) ?? 0) + 1);
    }
  }
  return out;
}

/** The Claude account a slot is taken on, and its own cap (null: only Studio's). */
export interface SlotAccount { id: string; cap: number | null }

/**
 * Takes a slot for a turn if fewer than `cap` are running (and, with `account`, fewer than its own cap run on it);
 * otherwise records (or refreshes) that the turn waits, and returns false — call again until it returns true.
 */
export async function acquireClaudeSlot(
  db: StudioDb, kind: SlotKind, id: string, cap: number, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS, account?: SlotAccount,
): Promise<boolean> {
  return db.tx(async () => {
    await db.run("DELETE FROM lease WHERE (owner LIKE 'agent:%' OR owner LIKE 'agent-wait:%') AND expires_at < ?", [now]);
    const held = (await db.get("SELECT 1 FROM lease WHERE owner = ?", [RUNNING[kind] + id])) !== undefined;
    const { running } = await claudeUsage(db);
    const onAccount = account && account.cap !== null ? (await claudeUsageByAccount(db)).get(account.id) ?? 0 : 0;
    if (held || (running < cap && (!account || account.cap === null || onAccount < account.cap))) {
      await db.run("DELETE FROM lease WHERE owner = ?", [WAITING[kind] + id]);
      await putRow(db, RUNNING[kind] + id, plus(now, leaseSeconds), account?.id);
      return true;
    }
    await putRow(db, WAITING[kind] + id, plus(now, leaseSeconds));
    return false;
  });
}

export async function heartbeatClaudeSlot(db: StudioDb, kind: SlotKind, id: string, now: string, leaseSeconds = CHAT_SLOT_LEASE_SECONDS): Promise<void> {
  await db.run("UPDATE lease SET expires_at = ? WHERE owner = ?", [plus(now, leaseSeconds), RUNNING[kind] + id]);
}

/** Gives back the slot (or the place in line). */
export async function releaseClaudeSlot(db: StudioDb, kind: SlotKind, id: string): Promise<void> {
  await db.run("DELETE FROM lease WHERE owner IN (?, ?)", [RUNNING[kind] + id, WAITING[kind] + id]);
}

/** Ids holding a slot of this kind right now, to tell an orphaned `running` turn from a live one. */
export async function idsHoldingSlots(db: StudioDb, kind: SlotKind): Promise<string[]> {
  return (await db.all<{ owner: string }>("SELECT owner FROM lease WHERE owner LIKE ?", [`${RUNNING[kind]}%`])).map((r) => r.owner.slice(RUNNING[kind].length));
}
