/**
 * Market research for a series (GĐ5): what the competitor channels publish and what YouTube shows for the
 * series' keywords, from the YouTube Data API v3, turned into `studio.research/v1`.
 *
 * Quota (10 000 units/day by default): `channels.list`, `playlistItems.list`, `videos.list` cost 1 unit a call,
 * `search.list` 100. A channel costs ~3 units, a keyword 2 searches (by views and by relevance) + 1 = 201.
 * `estimateQuota` gives the web the number before anything runs. Keyword searches are cached for 24 h
 * (`ResearchCache`), so re-planning a series the same day costs almost nothing.
 *
 * One failing channel or keyword is recorded on its entry and the research goes on; running out of quota stops
 * every later call (they would all fail the same way).
 */
import type { ChannelRole, ResearchVideo, StudioBrief, StudioResearch } from "@harness/contracts";
import type { StudioDb } from "./studio-db.js";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const SEARCH_UNITS = 100;
/** Search window for keywords (plan: the last 90 days). */
export const KEYWORD_WINDOW_DAYS = 90;
export const CACHE_TTL_MS = 24 * 3600_000;
/** A video counts as a Short below this length. */
export const SHORTS_MAX_SECONDS = 60;
export const OUTLIER_FACTOR = 2;

export interface ResearchCache {
  get(key: string): Promise<{ body: string; fetchedAt: string } | null>;
  set(key: string, body: string, fetchedAt: string): Promise<void>;
}

/** What to research: the team's own channels, the reference channels and the keywords. */
export interface ResearchQuery {
  production_id: string;
  channels: { url: string; role: ChannelRole }[];
  keywords: string[];
}

/** A brief of the old flow names reference channels only. */
export function researchQueryOfBrief(brief: Pick<StudioBrief, "production_id" | "youtube_channels" | "keywords">): ResearchQuery {
  return { production_id: brief.production_id, channels: brief.youtube_channels.map((url) => ({ url, role: "reference" as const })), keywords: brief.keywords };
}

/** What the `research` stage calls; absent when no YouTube API key is configured. */
export interface ResearchSource {
  research(query: ResearchQuery): Promise<StudioResearch>;
}

/** The cache in `studio.db` (migration 0012), shared by the worker's runs. */
export function studioResearchCache(db: StudioDb): ResearchCache {
  return {
    async get(key) {
      const row = db.get<{ body: string; fetched_at: string }>("SELECT body, fetched_at FROM youtube_cache WHERE key = ?", [key]);
      return row ? { body: row.body, fetchedAt: row.fetched_at } : null;
    },
    async set(key, body, fetchedAt) {
      db.run("INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at", [key, body, fetchedAt]);
    },
  };
}

export interface YoutubeResearchOptions {
  apiKey: string;
  fetch?: typeof fetch;
  cache?: ResearchCache;
  now?: () => Date;
  /** Per-request timeout. */
  timeoutMs?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Units a research of these inputs will spend at most (cache hits make it less). */
export function estimateQuota(channels: number, keywords: number): number {
  return channels * 3 + keywords * (2 * SEARCH_UNITS + 1);
}

export type ChannelRef =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "username"; value: string }
  | { kind: "video"; value: string };

/**
 * What the user typed -> how to find the channel. Accepts channel ids (`UC…`), `@handle`, channel URLs
 * (`/channel/UC…`, `/@handle`, `/user/name`, `/c/name` — custom URLs are looked up as a handle, which is what
 * YouTube migrated them to), and video links (`watch?v=`, `youtu.be/`, `/shorts/`, `/live/`), whose channel is used.
 */
