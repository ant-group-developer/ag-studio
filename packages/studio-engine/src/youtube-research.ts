/**
 * Pieces of YouTube research the project crawls use (`workspace/youtube-crawl.ts`): the Data API's address and cache,
 * durations, medians, views per day, title terms. Quota (10 000 units/day by default): `search.list` costs 100 units
 * a page, the other lists 1. Searches are cached for a day (`ResearchCache` in `youtube_cache`, migration 0012).
 */
import type { ResearchVideo } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const CACHE_TTL_MS = 24 * 3600_000;
/** A video counts as a Short below this length. */
export const SHORTS_MAX_SECONDS = 60;

export interface ResearchCache {
  get(key: string): Promise<{ body: string; fetchedAt: string } | null>;
  set(key: string, body: string, fetchedAt: string): Promise<void>;
}

/** The cache in Studio's database, shared by the worker's crawls; the body is JSON (a `jsonb` column). */
export function studioResearchCache(db: StudioDb): ResearchCache {
  return {
    async get(key) {
      const row = await db.get<{ body: string; fetched_at: string }>("SELECT body::text AS body, fetched_at FROM youtube_cache WHERE key = ?", [key]);
      return row ? { body: row.body, fetchedAt: row.fetched_at } : null;
    },
    async set(key, body, fetchedAt) {
      await db.run("INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, ?::jsonb, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at", [key, body, fetchedAt]);
    },
  };
}

// Parsing what a person typed is shared with the harness (core `research-web.ts`).
export { parseChannelInput, type ChannelRef } from "@harness/core";

/** ISO 8601 duration (`PT1H2M3S`, `P1DT2H`) -> seconds; 0 when absent (live streams, premieres). */
export function parseIsoDuration(iso: string | undefined | null): number {
  if (!iso) return 0;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A video as research keeps it, its views per day counted from `now` (at least one day). */
export function researchVideo(v: Omit<ResearchVideo, "views_per_day" | "outlier">, now: Date): ResearchVideo {
  const days = Math.max(1, (now.getTime() - Date.parse(v.published_at)) / 86400_000);
  return { ...v, views_per_day: r2(v.views / days), outlier: false };
}

// Vietnamese function words that say nothing about a title's topic.
const STOPWORDS = new Set([
  "và", "của", "là", "có", "cho", "với", "những", "các", "một", "này", "đó", "được", "không", "thì", "mà", "ở", "tại", "trong",
  "khi", "để", "từ", "đến", "về", "như", "rất", "cũng", "đã", "sẽ", "đang", "ra", "vào", "lên", "xuống", "nè", "nhé", "ạ",
  "the", "a", "an", "of", "and", "to", "in", "for", "on", "with", "is", "at", "by", "from", "how", "what", "this", "that",
]);

/** The words of a title and its two-word phrases, lowercase, without function words and bare numbers. */
export function titleTerms(title: string): string[] {
  const words = title.toLocaleLowerCase("vi").normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Terms seen at least twice, most frequent first (each list counts a term once). */
export function topCounts(items: string[][], limit: number): { term: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const terms of items) for (const t of new Set(terms)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "vi")).slice(0, limit).map(([term, count]) => ({ term, count }));
}

export const DURATION_BUCKETS = ["<1m", "1-5m", "5-10m", "10-20m", "20m+"];

export function durationBucket(seconds: number): string {
  if (seconds < SHORTS_MAX_SECONDS) return "<1m";
  if (seconds < 300) return "1-5m";
  if (seconds < 600) return "5-10m";
  if (seconds < 1200) return "10-20m";
  return "20m+";
}
