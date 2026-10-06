/**
 * Studio-wide settings edited on the web (migration 0020). The worker reads them on every claim, so a saved value
 * applies without a restart.
 */
import { HarnessError } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

export const CLAUDE_MAX_CONCURRENT_KEY = "claude.max_concurrent";

export interface StudioSetting { value: unknown; updated_at: string; updated_by: string }

export function getStudioSetting(db: StudioDb, key: string): StudioSetting | undefined {
  const r = db.get<{ value: string; updated_at: string; updated_by: string }>("SELECT value, updated_at, updated_by FROM studio_settings WHERE key = ?", [key]);
  return r ? { value: JSON.parse(r.value), updated_at: r.updated_at, updated_by: r.updated_by } : undefined;
}

function isClaudeMax(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100; }

export function setClaudeMaxConcurrent(db: StudioDb, n: number, by: string, now: string): void {
  if (!isClaudeMax(n)) throw new HarnessError("CONFIG_INVALID", `Claude calls at once must be a whole number from 1 to 100, got ${n}`, { value: n });
  db.run(
    `INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [CLAUDE_MAX_CONCURRENT_KEY, JSON.stringify(n), now, by],
  );
}

/** Claude calls at once: the value saved on the web, else `fallback` (env `STUDIO_CLAUDE_MAX_CONCURRENT`, default 20). */
export function claudeMaxConcurrent(db: StudioDb, fallback: number): { value: number; source: "settings" | "env" } {
  const saved = getStudioSetting(db, CLAUDE_MAX_CONCURRENT_KEY)?.value;
  return isClaudeMax(saved) ? { value: saved, source: "settings" } : { value: fallback, source: "env" };
}
