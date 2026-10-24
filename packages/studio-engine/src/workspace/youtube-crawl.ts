/**
 * Crawling YouTube for a project's research (spec 2026-10-10 agent-workspace §P5, contracts `studio-crawl.ts`): what
 * is trending in a region, the most viewed videos of a topic, the top channels of a topic, a channel's most viewed
 * videos. With a YouTube Data API key it asks the API (quota counted, searches cached for a day); without one it asks
 * yt-dlp (no quota, slower, approximate: YouTube's search order, a channel's recent uploads), and says so in `notes`.
 * Trending needs the API: YouTube has no public trending page any more.
 */
import { CrawlRequestSchema, type CrawlChannel, type CrawlRequest, type ResearchVideo, type StudioCrawl } from "@harness/contracts";
import { parseChannelInput, type ChannelRef } from "@harness/core";
import type { YtDlp, YtVideoMeta } from "../yt-dlp.js";
import {
  CACHE_TTL_MS, DURATION_BUCKETS, durationBucket, median, parseIsoDuration, researchVideo, titleTerms, topCounts, YOUTUBE_API, type ResearchCache,
} from "../youtube-research.js";

export interface CrawlerOptions {
  /** YouTube Data API v3 key; none: yt-dlp. */
  apiKey?: string | null;
  ytdlp?: YtDlp | null;
  cache?: ResearchCache;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** How far a crawl is: what it does now, 0–1. */
export type CrawlProgress = (phase: string, progress: number | null) => void;

interface ApiVideo {
  id: string;
  snippet?: { channelId?: string; channelTitle?: string; title?: string; publishedAt?: string; tags?: string[] };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}
interface ApiChannel {
  id: string;
  snippet?: { title?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string; viewCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

class QuotaExceededError extends Error {}

/** A YouTube Data API answer other than 2xx, with its status and the API's `reason` ("" when it gave none). */
class YoutubeApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string) {
    super(message);
    this.name = "YoutubeApiError";
  }
}

/** Videos per channel a `top_channels` crawl shows. */
export const CHANNEL_TOP_VIDEOS = 5;

const num = (x: string | undefined) => (x === undefined ? null : Number(x));

function apiVideo(v: ApiVideo, now: Date): ResearchVideo | null {
  const publishedAt = v.snippet?.publishedAt;
  if (!publishedAt || !v.snippet?.channelId) return null;
  return researchVideo({
    video_id: v.id, channel_id: v.snippet.channelId, channel_title: v.snippet.channelTitle ?? "", title: v.snippet.title ?? "",
    published_at: publishedAt, duration_s: parseIsoDuration(v.contentDetails?.duration), views: Number(v.statistics?.viewCount ?? 0),
    likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), tags: v.snippet.tags ?? [],
  }, now);
}

const ytVideo = (m: YtVideoMeta, now: Date): ResearchVideo => researchVideo({ ...m }, now);

/** Videos at least twice the median views/day of the list are outliers (as research marks them). */
function markOutliers(videos: ResearchVideo[]): number {
  const med = median(videos.map((v) => v.views_per_day));
  for (const v of videos) v.outlier = med > 0 && v.views_per_day >= 2 * med;
  return med;
}

/** What the videos of a crawl say: frequent title terms and tags of the better half by views/day, lengths. */
export function crawlInsights(videos: ResearchVideo[]): StudioCrawl["insights"] {
  const unique = [...new Map(videos.map((v) => [v.video_id, v])).values()];
  const med = markOutliers(unique);
  const perf = [...unique].sort((a, b) => b.views_per_day - a.views_per_day).slice(0, Math.max(10, Math.ceil(unique.length / 2)));
  const buckets = new Map(DURATION_BUCKETS.map((b) => [b, 0]));
  for (const v of unique) buckets.set(durationBucket(v.duration_s), (buckets.get(durationBucket(v.duration_s)) ?? 0) + 1);
  return {
    top_title_terms: topCounts(perf.map((v) => titleTerms(v.title)), 30),
    top_tags: topCounts(perf.map((v) => v.tags.map((t) => t.toLocaleLowerCase("vi").trim()).filter(Boolean)), 30),
    duration_buckets: DURATION_BUCKETS.map((bucket) => ({ bucket, count: buckets.get(bucket) ?? 0 })),
    median_views_per_day: Math.round(med * 100) / 100,
  };
}

const byViews = (a: ResearchVideo, b: ResearchVideo) => b.views - a.views;

