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

export const ASSISTANT_NAME_KEY = "assistant.name";
export const DEFAULT_ASSISTANT_NAME = "Claude";
const ASSISTANT_NAME_MAX = 40;

function isAssistantName(s: unknown): s is string {
  return typeof s === "string" && s.length >= 1 && s.length <= ASSISTANT_NAME_MAX && s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s);
}

/**
 * The name the web shows for the AI (chat replies, the header chip, the Queue). Display only: the model, the CLI and
 * the prompts do not change. A blank name goes back to the default.
 */
export function setAssistantName(db: StudioDb, name: string, by: string, now: string): void {
  const value = name.trim();
  if (!value) {
    db.run("DELETE FROM studio_settings WHERE key = ?", [ASSISTANT_NAME_KEY]);
    return;
  }
  if (!isAssistantName(value)) {
    throw new HarnessError("CONFIG_INVALID", `The AI name must be 1 to ${ASSISTANT_NAME_MAX} characters on one line`, { length: name.trim().length });
  }
  db.run(
    `INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [ASSISTANT_NAME_KEY, JSON.stringify(value), now, by],
  );
}

/** The AI's name on the web: the one saved, else "Claude". */
export function assistantName(db: StudioDb): string {
  const saved = getStudioSetting(db, ASSISTANT_NAME_KEY)?.value;
  return isAssistantName(saved) ? saved : DEFAULT_ASSISTANT_NAME;
}

/** Claude calls at once: the value saved on the web, else `fallback` (env `STUDIO_CLAUDE_MAX_CONCURRENT`, default 20). */
export function claudeMaxConcurrent(db: StudioDb, fallback: number): { value: number; source: "settings" | "env" } {
  const saved = getStudioSetting(db, CLAUDE_MAX_CONCURRENT_KEY)?.value;
  return isClaudeMax(saved) ? { value: saved, source: "settings" } : { value: fallback, source: "env" };
}
