/**
 * The research of a series plan 3.2.0 (`research` stage, script `studio-research-merge`, ADR-0001 item 176): what the
 * YouTube Data API returned, with each channel and keyword it could not answer filled from the web — the links
 * Claude found, their real numbers read by yt-dlp (a channel's newest uploads listed too). Without yt-dlp the numbers
 * Claude read off the pages are kept, marked `estimated`. Same document as the API's, so the trend report and the
 * style step read it unchanged.
 */
import {
  hasGaps, parseChannelInput, researchGaps, youtubeVideoIdOf,
  type ChannelRef,
} from "@harness/core";
import type { ChannelRole, ResearchVideo, StudioResearch, StudioWebFinds } from "@harness/contracts";
import { channelStats, keywordVideos, researchInsights, researchVideo } from "./youtube-research.js";
import type { YtDlp, YtVideoMeta } from "./yt-dlp.js";

/** Uploads listed for a channel found on the web (the API reads 50; yt-dlp reads each one, so fewer). */
export const WEB_CHANNEL_UPLOADS = 30;

export interface MergeResearchInput {
  api: StudioResearch;
  finds: StudioWebFinds;
  /** What the series asked research about (the seed's channels and keywords), in its order. */
  query: { channels: { url: string; role: ChannelRole }[]; keywords: string[] };
  /** null: not installed — the numbers Claude read are kept, `estimated`. */
  ytdlp: YtDlp | null;
  now: Date;
  signal?: AbortSignal;
}

type FoundVideo = StudioWebFinds["keywords"][number]["videos"][number];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Ids of Claude's video links (anything else was refused by the validator; dropped again here). */
function idsOf(videos: readonly FoundVideo[]): string[] {
  return [...new Set(videos.map((v) => youtubeVideoIdOf(v.url)).filter((id): id is string => !!id))];
}

/** Claude's own numbers for a video, as research keeps them, when yt-dlp cannot read the real ones. */
function estimated(v: FoundVideo, channel: { id: string; title: string }, now: Date): ResearchVideo | null {
  const id = youtubeVideoIdOf(v.url);
  if (!id) return null;
  return {
    ...researchVideo({
      video_id: id, channel_id: channel.id, channel_title: channel.title, title: v.title, published_at: isoOrNull(v.published_at) ?? now.toISOString(),
      duration_s: v.duration_s ?? 0, views: v.views ?? 0, likes: null, comments: null, tags: [],
    }, now),
    estimated: true,
  };
}

const fromMeta = (m: YtVideoMeta, now: Date): ResearchVideo => researchVideo(m, now);

/** The channel reference to list: the page Claude found, else what the person typed (a video link: its channel). */
async function channelRef(input: string, found: StudioWebFinds["channels"][number] | undefined, yt: YtDlp, signal?: AbortSignal): Promise<ChannelRef | null> {
  for (const raw of [found?.channel_url ?? "", input]) {
    const ref = raw ? parseChannelInput(raw) : null;
    if (!ref) continue;
    if (ref.kind !== "video") return ref;
    const m = (await yt.metadata([ref.value], signal)).get(ref.value);
    if (m) return { kind: "id", value: m.channel_id };
  }
  return null;
}