export function parseChannelInput(raw: string): ChannelRef | null {
  const input = raw.trim();
  if (!input) return null;
  if (/^UC[\w-]{22}$/.test(input)) return { kind: "id", value: input };
  if (/^@[\w.\-·]{3,100}$/u.test(input)) return { kind: "handle", value: input };
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/")[1];
    return id && /^[\w-]{11}$/.test(id) ? { kind: "video", value: id } : null;
  }
  if (host !== "youtube.com") return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const v = url.searchParams.get("v");
  if (parts[0] === "watch" && v && /^[\w-]{11}$/.test(v)) return { kind: "video", value: v };
  if ((parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") && parts[1] && /^[\w-]{11}$/.test(parts[1])) return { kind: "video", value: parts[1] };
  if (parts[0] === "channel" && parts[1] && /^UC[\w-]{22}$/.test(parts[1])) return { kind: "id", value: parts[1] };
  if (parts[0]?.startsWith("@")) return { kind: "handle", value: parts[0] };
  if (parts[0] === "user" && parts[1]) return { kind: "username", value: parts[1] };
  if (parts[0] === "c" && parts[1]) return { kind: "handle", value: `@${parts[1]}` };
  return null;
}

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

class QuotaExceededError extends Error {}

interface ApiVideo {
  id: string;
  snippet?: { channelId?: string; channelTitle?: string; title?: string; publishedAt?: string; tags?: string[] };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

function toVideo(v: ApiVideo, now: Date): ResearchVideo | null {
  const publishedAt = v.snippet?.publishedAt;
  if (!publishedAt || !v.snippet?.channelId) return null;
  const views = Number(v.statistics?.viewCount ?? 0);
  const days = Math.max(1, (now.getTime() - Date.parse(publishedAt)) / 86400_000);
  const num = (x: string | undefined) => (x === undefined ? null : Number(x));
  return {
    video_id: v.id, channel_id: v.snippet.channelId, channel_title: v.snippet.channelTitle ?? "", title: v.snippet.title ?? "",
    published_at: publishedAt, duration_s: parseIsoDuration(v.contentDetails?.duration), views,
    likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), tags: v.snippet.tags ?? [],
    views_per_day: r2(views / days), outlier: false,
  };
}

/** Marks videos at least `OUTLIER_FACTOR` x the median views/day of their group. */
function markOutliers(videos: ResearchVideo[]): number {
  const med = median(videos.map((v) => v.views_per_day));
  for (const v of videos) v.outlier = med > 0 && v.views_per_day >= OUTLIER_FACTOR * med;
  return med;
}

// Vietnamese function words that say nothing about a title's topic.
const STOPWORDS = new Set([
  "và", "của", "là", "có", "cho", "với", "những", "các", "một", "này", "đó", "được", "không", "thì", "mà", "ở", "tại", "trong",
  "khi", "để", "từ", "đến", "về", "như", "rất", "cũng", "đã", "sẽ", "đang", "ra", "vào", "lên", "xuống", "nè", "nhé", "ạ",
  "the", "a", "an", "of", "and", "to", "in", "for", "on", "with", "is", "at", "by", "from", "how", "what", "this", "that",
]);

export function titleTerms(title: string): string[] {
  const words = title.toLocaleLowerCase("vi").normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

function topCounts(items: string[][], limit: number): { term: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const terms of items) for (const t of new Set(terms)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "vi")).slice(0, limit).map(([term, count]) => ({ term, count }));
}

export function durationBucket(seconds: number): string {
  if (seconds < SHORTS_MAX_SECONDS) return "<1m";
  if (seconds < 300) return "1-5m";
  if (seconds < 600) return "5-10m";
  if (seconds < 1200) return "10-20m";
  return "20m+";
}

const BUCKETS = ["<1m", "1-5m", "5-10m", "10-20m", "20m+"];

export function emptyResearch(productionId: string, reason: string): StudioResearch {
  return {
    schema_version: "studio.research/v1", production_id: productionId, fetched_at: null, quota_units: 0, skipped_reason: reason,
    channels: [], keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] },
  };
}

