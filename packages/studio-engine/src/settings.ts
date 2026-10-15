/**
 * Studio-wide settings edited on the web (migration 0020). The worker reads them on every claim, so a saved value
 * applies without a restart.
 */
import { HarnessError } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

export const CLAUDE_MAX_CONCURRENT_KEY = "claude.max_concurrent";

export interface StudioSetting { value: unknown; updated_at: string; updated_by: string }

export async function getStudioSetting(db: StudioDb, key: string): Promise<StudioSetting | undefined> {
  return db.get<StudioSetting>("SELECT value, updated_at, updated_by FROM studio_settings WHERE key = ?", [key]);
}

function isClaudeMax(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100; }

export async function setClaudeMaxConcurrent(db: StudioDb, n: number, by: string, now: string): Promise<void> {
  if (!isClaudeMax(n)) throw new HarnessError("CONFIG_INVALID", `Claude calls at once must be a whole number from 1 to 100, got ${n}`, { value: n });
  await db.run(
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
export async function setAssistantName(db: StudioDb, name: string, by: string, now: string): Promise<void> {
  const value = name.trim();
  if (!value) {
    await db.run("DELETE FROM studio_settings WHERE key = ?", [ASSISTANT_NAME_KEY]);
    return;
  }
  if (!isAssistantName(value)) {
    throw new HarnessError("CONFIG_INVALID", `The AI name must be 1 to ${ASSISTANT_NAME_MAX} characters on one line`, { length: name.trim().length });
  }
  await db.run(
    `INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [ASSISTANT_NAME_KEY, JSON.stringify(value), now, by],
  );
}

/** The AI's name on the web: the one saved, else "Claude". */
export async function assistantName(db: StudioDb): Promise<string> {
  const saved = (await getStudioSetting(db, ASSISTANT_NAME_KEY))?.value;
  return isAssistantName(saved) ? saved : DEFAULT_ASSISTANT_NAME;
}

/** Claude calls at once: the value saved on the web, else `fallback` (env `STUDIO_CLAUDE_MAX_CONCURRENT`, default 20). */
export async function claudeMaxConcurrent(db: StudioDb, fallback: number): Promise<{ value: number; source: "settings" | "env" }> {
  const saved = (await getStudioSetting(db, CLAUDE_MAX_CONCURRENT_KEY))?.value;
  return isClaudeMax(saved) ? { value: saved, source: "settings" } : { value: fallback, source: "env" };
}

/**
 * YouTube refusing to let a machine download (the bot check, ADR-0001 items 191, 193): remembered for a while so the
 * agent stops proposing reference downloads that would surely fail, pending cards and the Queue warn, and research says
 * why. Each place is remembered apart, under its own key: the Studio server (`youtube.blocked_until`, its own yt-dlp:
 * reference videos and research) and the farm's machines (`youtube.farm_blocked_until`, `studio.reference_fetch`).
 * Written when a download there is refused this way, cleared only when one there succeeds (a farm machine fetching a
 * video says nothing of the server, and the other way round); past `until` it is forgotten.
 */
export const YOUTUBE_BLOCK_KEY = "youtube.blocked_until";
export const YOUTUBE_FARM_BLOCK_KEY = "youtube.farm_blocked_until";
export const YOUTUBE_BLOCK_MS = 6 * 3600_000;

export type YoutubeBlockWhere = "studio" | "farm";

export interface YoutubeBlock {
  /** When it was last seen blocked. */
  blockedAt: string;
  /** Until when Studio assumes it still is. */
  until: string;
  /** Which machines YouTube refused: the Studio server, or the farm's machines. */
  where: YoutubeBlockWhere;
}

const blockKey = (where: YoutubeBlockWhere) => (where === "farm" ? YOUTUBE_FARM_BLOCK_KEY : YOUTUBE_BLOCK_KEY);

export async function noteYoutubeBlocked(db: StudioDb, now: string, where: YoutubeBlockWhere = "studio"): Promise<YoutubeBlock> {
  const block: YoutubeBlock = { blockedAt: now, until: new Date(Date.parse(now) + YOUTUBE_BLOCK_MS).toISOString(), where };
  await db.run(
    `INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'studio')
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [blockKey(where), JSON.stringify(block), now],
  );
  return block;
}

/** A download (or read) went through there: YouTube is not blocking that place any more. */
export async function clearYoutubeBlocked(db: StudioDb, where: YoutubeBlockWhere = "studio"): Promise<void> {
  await db.run("DELETE FROM studio_settings WHERE key = ?", [blockKey(where)]);
}

/** YouTube's block of that place as remembered now; null when none, or past its time. */
export async function youtubeBlock(db: StudioDb, now: string, where: YoutubeBlockWhere = "studio"): Promise<YoutubeBlock | null> {
  const v = (await getStudioSetting(db, blockKey(where)))?.value as Partial<YoutubeBlock> | undefined;
  if (!v || typeof v.until !== "string" || typeof v.blockedAt !== "string") return null;
  return Date.parse(v.until) > Date.parse(now) ? { blockedAt: v.blockedAt, until: v.until, where } : null;
}

/**
 * Where a reference video would be downloaded now: through a farm machine taking `studio.reference_fetch` (`fetchers`
 * > 0) unless the farm is remembered blocked while the Studio server is not; else the Studio server's own yt-dlp.
 * `style_watch` follows it, and the agent and the cards are told from it.
 */
export async function referenceRoute(db: StudioDb, now: string, fetchers: number): Promise<"farm" | "studio"> {
  if (fetchers <= 0) return "studio";
  return await youtubeBlock(db, now, "farm") && !await youtubeBlock(db, now, "studio") ? "studio" : "farm";
}

/**
 * Why a `reference_download` card would surely fail now, else null: the way it would go (`referenceRoute`) is
 * remembered blocked. Studio blocked but a farm machine able to fetch: null (the card goes through the farm). `where`
 * says which: "studio" (no farm machine can take it), "farm" (the farm's machines are blocked too).
 */
export async function referenceDownloadBlock(db: StudioDb, now: string, fetchers: number): Promise<YoutubeBlock | null> {
  return youtubeBlock(db, now, await referenceRoute(db, now, fetchers));
}