export class YoutubeCrawler {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private units = 0;

  constructor(private readonly o: CrawlerOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  /** Where answers come from: the API, yt-dlp, or nothing (neither configured). */
  get source(): StudioCrawl["source"] | null {
    return this.o.apiKey ? "youtube_api" : this.o.ytdlp ? "yt-dlp" : null;
  }

  async crawl(input: CrawlRequest, progress: CrawlProgress = () => {}, signal?: AbortSignal): Promise<StudioCrawl> {
    const r = CrawlRequestSchema.parse(input);
    const source = this.source;
    if (!source) throw new Error("Worker chưa có YOUTUBE_API_KEY hay yt-dlp: không crawl được YouTube");
    this.units = 0;
    const now = this.now();
    const notes: string[] = [];
    let videos: ResearchVideo[] = [];
    let channels: CrawlChannel[] = [];
    let channel: StudioCrawl["channel"] = null;
    if (source === "youtube_api") {
      if (r.kind === "trending") videos = await this.apiTrending(r, now, progress, signal);
      else if (r.kind === "topic") videos = await this.apiTopic(r, now, progress, signal);
      else if (r.kind === "top_channels") channels = await this.apiTopChannels(r, now, progress, signal);
      else ({ videos, channel } = await this.apiChannelTop(r, now, progress, notes, signal));
    } else {
      const yt = this.o.ytdlp!;
      if (r.kind === "trending") throw new Error("Xu hướng cần YOUTUBE_API_KEY: YouTube không còn trang Thịnh hành công khai cho yt-dlp đọc");
      if (r.kind === "topic") videos = await this.ytTopic(yt, r, now, progress, notes, signal);
      else if (r.kind === "top_channels") channels = await this.ytTopChannels(yt, r, now, progress, notes, signal);
      else ({ videos, channel } = await this.ytChannelTop(yt, r, now, progress, notes, signal));
    }
    const all = [...videos, ...channels.flatMap((c) => c.videos)];
    return {
      schema_version: "studio.crawl/v1", request: r, fetched_at: now.toISOString(), source, quota_units: this.units, channel,
      videos, channels, insights: crawlInsights(all), notes,
    };
  }

  // ---- YouTube Data API ----

  private async apiTrending(r: Extract<CrawlRequest, { kind: "trending" }>, now: Date, progress: CrawlProgress, signal?: AbortSignal): Promise<ResearchVideo[]> {
    const out: ResearchVideo[] = [];
    let pageToken: string | undefined;
    do {
      progress(`Đang lấy video xu hướng (${out.length}/${r.max})`, out.length / r.max);
      const res = await this.api<{ items?: ApiVideo[]; nextPageToken?: string }>("videos", {
        part: "snippet,statistics,contentDetails", chart: "mostPopular", regionCode: r.region, maxResults: String(Math.min(50, r.max - out.length)),
        ...(r.category ? { videoCategoryId: r.category } : {}), ...(pageToken ? { pageToken } : {}),
      }, { cacheable: true, signal });
      for (const v of res.items ?? []) { const x = apiVideo(v, now); if (x) out.push(x); }
      pageToken = res.nextPageToken;
    } while (pageToken && out.length < r.max);
    return out.slice(0, r.max);
  }

  private async apiTopic(r: Extract<CrawlRequest, { kind: "topic" }>, now: Date, progress: CrawlProgress, signal?: AbortSignal): Promise<ResearchVideo[]> {
    const ids = await this.apiSearchIds({
      q: r.q, type: "video", regionCode: r.region, ...(r.region === "VN" ? { relevanceLanguage: "vi" } : {}),
      publishedAfter: new Date(now.getTime() - r.days * 86400_000).toISOString(), order: r.order,
    }, r.max, (n) => progress(`Đang tìm "${r.q}" (${n}/${r.max})`, 0.6 * (n / r.max)), signal);
    progress(`Đang đọc số liệu ${ids.length} video`, 0.7);
    const videos = await this.apiVideos(ids, now, signal);
    return r.order === "viewCount" ? videos.sort(byViews) : videos;
  }

  private async apiTopChannels(r: Extract<CrawlRequest, { kind: "top_channels" }>, now: Date, progress: CrawlProgress, signal?: AbortSignal): Promise<CrawlChannel[]> {
    const ids = await this.apiSearchIds({ q: r.q, type: "channel", regionCode: r.region, order: "viewCount" }, r.max,
      (n) => progress(`Đang tìm kênh "${r.q}" (${n}/${r.max})`, 0.3 * (n / r.max)), signal, "channelId");
    const chans = await this.apiChannels(ids, signal);
    const out: CrawlChannel[] = [];
    for (const [i, c] of chans.entries()) {
      progress(`Đang xem video của kênh ${c.snippet?.title ?? c.id} (${i + 1}/${chans.length})`, 0.3 + 0.7 * (i / Math.max(1, chans.length)));
      const uploads = c.contentDetails?.relatedPlaylists?.uploads;
      const recent = uploads ? await this.apiPlaylistIds(uploads, 50, signal) : [];
      const videos = (await this.apiVideos(recent, now, signal)).sort(byViews).slice(0, CHANNEL_TOP_VIDEOS);
      out.push({
        channel_id: c.id, title: c.snippet?.title ?? "", subscribers: subscribersOf(c), video_count: num(c.statistics?.videoCount),
        total_views: num(c.statistics?.viewCount), videos,
      });
    }
    return out.sort((a, b) => (b.subscribers ?? -1) - (a.subscribers ?? -1));
  }

  private async apiChannelTop(r: Extract<CrawlRequest, { kind: "channel_top" }>, now: Date, progress: CrawlProgress, notes: string[], signal?: AbortSignal) {
    progress("Đang tìm kênh", 0.05);
    const c = await this.apiResolveChannel(r.channel, notes, signal);
    const ids = await this.apiSearchIds({ channelId: c.id, type: "video", order: "viewCount" }, r.max,
      (n) => progress(`Đang lấy video xem nhiều nhất (${n}/${r.max})`, 0.1 + 0.5 * (n / r.max)), signal);
    progress(`Đang đọc số liệu ${ids.length} video`, 0.7);
    const videos = (await this.apiVideos(ids, now, signal)).sort(byViews);
    return { videos, channel: { channel_id: c.id, title: c.snippet?.title ?? null, subscribers: subscribersOf(c) } };
  }

  private async apiResolveChannel(input: string, notes: string[], signal?: AbortSignal): Promise<ApiChannel> {
    const ref = parseChannelInput(input);
    if (!ref) return this.apiChannelByName(input, notes, signal);
    let channelId: string | null = ref.kind === "id" ? ref.value : null;
    if (ref.kind === "video") {
      const v = await this.api<{ items?: ApiVideo[] }>("videos", { part: "snippet", id: ref.value }, { signal });
      channelId = v.items?.[0]?.snippet?.channelId ?? null;
      if (!channelId) throw new Error("Không tìm thấy video này");
    }
    const lookup = channelId ? { id: channelId } : ref.kind === "handle" ? { forHandle: ref.value } : { forUsername: ref.value };
    const ch = await this.api<{ items?: ApiChannel[] }>("channels", { part: "snippet,statistics,contentDetails", ...lookup }, { signal });
    const c = ch.items?.[0];
    if (!c) throw new Error("Không tìm thấy kênh");
    return c;
  }

  /** A channel named, not linked: among the first channels YouTube finds for the name, the one titled so, else the first. */
  private async apiChannelByName(name: string, notes: string[], signal?: AbortSignal): Promise<ApiChannel> {
    const ids = await this.apiSearchIds({ q: name, type: "channel" }, 5, () => {}, signal, "channelId");
    const found = ids.length ? await this.apiChannels(ids, signal) : [];
    const ordered = ids.map((id) => found.find((c) => c.id === id)).filter((c): c is ApiChannel => !!c);
    const c = ordered.find((x) => sameName(x.snippet?.title ?? "", name)) ?? ordered[0];
    if (!c) throw new Error(notFoundByName(name));
    notes.push(foundByName(name, c.snippet?.title ?? c.id, c.id));
    return c;
  }

  private async apiSearchIds(params: Record<string, string>, max: number, onPage: (n: number) => void, signal?: AbortSignal, idKey: "videoId" | "channelId" = "videoId"): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      onPage(ids.length);
      const res = await this.api<{ items?: { id?: { videoId?: string; channelId?: string } }[]; nextPageToken?: string }>("search", {
        part: "snippet", ...params, maxResults: String(Math.min(50, max - ids.length)), ...(pageToken ? { pageToken } : {}),
      }, { cacheable: true, signal });
      for (const it of res.items ?? []) { const id = it.id?.[idKey]; if (id && !ids.includes(id)) ids.push(id); }
      pageToken = res.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  /** The playlist's video ids; none when YouTube has no such playlist (a channel with no public uploads answers
   * 404 `playlistNotFound` for its uploads list: that channel stays in the table with no videos, it does not fail the
   * whole `youtube_top_channels`). */
  private async apiPlaylistIds(playlistId: string, max: number, signal?: AbortSignal): Promise<string[]> {
    let res: { items?: { contentDetails?: { videoId?: string } }[] };
    try {
      res = await this.api("playlistItems", { part: "contentDetails", playlistId, maxResults: String(Math.min(50, max)) }, { signal });
    } catch (e) {
      if (e instanceof YoutubeApiError && e.status === 404 && e.reason === "playlistNotFound") return [];
      throw e;
    }
    return (res.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
  }

  private async apiChannels(ids: string[], signal?: AbortSignal): Promise<ApiChannel[]> {
    const out: ApiChannel[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await this.api<{ items?: ApiChannel[] }>("channels", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") }, { signal });
      out.push(...(res.items ?? []));
    }
    return out;
  }

  private async apiVideos(ids: string[], now: Date, signal?: AbortSignal): Promise<ResearchVideo[]> {
    const out: ResearchVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await this.api<{ items?: ApiVideo[] }>("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") }, { signal });
      for (const v of res.items ?? []) { const x = apiVideo(v, now); if (x) out.push(x); }
    }
    return out;
  }

