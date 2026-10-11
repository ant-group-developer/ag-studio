import { describe, expect, it } from "vitest";
import { CrawlRequestSchema, estimateCrawlUnits, isLargeCrawl } from "../src/index.js";

describe("crawl requests", () => {
  it("fill the usual defaults: Vietnam, 30 videos, the last 90 days by views", () => {
    expect(CrawlRequestSchema.parse({ kind: "trending" })).toEqual({ kind: "trending", region: "VN", max: 30 });
    expect(CrawlRequestSchema.parse({ kind: "topic", q: " phố cổ " })).toEqual({ kind: "topic", q: "phố cổ", region: "VN", days: 90, order: "viewCount", max: 30 });
    expect(CrawlRequestSchema.safeParse({ kind: "topic", q: "" }).success).toBe(false);
    expect(CrawlRequestSchema.safeParse({ kind: "trending", region: "vn" }).success).toBe(false);
    expect(CrawlRequestSchema.safeParse({ kind: "channel_top", channel: "@x", max: 500 }).success).toBe(false);
  });

  it("estimate the YouTube API units: search pages are 100, lists 1", () => {
    expect(estimateCrawlUnits(CrawlRequestSchema.parse({ kind: "trending", max: 30 }))).toBe(1);
    expect(estimateCrawlUnits(CrawlRequestSchema.parse({ kind: "topic", q: "x", max: 30 }))).toBe(101);
    expect(estimateCrawlUnits(CrawlRequestSchema.parse({ kind: "topic", q: "x", max: 120 }))).toBe(303);
    expect(estimateCrawlUnits(CrawlRequestSchema.parse({ kind: "channel_top", channel: "@x", max: 30 }))).toBe(102);
    expect(estimateCrawlUnits(CrawlRequestSchema.parse({ kind: "top_channels", q: "x", max: 10 }))).toBe(121);
  });

  it("are large above 500 units or 100 videos", () => {
    expect(isLargeCrawl(CrawlRequestSchema.parse({ kind: "topic", q: "x", max: 30 }))).toBe(false);
    expect(isLargeCrawl(CrawlRequestSchema.parse({ kind: "topic", q: "x", max: 101 }))).toBe(true);
    expect(isLargeCrawl(CrawlRequestSchema.parse({ kind: "trending", max: 150 }))).toBe(true);
    expect(isLargeCrawl(CrawlRequestSchema.parse({ kind: "top_channels", q: "x", max: 25 }))).toBe(true);
    expect(isLargeCrawl(CrawlRequestSchema.parse({ kind: "top_channels", q: "x", max: 15 }))).toBe(false);
  });
});
