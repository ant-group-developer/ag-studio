/**
 * Claude accounts (plan 2026-10-30, migration 0007): Studio admins add accounts (a `claude setup-token` each, sealed
 * with `secret-box.ts`) and give each team the ones its agent runs on, in order. A team with none uses `default`, the
 * env's token. An account that hits its plan's limit is not used again before `rate_limited_until`; a team whose
 * accounts are all there waits (it never borrows `default`).
 */
import { randomUUID } from "node:crypto";
import { HarnessError } from "@harness/contracts";
import { openSecret, sealSecret } from "./secret-box.js";
import type { StudioDb } from "./studio-db.js";

export const DEFAULT_CLAUDE_ACCOUNT = "default";
/** Waits after an account hits its plan's limit, by hits in a row: 5, 10, 20, 40, then 60 minutes. */
export const ACCOUNT_RATE_LIMIT_BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const NAME_MAX = 60;
const TOKEN_MAX = 2000;

export interface ClaudeAccountRow {
  id: string;
  name: string;
  token_enc: string | null;
  token_hint: string | null;
  max_concurrent: number | null;
  enabled: boolean;
  rate_limited_until: string | null;
  rate_limit_hits: number;
  last_used_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  check_requested_at: string | null;
  checked_at: string | null;
  check_status: "ok" | "rate_limited" | "failed" | null;
  check_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** An account as the web sees it: never the token. */
export interface ClaudeAccountView {
  id: string;
  name: string;
  isDefault: boolean;
  tokenHint: string | null;
  maxConcurrent: number | null;
  enabled: boolean;
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  check: { requestedAt: string | null; at: string | null; status: ClaudeAccountRow["check_status"]; error: string | null };
  teams: { id: string; name: string }[];
  createdAt: string;
}

export function claudeAccountView(r: ClaudeAccountRow, teams: { id: string; name: string }[] = []): ClaudeAccountView {
  return {
    id: r.id, name: r.name, isDefault: r.id === DEFAULT_CLAUDE_ACCOUNT, tokenHint: r.token_hint, maxConcurrent: r.max_concurrent, enabled: r.enabled,
    rateLimitedUntil: r.rate_limited_until, lastUsedAt: r.last_used_at, lastError: r.last_error, lastErrorAt: r.last_error_at,
    check: { requestedAt: r.check_requested_at, at: r.checked_at, status: r.check_status, error: r.check_error },
    teams, createdAt: r.created_at,
  };
}

function checkName(name: string): string {
  const v = name.trim();
  if (!v || v.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(v)) throw new HarnessError("CONFIG_INVALID", `An account name is 1 to ${NAME_MAX} characters on one line`);
  return v;
}

function checkToken(token: string): string {
  const v = token.trim();
  if (!v || v.length > TOKEN_MAX || /\s/.test(v)) throw new HarnessError("CONFIG_INVALID", "The token is the one line `claude setup-token` prints");
  return v;
}

function checkMax(n: number | null): number | null {
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new HarnessError("CONFIG_INVALID", `Turns at once must be a whole number from 1 to 100, got ${n}`);
  return n;
}

function needKey(key: Buffer | null): Buffer {
  if (!key) throw new HarnessError("CONFIG_INVALID", "STUDIO_SECRET_KEY is not set: Studio cannot keep Claude tokens");
  return key;
}

export async function getClaudeAccount(db: StudioDb, id: string): Promise<ClaudeAccountRow | undefined> {
  return db.get<ClaudeAccountRow>("SELECT * FROM claude_accounts WHERE id = ?", [id]);
}

/** Every account, `default` first, with the teams each one serves. */
export async function listClaudeAccounts(db: StudioDb): Promise<ClaudeAccountView[]> {
  const rows = await db.all<ClaudeAccountRow>("SELECT * FROM claude_accounts ORDER BY (id = 'default') DESC, created_at, id");
  const links = await db.all<{ account_id: string; id: string; name: string }>(
    "SELECT l.account_id, t.id, t.name FROM team_claude_accounts l JOIN teams t ON t.id = l.team_id ORDER BY t.name",
  );
  return rows.map((r) => claudeAccountView(r, links.filter((l) => l.account_id === r.id).map(({ id, name }) => ({ id, name }))));
}

export async function createClaudeAccount(db: StudioDb, key: Buffer | null, p: { name: string; token: string; maxConcurrent?: number | null }, by: string, now: string): Promise<ClaudeAccountRow> {
  const token = checkToken(p.token);
  const id = randomUUID();
  await db.run(
    `INSERT INTO claude_accounts (id, name, token_enc, token_hint, max_concurrent, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, checkName(p.name), sealSecret(needKey(key), token), token.slice(-4), checkMax(p.maxConcurrent ?? null), by, now, now],
  );
  return (await getClaudeAccount(db, id))!;
}

/** Name, turns at once, on/off, a new token. `default`'s token stays the env's. */
export async function updateClaudeAccount(db: StudioDb, key: Buffer | null, id: string, p: {
  name?: string; token?: string; maxConcurrent?: number | null; enabled?: boolean;
}, now: string): Promise<ClaudeAccountRow> {
  const row = await getClaudeAccount(db, id);
  if (!row) throw new HarnessError("NOT_FOUND", "Claude account not found", { id });
  if (p.token !== undefined && id === DEFAULT_CLAUDE_ACCOUNT) throw new HarnessError("CONFIG_INVALID", "The default account's token is CLAUDE_CODE_OAUTH_TOKEN of the server");
  const sets: string[] = [];
  const params: (string | number | boolean | null)[] = [];
  if (p.name !== undefined) { sets.push("name = ?"); params.push(checkName(p.name)); }
  if (p.maxConcurrent !== undefined) { sets.push("max_concurrent = ?"); params.push(checkMax(p.maxConcurrent)); }
  if (p.enabled !== undefined) { sets.push("enabled = ?"); params.push(p.enabled); }
  if (p.token !== undefined) {
    const token = checkToken(p.token);
    // a new token is a new start: what the old one hit says nothing of it
    sets.push("token_enc = ?", "token_hint = ?", "rate_limited_until = NULL", "rate_limit_hits = 0", "last_error = NULL", "last_error_at = NULL", "check_status = NULL", "checked_at = NULL");
    params.push(sealSecret(needKey(key), token), token.slice(-4));
  }
  if (sets.length) await db.run(`UPDATE claude_accounts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now, id]);
  return (await getClaudeAccount(db, id))!;
}