async function webChannel(p: MergeResearchInput, input: string, role: ChannelRole): Promise<StudioResearch["channels"][number]> {
  const found = p.finds.channels.find((c) => c.input === input);
  const entry: StudioResearch["channels"][number] = { input, role, channel_id: null, title: found?.title ?? null, subscribers: null, error: null, videos: [], stats: null };
  const why: string[] = [];
  if (p.ytdlp) {
    let listed: Awaited<ReturnType<YtDlp["listChannel"]>> | null = null;
    try {
      const ref = await channelRef(input, found, p.ytdlp, p.signal);
      if (ref) listed = await p.ytdlp.listChannel(ref, WEB_CHANNEL_UPLOADS, p.signal);
      else why.push("không xác định được kênh");
    } catch (e) { why.push(errText(e)); }
    let metas: YtVideoMeta[] = [];
    try {
      metas = [...(await p.ytdlp.metadata([...new Set([...(listed?.video_ids ?? []), ...idsOf(found?.videos ?? [])])], p.signal)).values()];
    } catch (e) { why.push(errText(e)); }
    // the channel's own videos only (a link Claude found may be of another channel)
    const counts = new Map<string, number>();
    for (const m of metas) counts.set(m.channel_id, (counts.get(m.channel_id) ?? 0) + 1);
    const channelId = listed?.channel_id ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const mine = metas.filter((m) => !channelId || m.channel_id === channelId);
    entry.channel_id = channelId;
    entry.title = listed?.title ?? found?.title ?? mine[0]?.channel_title ?? null;
    entry.videos = mine.map((m) => fromMeta(m, p.now));
  } else {
    const ref = parseChannelInput(found?.channel_url ?? input);
    const channel = { id: ref && ref.kind !== "video" ? ref.value : `web:${input}`, title: found?.title ?? input };
    entry.channel_id = ref?.kind === "id" ? ref.value : null;
    entry.videos = (found?.videos ?? []).map((v) => estimated(v, channel, p.now)).filter((v): v is ResearchVideo => !!v);
  }
  entry.stats = channelStats(entry.videos);
  if (!entry.videos.length) entry.error = `web không tìm được video của kênh${why.length ? ` (${why.join("; ")})` : found?.notes ? ` (${found.notes})` : ""}`.slice(0, 500);
  return entry;
}

async function webKeyword(p: MergeResearchInput, keyword: string): Promise<StudioResearch["keywords"][number]> {
  const found = p.finds.keywords.find((k) => k.keyword === keyword);
  let videos: ResearchVideo[] = [];
  let why = "";
  if (p.ytdlp) {
    try {
      videos = [...(await p.ytdlp.metadata(idsOf(found?.videos ?? []), p.signal)).values()].map((m) => fromMeta(m, p.now));
    } catch (e) { why = errText(e); }
  } else {
    videos = (found?.videos ?? []).map((v) => estimated(v, { id: "web:unknown", title: "" }, p.now)).filter((v): v is ResearchVideo => !!v);
  }
  return { keyword, error: videos.length ? null : `web không tìm được video cho từ khoá${why ? ` (${why})` : ""}`, videos: keywordVideos(videos) };
}

/** The research a series plan 3.2.0 reads: the API's, with what it could not answer filled from the web. */
export async function mergeResearch(p: MergeResearchInput): Promise<StudioResearch> {
  if (p.finds.skipped) return p.api;
  const gaps = researchGaps(p.api, p.query);
  if (!hasGaps(gaps)) return p.api;
  const gapChannels = new Set(gaps.channels.map((c) => c.input));
  const gapKeywords = new Set(gaps.keywords);
  const apiChannels = new Map(p.api.channels.map((c) => [c.input, c]));
  const apiKeywords = new Map(p.api.keywords.map((k) => [k.keyword, k]));

  const channels: StudioResearch["channels"] = [];
  for (const c of p.query.channels) channels.push(gapChannels.has(c.url) ? await webChannel(p, c.url, c.role) : apiChannels.get(c.url)!);
  const keywords: StudioResearch["keywords"] = [];
  for (const k of p.query.keywords) keywords.push(gapKeywords.has(k) ? await webKeyword(p, k) : apiKeywords.get(k)!);

  const fromApi = p.query.channels.length + p.query.keywords.length - gapChannels.size - gapKeywords.size;
  const videos = channels.reduce((n, c) => n + c.videos.length, 0) + keywords.reduce((n, k) => n + k.videos.length, 0);
  const skipped_reason = videos > 0 ? null
    : `${p.api.skipped_reason ?? "YouTube API không trả dữ liệu"}; web không tìm được video nào${p.ytdlp ? "" : " (máy không có yt-dlp)"}`;
  return {
    ...p.api,
    fetched_at: p.api.fetched_at ?? p.now.toISOString(),
    skipped_reason,
    source: fromApi > 0 ? "mixed" : "web",
    channels,
    keywords,
    insights: researchInsights(channels, keywords),
  };
}