export class YoutubeResearchSource implements ResearchSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private units = 0;
  private quotaGone = false;

  constructor(private readonly o: YoutubeResearchOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  async research(q: ResearchQuery): Promise<StudioResearch> {
    this.units = 0;
    this.quotaGone = false;
    if (!q.channels.length && !q.keywords.length) return emptyResearch(q.production_id, "Chưa nhập kênh YouTube hoặc từ khoá");
    const now = this.now();
    const channels: StudioResearch["channels"] = [];
    for (const c of q.channels) channels.push(await this.channel(c.url, c.role, now));
    const keywords: StudioResearch["keywords"] = [];
    for (const keyword of q.keywords) keywords.push(await this.keyword(keyword, now));

    // The market is the reference channels and the keyword results; the team's own channels are measured, not copied.
    const all = [...channels.filter((c) => c.role === "reference").flatMap((c) => c.videos), ...keywords.flatMap((k) => k.videos)];
    const unique = [...new Map(all.map((v) => [v.video_id, v])).values()];
    const buckets = new Map(BUCKETS.map((b) => [b, 0]));
    for (const v of unique) buckets.set(durationBucket(v.duration_s), (buckets.get(durationBucket(v.duration_s)) ?? 0) + 1);
    const inKeywords = new Map<string, { title: string; count: number }>();
    for (const v of keywords.flatMap((k) => k.videos)) {
      const e = inKeywords.get(v.channel_id) ?? { title: v.channel_title, count: 0 };
      e.count++;
      inKeywords.set(v.channel_id, e);
    }
    // What performs: terms and tags of the better half by views/day
    const perf = [...unique].sort((a, b) => b.views_per_day - a.views_per_day).slice(0, Math.max(10, Math.ceil(unique.length / 2)));
    return {
      schema_version: "studio.research/v1", production_id: q.production_id, fetched_at: now.toISOString(), quota_units: this.units,
      skipped_reason: null, channels, keywords,
      insights: {
        top_title_terms: topCounts(perf.map((v) => titleTerms(v.title)), 30),
        top_tags: topCounts(perf.map((v) => v.tags.map((t) => t.toLocaleLowerCase("vi").trim()).filter(Boolean)), 30),
        duration_buckets: BUCKETS.map((bucket) => ({ bucket, count: buckets.get(bucket) ?? 0 })),
        frequent_channels: [...inKeywords.entries()].filter(([, e]) => e.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 15)
          .map(([channel_id, e]) => ({ channel_id, title: e.title, count: e.count })),
      },
    };
  }

  private async channel(input: string, role: ChannelRole, now: Date): Promise<StudioResearch["channels"][number]> {
    const entry: StudioResearch["channels"][number] = { input, role, channel_id: null, title: null, subscribers: null, error: null, videos: [], stats: null };
    const ref = parseChannelInput(input);
    if (!ref) return { ...entry, error: "Không nhận ra link kênh, @handle hoặc ID kênh" };
    try {
      let channelId: string | null = ref.kind === "id" ? ref.value : null;
      if (ref.kind === "video") {
        const v = await this.get<{ items?: ApiVideo[] }>("videos", { part: "snippet", id: ref.value });
        channelId = v.items?.[0]?.snippet?.channelId ?? null;
        if (!channelId) return { ...entry, error: "Không tìm thấy video này" };
      }
      const lookup = channelId ? { id: channelId } : ref.kind === "handle" ? { forHandle: ref.value } : { forUsername: ref.value };
      const ch = await this.get<{ items?: { id: string; snippet?: { title?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
        "channels", { part: "snippet,statistics,contentDetails", ...lookup });
      const c = ch.items?.[0];
      if (!c) return { ...entry, error: "Không tìm thấy kênh" };
      entry.channel_id = c.id;
      entry.title = c.snippet?.title ?? null;
      entry.subscribers = c.statistics?.hiddenSubscriberCount || c.statistics?.subscriberCount === undefined ? null : Number(c.statistics.subscriberCount);
      const uploads = c.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return entry;
      const pl = await this.get<{ items?: { contentDetails?: { videoId?: string } }[] }>("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "50" });
      const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
      entry.videos = await this.videos(ids, now);
      const med = markOutliers(entry.videos);
      const times = entry.videos.map((v) => Date.parse(v.published_at)).sort((a, b) => a - b);
      const spanWeeks = times.length > 1 ? Math.max(1, (times[times.length - 1]! - times[0]!) / (7 * 86400_000)) : 1;
      entry.stats = entry.videos.length ? {
        median_views_per_day: r2(med),
        uploads_per_week: r2(entry.videos.length / spanWeeks),
        shorts_ratio: r2(entry.videos.filter((v) => v.duration_s > 0 && v.duration_s < SHORTS_MAX_SECONDS).length / entry.videos.length),
        median_duration_s: Math.round(median(entry.videos.map((v) => v.duration_s))),
      } : null;
      return entry;
    } catch (e) {
      return { ...entry, error: errorText(e) };
    }
  }

  private async keyword(keyword: string, now: Date): Promise<StudioResearch["keywords"][number]> {
    const entry: StudioResearch["keywords"][number] = { keyword, error: null, videos: [] };
    try {
      const after = new Date(now.getTime() - KEYWORD_WINDOW_DAYS * 86400_000).toISOString();
      const ids: string[] = [];
      for (const order of ["viewCount", "relevance"]) {
        const res = await this.get<{ items?: { id?: { videoId?: string } }[] }>("search", {
          part: "snippet", q: keyword, type: "video", regionCode: "VN", relevanceLanguage: "vi", publishedAfter: after, order, maxResults: "50",
        }, { cacheable: true });
        for (const it of res.items ?? []) if (it.id?.videoId && !ids.includes(it.id.videoId)) ids.push(it.id.videoId);
      }
      entry.videos = await this.videos(ids, now);
      markOutliers(entry.videos);
      entry.videos.sort((a, b) => b.views_per_day - a.views_per_day);
      return entry;
    } catch (e) {
      return { ...entry, error: errorText(e) };
    }
  }

  private async videos(ids: string[], now: Date): Promise<ResearchVideo[]> {
    const out: ResearchVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await this.get<{ items?: ApiVideo[] }>("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") });
      for (const v of res.items ?? []) {
        const x = toVideo(v, now);
        if (x) out.push(x);
      }
    }
    return out;
  }

  private async get<T>(resource: string, params: Record<string, string>, opts: { cacheable?: boolean } = {}): Promise<T> {
    if (this.quotaGone) throw new QuotaExceededError("Hết hạn mức YouTube Data API trong ngày");
    const query = new URLSearchParams(params);
    // `publishedAfter` moves every second: cache searches by the day they cover
    const cacheKey = opts.cacheable ? `yt:${resource}:${[...query.entries()].filter(([k]) => k !== "publishedAfter").map(([k, v]) => `${k}=${v}`).join("&")}:${this.now().toISOString().slice(0, 10)}` : null;
    if (cacheKey && this.o.cache) {
      const hit = await this.o.cache.get(cacheKey);
      if (hit && this.now().getTime() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return JSON.parse(hit.body) as T;
    }
    query.set("key", this.o.apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${YOUTUBE_API}/${resource}?${query.toString()}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    this.units += resource === "search" ? SEARCH_UNITS : 1;
    const text = await res.text();
    if (!res.ok) {
      let reason = "";
      try { reason = (JSON.parse(text) as { error?: { errors?: { reason?: string }[]; message?: string } }).error?.errors?.[0]?.reason ?? ""; } catch { /* not JSON */ }
      if (res.status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
        this.quotaGone = true;
        throw new QuotaExceededError("Hết hạn mức YouTube Data API trong ngày");
      }
      if (res.status === 400 && reason === "keyInvalid") throw new Error("YOUTUBE_API_KEY không hợp lệ");
      throw new Error(`YouTube ${resource} trả ${res.status}${reason ? ` (${reason})` : ""}`);
    }
    if (cacheKey && this.o.cache) await this.o.cache.set(cacheKey, text, this.now().toISOString());
    return JSON.parse(text) as T;
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error && e.name === "AbortError") return "YouTube không trả lời kịp";
  return e instanceof Error ? e.message : String(e);
}