/** Teams that ran on it go back to their other accounts, or to `default`. */
export async function deleteClaudeAccount(db: StudioDb, id: string): Promise<void> {
  if (id === DEFAULT_CLAUDE_ACCOUNT) throw new HarnessError("CONFIG_INVALID", "The default account cannot be deleted");
  const res = await db.run("DELETE FROM claude_accounts WHERE id = ?", [id]);
  if (!res.changes) throw new HarnessError("NOT_FOUND", "Claude account not found", { id });
}

/** "Kiểm tra": a worker makes one tiny call on it (`claimAccountCheck`) and writes how it went. */
export async function requestClaudeAccountCheck(db: StudioDb, id: string, now: string): Promise<ClaudeAccountRow> {
  const res = await db.run("UPDATE claude_accounts SET check_requested_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  if (!res.changes) throw new HarnessError("NOT_FOUND", "Claude account not found", { id });
  return (await getClaudeAccount(db, id))!;
}

/** The account a check was asked for and not made yet; it is marked taken (checked_at) so one worker makes it. */
export async function claimAccountCheck(db: StudioDb, now: string): Promise<ClaudeAccountRow | undefined> {
  return db.tx(async () => {
    const row = await db.get<ClaudeAccountRow>(
      "SELECT * FROM claude_accounts WHERE check_requested_at IS NOT NULL AND (checked_at IS NULL OR checked_at < check_requested_at) ORDER BY check_requested_at LIMIT 1",
    );
    if (!row) return undefined;
    await db.run("UPDATE claude_accounts SET checked_at = ?, check_status = NULL, check_error = NULL WHERE id = ?", [now, row.id]);
    return row;
  });
}

export async function finishAccountCheck(db: StudioDb, id: string, status: "ok" | "rate_limited" | "failed", error: string | null, now: string): Promise<void> {
  await db.run("UPDATE claude_accounts SET check_status = ?, check_error = ?, checked_at = ? WHERE id = ?", [status, error?.slice(0, 500) ?? null, now, id]);
  if (status === "ok") await noteAccountWorked(db, id, now);
  else if (status === "rate_limited") await noteAccountRateLimited(db, id, now);
  else await noteAccountError(db, id, error ?? "failed", now);
}

/** The token a turn on this account runs with: `default` → the env's; null when it cannot be opened. */
export function claudeAccountToken(row: ClaudeAccountRow, key: Buffer | null, env: Record<string, string | undefined>): string | null {
  if (row.id === DEFAULT_CLAUDE_ACCOUNT) return env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  if (!row.token_enc || !key) return null;
  try { return openSecret(key, row.token_enc); } catch { return null; }
}

/** The team's accounts in order (none: it uses `default`). */
export async function teamClaudeAccountIds(db: StudioDb, teamId: string): Promise<string[]> {
  return (await db.all<{ account_id: string }>("SELECT account_id FROM team_claude_accounts WHERE team_id = ? ORDER BY position, account_id", [teamId])).map((r) => r.account_id);
}

export async function setTeamClaudeAccounts(db: StudioDb, teamId: string, accountIds: string[]): Promise<string[]> {
  const ids = [...new Set(accountIds)];
  return db.tx(async () => {
    if (!(await db.get("SELECT 1 FROM teams WHERE id = ?", [teamId]))) throw new HarnessError("NOT_FOUND", "Team not found", { teamId });
    for (const id of ids) if (!(await getClaudeAccount(db, id))) throw new HarnessError("NOT_FOUND", "Claude account not found", { id });
    await db.run("DELETE FROM team_claude_accounts WHERE team_id = ?", [teamId]);
    for (const [i, id] of ids.entries()) await db.run("INSERT INTO team_claude_accounts (team_id, account_id, position) VALUES (?, ?, ?)", [teamId, id, i]);
    return ids;
  });
}

/**
 * The accounts a team's turn may run on, in order: its own enabled ones; none (or all turned off): `default`.
 * Rate-limited ones are in the list: `pickClaudeAccount` skips them.
 */
export async function claudeAccountsForTeam(db: StudioDb, teamId: string | null): Promise<ClaudeAccountRow[]> {
  const own = teamId ? await db.all<ClaudeAccountRow>(
    `SELECT a.* FROM team_claude_accounts l JOIN claude_accounts a ON a.id = l.account_id
      WHERE l.team_id = ? AND a.enabled ORDER BY l.position, a.id`, [teamId],
  ) : [];
  if (own.length) return own;
  const fallback = await getClaudeAccount(db, DEFAULT_CLAUDE_ACCOUNT);
  return fallback ? [fallback] : [];
}

export const isRateLimited = (r: Pick<ClaudeAccountRow, "rate_limited_until">, now: string) =>
  !!r.rate_limited_until && Date.parse(r.rate_limited_until) > Date.parse(now);

/**
 * Where a turn goes: the account the thread last ran on while it can take it (the session's cache is there), else the
 * first in order with room. `room(account)` says whether its cap has a free slot. `wait` when none can take it now:
 * `until` is when the first rate-limited one frees up (null: they are only full).
 */
export function pickClaudeAccount(accounts: ClaudeAccountRow[], o: { now: string; sticky?: string | null; room: (a: ClaudeAccountRow) => boolean }):
  { account: ClaudeAccountRow } | { wait: true; until: string | null } {
  const usable = accounts.filter((a) => !isRateLimited(a, o.now));
  const sticky = usable.find((a) => a.id === o.sticky);
  const pick = sticky && o.room(sticky) ? sticky : usable.find((a) => o.room(a));
  if (pick) return { account: pick };
  if (usable.length) return { wait: true, until: null };
  const until = accounts.map((a) => a.rate_limited_until!).sort()[0] ?? null;
  return { wait: true, until };
}

/** The plan's limit: not used again for a while, longer each time in a row. Returns until when. */
export async function noteAccountRateLimited(db: StudioDb, id: string, now: string): Promise<string> {
  return db.tx(async () => {
    const hits = ((await db.get<{ rate_limit_hits: number }>("SELECT rate_limit_hits FROM claude_accounts WHERE id = ?", [id]))?.rate_limit_hits ?? 0) + 1;
    const minutes = ACCOUNT_RATE_LIMIT_BACKOFF_MINUTES[Math.min(hits - 1, ACCOUNT_RATE_LIMIT_BACKOFF_MINUTES.length - 1)]!;
    const until = new Date(Date.parse(now) + minutes * 60_000).toISOString();
    await db.run("UPDATE claude_accounts SET rate_limited_until = ?, rate_limit_hits = ?, last_used_at = ? WHERE id = ?", [until, hits, now, id]);
    return until;
  });
}

/** A turn went through on it: not limited any more, nothing wrong. */
export async function noteAccountWorked(db: StudioDb, id: string, now: string): Promise<void> {
  await db.run("UPDATE claude_accounts SET rate_limited_until = NULL, rate_limit_hits = 0, last_used_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?", [now, id]);
}

export async function noteAccountError(db: StudioDb, id: string, error: string, now: string): Promise<void> {
  await db.run("UPDATE claude_accounts SET last_error = ?, last_error_at = ?, last_used_at = ? WHERE id = ?", [error.slice(0, 500), now, now, id]);
}

/** What the CLI says when the token is wrong, expired or revoked (not the turn's own failure). */
export function looksLikeAuthError(text: string): boolean {
  return /\b401\b|authentication_error|invalid (api key|bearer token|x-api-key)|oauth token (has expired|has been revoked)|please run \/login|not logged in/i.test(text);
}

/** The farm pool a team's jobs run on (`requirements.pool`); null: the shared machines. */
export async function teamFarmPool(db: StudioDb, teamId: string): Promise<string | null> {
  return (await db.get<{ farm_pool: string | null }>("SELECT farm_pool FROM teams WHERE id = ?", [teamId]))?.farm_pool ?? null;
}

export const FARM_POOL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export async function setTeamFarmPool(db: StudioDb, teamId: string, pool: string | null, now: string): Promise<void> {
  const v = pool?.trim() || null;
  if (v !== null && !FARM_POOL_RE.test(v)) throw new HarnessError("CONFIG_INVALID", "A pool name is lower case letters, digits, - and _ (at most 40)");
  const res = await db.run("UPDATE teams SET farm_pool = ?, updated_at = ? WHERE id = ?", [v, now, teamId]);
  if (!res.changes) throw new HarnessError("NOT_FOUND", "Team not found", { teamId });
}