  private async api<T>(resource: string, params: Record<string, string>, opts: { cacheable?: boolean; signal?: AbortSignal | undefined } = {}): Promise<T> {
    if (opts.signal?.aborted) throw new Error("đã dừng");
    const query = new URLSearchParams(params);
    // `publishedAfter` moves every second: cache searches by the day they cover
    const cacheKey = opts.cacheable ? `yt:${resource}:${[...query.entries()].filter(([k]) => k !== "publishedAfter").map(([k, v]) => `${k}=${v}`).join("&")}:${this.now().toISOString().slice(0, 10)}` : null;
    if (cacheKey && this.o.cache) {
      const hit = await this.o.cache.get(cacheKey);
      if (hit && this.now().getTime() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return JSON.parse(hit.body) as T;
    }
    query.set("key", this.o.apiKey!);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${YOUTUBE_API}/${resource}?${query.toString()}`, { signal: ctrl.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("đã dừng");
      throw e instanceof Error && e.name === "AbortError" ? new Error("YouTube không trả lời kịp") : e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    this.units += resource === "search" ? 100 : 1;
    const text = await res.text();
    if (!res.ok) {
      let reason = "";
      try { reason = (JSON.parse(text) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason ?? ""; } catch { /* not JSON */ }
      if (res.status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) throw new QuotaExceededError("Hết hạn mức YouTube Data API trong ngày");
      if (res.status === 400 && reason === "keyInvalid") throw new Error("YOUTUBE_API_KEY không hợp lệ");
      throw new YoutubeApiError(`YouTube ${resource} trả ${res.status}${reason ? ` (${reason})` : ""}`, res.status, reason);
    }
    if (cacheKey && this.o.cache) await this.o.cache.set(cacheKey, text, this.now().toISOString());
    return JSON.parse(text) as T;
  }

  // ---- yt-dlp ----

  private async ytTopic(yt: YtDlp, r: Extract<CrawlRequest, { kind: "topic" }>, now: Date, progress: CrawlProgress, notes: string[], signal?: AbortSignal) {
    progress(`Đang tìm "${r.q}" bằng yt-dlp`, 0.1);
    // twice as many as asked: some are older than the window
    const ids = await yt.search(r.q, Math.min(200, r.max * 2), r.order === "date" ? "date" : "relevance", signal);
    progress(`Đang đọc số liệu ${ids.length} video bằng yt-dlp`, 0.4);
    const meta = await yt.metadata(ids, signal);
    const after = now.getTime() - r.days * 86400_000;
    let videos = ids.map((id) => meta.get(id)).filter((m): m is YtVideoMeta => !!m && Date.parse(m.published_at) >= after).map((m) => ytVideo(m, now));
    if (r.order === "viewCount") videos = videos.sort(byViews);
    notes.push("Không có YOUTUBE_API_KEY: tìm bằng yt-dlp theo thứ tự liên quan của YouTube rồi xếp lại, không phải danh sách xem nhiều nhất đầy đủ.");
    return videos.slice(0, r.max);
  }

  private async ytTopChannels(yt: YtDlp, r: Extract<CrawlRequest, { kind: "top_channels" }>, now: Date, progress: CrawlProgress, notes: string[], signal?: AbortSignal): Promise<CrawlChannel[]> {
    progress(`Đang tìm "${r.q}" bằng yt-dlp`, 0.1);
    const ids = await yt.search(r.q, Math.min(200, r.max * 6), "relevance", signal);
    progress(`Đang đọc số liệu ${ids.length} video bằng yt-dlp`, 0.4);
    const meta = await yt.metadata(ids, signal);
    const byChannel = new Map<string, { title: string; videos: ResearchVideo[] }>();
    for (const m of meta.values()) {
      const e = byChannel.get(m.channel_id) ?? { title: m.channel_title, videos: [] };
      e.videos.push(ytVideo(m, now));
      byChannel.set(m.channel_id, e);
    }
    notes.push("Không có YOUTUBE_API_KEY: kênh lấy từ kết quả tìm video bằng yt-dlp, xếp theo tổng lượt xem các video tìm thấy; số người đăng ký không có.");
    return [...byChannel.entries()]
      .map(([channel_id, e]) => ({ channel_id, title: e.title, subscribers: null, video_count: null, total_views: e.videos.reduce((n, v) => n + v.views, 0), videos: e.videos.sort(byViews).slice(0, CHANNEL_TOP_VIDEOS) }))
      .sort((a, b) => (b.total_views ?? 0) - (a.total_views ?? 0))
      .slice(0, r.max);
  }

  /** A channel named, not linked, through yt-dlp: among the channels of a video search for the name, the one titled so,
   * else the one with the most results. */
  private async ytChannelByName(yt: YtDlp, name: string, notes: string[], signal?: AbortSignal): Promise<ChannelRef> {
    const ids = await yt.search(name, 20, "relevance", signal);
    const meta = ids.length ? await yt.metadata(ids, signal) : new Map<string, YtVideoMeta>();
    const counts = new Map<string, { title: string; n: number }>();
    for (const m of meta.values()) counts.set(m.channel_id, { title: m.channel_title, n: (counts.get(m.channel_id)?.n ?? 0) + 1 });
    const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
    const hit = ranked.find(([, c]) => sameName(c.title, name)) ?? ranked[0];
    if (!hit) throw new Error(notFoundByName(name));
    notes.push(foundByName(name, hit[1].title, hit[0]));
    return { kind: "id", value: hit[0] };
  }

  private async ytChannelTop(yt: YtDlp, r: Extract<CrawlRequest, { kind: "channel_top" }>, now: Date, progress: CrawlProgress, notes: string[], signal?: AbortSignal) {
    const parsed = parseChannelInput(r.channel);
    if (parsed?.kind === "video") throw new Error("Không nhận ra link kênh, @handle hoặc ID kênh");
    const ref = parsed ?? await this.ytChannelByName(yt, r.channel, notes, signal);
    progress("Đang đọc danh sách video của kênh bằng yt-dlp", 0.1);
    const recent = Math.min(200, Math.max(100, r.max * 3));
    const list = await yt.listChannel(ref, recent, signal);
    progress(`Đang đọc số liệu ${list.video_ids.length} video bằng yt-dlp`, 0.4);
    const meta = await yt.metadata(list.video_ids, signal);
    const videos = [...meta.values()].map((m) => ytVideo(m, now)).sort(byViews).slice(0, r.max);
    notes.push(`Không có YOUTUBE_API_KEY: xếp theo lượt xem trong ${list.video_ids.length} video mới nhất của kênh (yt-dlp), không phải mọi video.`);
    return { videos, channel: list.channel_id ? { channel_id: list.channel_id, title: list.title, subscribers: null } : null };
  }
}

/** Same channel name, whatever the case, accents' encoding and spacing. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFC").toLocaleLowerCase("vi").replace(/s+/g, " ").trim();
  return norm(a) === norm(b);
}

const notFoundByName = (name: string) => `Không tìm thấy kênh nào tên "${name}": đưa link kênh hoặc @handle`;
const foundByName = (name: string, title: string, id: string) =>
  `Kênh tìm theo tên "${name}": ${title} (${id}). Không đúng kênh thì đưa link kênh hoặc @handle.`;

function subscribersOf(c: ApiChannel): number | null {
  return c.statistics?.hiddenSubscriberCount || c.statistics?.subscriberCount === undefined ? null : Number(c.statistics.subscriberCount);
}

export { QuotaExceededError };
