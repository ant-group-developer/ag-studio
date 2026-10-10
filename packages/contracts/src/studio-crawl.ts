/**
 * Crawling YouTube for a project's research (spec 2026-10-10 agent-workspace §P5): what is trending in a region, the
 * most viewed videos of a topic, the top channels of a topic, the most viewed videos of one channel. The agent calls
 * it as a tool or a person runs it from the Research tab; each run is a background job writing
 * `research/<date>-<slug>.{json,md}`.
 */
import { z } from "zod";
import { ResearchVideoSchema } from "./studio.js";

export const CRAWL_KINDS = ["trending", "topic", "top_channels", "channel_top"] as const;
export type CrawlKind = (typeof CRAWL_KINDS)[number];

/** Region codes the Research tab offers (any ISO 3166-1 alpha-2 is accepted). */
export const RegionSchema = z.string().regex(/^[A-Z]{2}$/).default("VN");
/** Videos (or channels) one crawl answers. The usual ask is 20–30. */
export const CrawlMaxSchema = z.number().int().min(1).max(200).default(30);

export const CrawlRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("trending"),
    region: RegionSchema,
    /** YouTube video category id (e.g. "19" travel & events); none: every category. */
    category: z.string().regex(/^\d{1,3}$/).optional(),
    max: CrawlMaxSchema,
  }).strict(),
  z.object({
    kind: z.literal("topic"),
    q: z.string().trim().min(1).max(200),
    region: RegionSchema,
    /** Published in the last N days. */
    days: z.number().int().min(1).max(3650).default(90),
    order: z.enum(["viewCount", "relevance", "date"]).default("viewCount"),
    max: CrawlMaxSchema,
  }).strict(),
  z.object({
    kind: z.literal("top_channels"),
    q: z.string().trim().min(1).max(200),
    region: RegionSchema,
    /** Channels; each comes with a few of its most viewed recent videos. */
    max: z.number().int().min(1).max(50).default(15),
  }).strict(),
  z.object({
    kind: z.literal("channel_top"),
    /** Link, @handle or channel id. */
    channel: z.string().trim().min(2).max(300),
    max: CrawlMaxSchema,
  }).strict(),
]);
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;
export type CrawlRequestInput = z.input<typeof CrawlRequestSchema>;

/** search.list costs 100 units a page of 50, the other lists 1 a page (YouTube Data API v3, 10 000 a day by default). */
export const CRAWL_SEARCH_UNITS = 100;
/** Above either, a crawl is large: the agent proposes it and a person confirms. */
export const CRAWL_LARGE = { units: 500, videos: 100 } as const;

const pages = (n: number) => Math.max(1, Math.ceil(n / 50));

/** Units a crawl spends at most with the YouTube Data API (the cache makes it less; yt-dlp spends none). */
export function estimateCrawlUnits(r: CrawlRequest): number {
  switch (r.kind) {
    case "trending": return pages(r.max);
    case "topic": return pages(r.max) * CRAWL_SEARCH_UNITS + pages(r.max);
    // each channel: its recent uploads (playlistItems) and their numbers (videos), its best ones by views
    case "top_channels": return pages(r.max) * CRAWL_SEARCH_UNITS + pages(r.max) + r.max * 2;
    case "channel_top": return 1 + pages(r.max) * CRAWL_SEARCH_UNITS + pages(r.max);
  }
}

/** Large crawls need a person's confirmation when the agent asks for them. */
export function isLargeCrawl(r: CrawlRequest): boolean {
  const videos = r.kind === "top_channels" ? r.max * 5 : r.max;
  return estimateCrawlUnits(r) > CRAWL_LARGE.units || videos > CRAWL_LARGE.videos;
}

export const CrawlChannelSchema = z.object({
  channel_id: z.string().min(1),
  title: z.string(),
  subscribers: z.number().int().min(0).nullable(),
  video_count: z.number().int().min(0).nullable(),
  total_views: z.number().int().min(0).nullable(),
  /** A few of its most viewed recent videos. */
  videos: z.array(ResearchVideoSchema),
}).strict();
export type CrawlChannel = z.infer<typeof CrawlChannelSchema>;

const termCount = z.object({ term: z.string(), count: z.number().int().min(0) }).strict();

/** `research/<date>-<slug>.json`: one crawl's result. */
export const StudioCrawlSchema = z.object({
  schema_version: z.literal("studio.crawl/v1"),
  request: CrawlRequestSchema,
  fetched_at: z.string(),
  /** `youtube_api` (Data API v3) or `yt-dlp` (no API key: slower, approximate order). */
  source: z.enum(["youtube_api", "yt-dlp"]),
  quota_units: z.number().int().min(0),
  /** The channel crawled (`channel_top`). */
  channel: z.object({ channel_id: z.string(), title: z.string().nullable(), subscribers: z.number().int().min(0).nullable() }).strict().nullable(),
  videos: z.array(ResearchVideoSchema),
  channels: z.array(CrawlChannelSchema),
  insights: z.object({
    top_title_terms: z.array(termCount),
    top_tags: z.array(termCount),
    duration_buckets: z.array(z.object({ bucket: z.string(), count: z.number().int().min(0) }).strict()),
    median_views_per_day: z.number().min(0),
  }).strict(),
  /** What the reader should know (fallbacks, skipped parts). */
  notes: z.array(z.string()),
}).strict();
export type StudioCrawl = z.infer<typeof StudioCrawlSchema>;
