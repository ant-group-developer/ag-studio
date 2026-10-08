/**
 * Research found on the web (plan 2026-10-08 quality-fixes, ADR-0001 item 176). When the YouTube Data API has no key
 * or refuses a channel or keyword, Claude (WebSearch/WebFetch only) finds YouTube links for what is missing, and
 * yt-dlp reads their real numbers. Pure: what is missing, and whether Claude's answer is only YouTube links for it.
 */
import { StudioWebFindsSchema, type ChannelRole, type StudioResearch, type StudioWebFinds } from "@harness/contracts";
import type { ZodError } from "zod";
import type { StudioProblem, StudioValidation } from "./validate.js";

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

/** The video id of a YouTube video link (watch, youtu.be, shorts, live, embed); null for anything else. */
export function youtubeVideoIdOf(url: string): string | null {
  const ref = /^https?:\/\//i.test(url.trim()) ? parseChannelInput(url) : null;
  return ref?.kind === "video" ? ref.value : null;
}

/** A channel's page on YouTube, rebuilt from what was parsed (never the text as typed). */
export function youtubeChannelUrl(ref: ChannelRef): string | null {
  switch (ref.kind) {
    case "id": return `https://www.youtube.com/channel/${ref.value}`;
    case "handle": return `https://www.youtube.com/${encodeURIComponent(ref.value).replace(/^%40/, "@")}`;
    case "username": return `https://www.youtube.com/user/${encodeURIComponent(ref.value)}`;
    default: return null;
  }
}

/** A video's page on YouTube, rebuilt from its id. */
export function youtubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** The channels and keywords research was asked about and has nothing for. */
export interface ResearchGaps {
  channels: { input: string; role: ChannelRole }[];
  keywords: string[];
}

/**
 * What the web should fill in: everything asked when the research was skipped (no API key), else each channel or
 * keyword YouTube refused (its `error`) or that is missing from the document. A channel or keyword YouTube answered
 * with no videos is not a gap: the web would not find more.
 */
export function researchGaps(r: StudioResearch, q: { channels: { url: string; role: ChannelRole }[]; keywords: string[] }): ResearchGaps {
  const channels = new Map(r.channels.map((c) => [c.input, c]));
  const keywords = new Map(r.keywords.map((k) => [k.keyword, k]));
  return {
    channels: q.channels.filter((c) => { const e = channels.get(c.url); return !e || e.error !== null; }).map((c) => ({ input: c.url, role: c.role })),
    keywords: q.keywords.filter((k) => { const e = keywords.get(k); return !e || e.error !== null; }),
  };
}

export function hasGaps(g: ResearchGaps): boolean {
  return g.channels.length > 0 || g.keywords.length > 0;
}

function zodProblems(e: ZodError): StudioProblem[] {
  return e.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "(root)"}: ${i.message}` }));
}

/**
 * `web-finds.json`: answers only the gaps asked, every video a YouTube video link, every channel a YouTube channel;
 * saying `skipped` while there are gaps is a problem. A gap with nothing found is a warning (the web may not know it).
 */
export function validateWebFinds(raw: unknown, ctx: { gaps: ResearchGaps }): StudioValidation<StudioWebFinds> {
  const parsed = StudioWebFindsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const finds = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];
  const askedChannels = new Set(ctx.gaps.channels.map((c) => c.input));
  const askedKeywords = new Set(ctx.gaps.keywords);
  if (finds.skipped && hasGaps(ctx.gaps)) problems.push({ code: "skipped_with_gaps", message: "còn kênh/từ khoá thiếu dữ liệu, không được ghi skipped" });
  const badVideos = (where: string, videos: StudioWebFinds["keywords"][number]["videos"]) => {
    for (const v of videos) {
      if (!youtubeVideoIdOf(v.url)) problems.push({ code: "not_youtube_video", message: `${where}: "${v.url}" không phải link video YouTube` });
    }
  };
  for (const c of finds.channels) {
    if (!askedChannels.has(c.input)) problems.push({ code: "not_asked", message: `kênh "${c.input}" không nằm trong danh sách cần tìm` });
    const ref = c.channel_url ? parseChannelInput(c.channel_url) : null;
    if (c.channel_url && (!ref || ref.kind === "video" || !/^https?:\/\//i.test(c.channel_url))) {
      problems.push({ code: "not_youtube_channel", message: `kênh "${c.input}": "${c.channel_url}" không phải link kênh YouTube` });
    }
    badVideos(`kênh "${c.input}"`, c.videos);
  }
  for (const k of finds.keywords) {
    if (!askedKeywords.has(k.keyword)) problems.push({ code: "not_asked", message: `từ khoá "${k.keyword}" không nằm trong danh sách cần tìm` });
    badVideos(`từ khoá "${k.keyword}"`, k.videos);
  }
  for (const c of ctx.gaps.channels) {
    const e = finds.channels.find((x) => x.input === c.input);
    if (!e || (e.channel_url === null && e.videos.length === 0)) warnings.push({ code: "gap_unanswered", message: `không tìm được gì cho kênh "${c.input}"` });
  }
  for (const k of ctx.gaps.keywords) {
    const e = finds.keywords.find((x) => x.keyword === k);
    if (!e || e.videos.length === 0) warnings.push({ code: "gap_unanswered", message: `không tìm được video nào cho từ khoá "${k}"` });
  }
  return { ok: problems.length === 0, value: problems.length ? null : finds, problems, warnings };
}
