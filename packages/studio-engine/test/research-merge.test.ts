import { describe, expect, it } from "vitest";
import { StudioResearchSchema, type StudioResearch, type StudioWebFinds } from "@harness/contracts";
import { mergeResearch, type YtDlp, type YtVideoMeta } from "../src/index.js";

const NOW = new Date("2026-10-08T00:00:00Z");
const meta = (id: string, channel_id = "UCmei", over: Partial<YtVideoMeta> = {}): YtVideoMeta => ({
  video_id: id, channel_id, channel_title: channel_id === "UCmei" ? "Mei Time" : "Khác", title: `Video ${id}`, published_at: "2026-09-28T00:00:00.000Z",
  duration_s: 1200, views: 5000, likes: 50, comments: 5, tags: ["kyoto"], ...over,
});

/** yt-dlp in memory: `@meitime` lists three uploads; every id it knows has numbers. */
function fakeYt(known: YtVideoMeta[]): YtDlp & { asked: string[][] } {
  const byId = new Map(known.map((m) => [m.video_id, m]));
  const asked: string[][] = [];
  return {
    asked,
    async version() { return "fake"; },
    async metadata(ids) { asked.push([...ids]); return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!])); },
    async listChannel(ref) {
      if (ref.kind === "handle" && ref.value === "@meitime") return { channel_id: "UCmei", title: "Mei Time", video_ids: ["meiAAAAAAA1", "meiAAAAAAA2", "meiAAAAAAA3"] };
      throw new Error("ERROR: This channel does not exist");
    },
    async download() { throw new Error("unused"); },
  };
}

const empty = (over: Partial<StudioResearch> = {}): StudioResearch => ({
  schema_version: "studio.research/v1", production_id: "p", fetched_at: "2026-10-08T00:00:00.000Z", quota_units: 3, skipped_reason: null,
  channels: [], keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] }, ...over,
});
const found = (url: string, over: Partial<StudioWebFinds["keywords"][number]["videos"][number]> = {}) => ({ url, title: "t", views: null, duration_s: null, published_at: null, ...over });
const finds = (over: Partial<StudioWebFinds> = {}): StudioWebFinds => ({ schema_version: "studio.web-finds/v1", skipped: false, channels: [], keywords: [], sources: [], ...over });
const query = { channels: [{ url: "@meitime", role: "reference" as const }], keywords: ["kyoto vlog"] };
const known = [meta("meiAAAAAAA1"), meta("meiAAAAAAA2", "UCmei", { views: 90000 }), meta("meiAAAAAAA3"), meta("kwAAAAAAAA1", "UCother"), meta("kwAAAAAAAA2", "UCother")];

describe("mergeResearch", () => {
  it("nothing was missing: the API's research, unchanged", async () => {
    const api = empty({ channels: [{ input: "@meitime", role: "reference", channel_id: "UCmei", title: "Mei", subscribers: 1, error: null, videos: [], stats: null }], keywords: [{ keyword: "kyoto vlog", error: null, videos: [] }] });
    expect(await mergeResearch({ api, finds: finds({ skipped: true }), query, ytdlp: fakeYt(known), now: NOW })).toEqual(api);
  });

  it("no API key: the channel's uploads and the keyword's links Claude found, with yt-dlp's numbers", async () => {
    const yt = fakeYt(known);
    const r = await mergeResearch({
      api: empty({ skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker", fetched_at: null, quota_units: 0 }),
      finds: finds({
        channels: [{ input: "@meitime", channel_url: "https://www.youtube.com/@meitime", title: "Mei Time", notes: "", videos: [found("https://www.youtube.com/watch?v=meiAAAAAAA1")] }],
        keywords: [{ keyword: "kyoto vlog", videos: [found("https://youtu.be/kwAAAAAAAA1"), found("https://www.youtube.com/watch?v=kwAAAAAAAA2"), found("https://www.youtube.com/watch?v=gone0000000")] }],
      }),
      query, ytdlp: yt, now: NOW,
    });
    expect(StudioResearchSchema.parse(r)).toBeTruthy();
    expect(r).toMatchObject({ source: "web", skipped_reason: null, fetched_at: NOW.toISOString() });
    const ch = r.channels[0]!;
    expect(ch).toMatchObject({ input: "@meitime", role: "reference", channel_id: "UCmei", title: "Mei Time", error: null });
    expect(ch.videos.map((v) => v.video_id).sort()).toEqual(["meiAAAAAAA1", "meiAAAAAAA2", "meiAAAAAAA3"]);
    expect(ch.videos.find((v) => v.video_id === "meiAAAAAAA2")).toMatchObject({ views: 90000, views_per_day: 9000, outlier: true });
    expect(ch.videos.every((v) => !v.estimated)).toBe(true);
    expect(ch.stats?.median_duration_s).toBe(1200);
    expect(r.keywords[0]!.videos.map((v) => v.video_id)).toEqual(["kwAAAAAAAA1", "kwAAAAAAAA2"]); // a link YouTube no longer has is dropped
    expect(r.insights.duration_buckets.find((b) => b.bucket === "20m+")?.count).toBe(5);
  });

  it("only what the API refused is filled; the rest is the API's (mixed)", async () => {
    const api = empty({
      channels: [{ input: "@meitime", role: "reference", channel_id: null, title: null, subscribers: null, error: "quotaExceeded", videos: [], stats: null }],
      keywords: [{ keyword: "kyoto vlog", error: null, videos: [{ ...meta("apiAAAAAAA1"), views_per_day: 1, outlier: false }] }],
    });
    const r = await mergeResearch({ api, finds: finds({ channels: [{ input: "@meitime", channel_url: "https://www.youtube.com/@meitime", title: null, notes: "", videos: [] }] }), query, ytdlp: fakeYt(known), now: NOW });
    expect(r.source).toBe("mixed");
    expect(r.channels[0]!.videos).toHaveLength(3);
    expect(r.keywords[0]!.videos.map((v) => v.video_id)).toEqual(["apiAAAAAAA1"]);
  });

  it("without yt-dlp: the numbers Claude read, marked estimated", async () => {
    const r = await mergeResearch({
      api: empty({ skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker" }),
      finds: finds({ keywords: [{ keyword: "kyoto vlog", videos: [found("https://www.youtube.com/watch?v=kwAAAAAAAA1", { views: 1000, duration_s: 600, published_at: "2026-09-28" })] }] }),
      query: { channels: [], keywords: ["kyoto vlog"] }, ytdlp: null, now: NOW,
    });
    expect(r.source).toBe("web");
    expect(r.keywords[0]!.videos[0]).toMatchObject({ video_id: "kwAAAAAAAA1", views: 1000, duration_s: 600, estimated: true, views_per_day: 100 });
  });

  it("nothing anywhere: says why, for the trend report to say it", async () => {
    const r = await mergeResearch({ api: empty({ skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker" }), finds: finds({ keywords: [{ keyword: "kyoto vlog", videos: [] }] }), query: { channels: [], keywords: ["kyoto vlog"] }, ytdlp: fakeYt([]), now: NOW });
    expect(r.skipped_reason).toMatch(/Chưa cấu hình YOUTUBE_API_KEY.*web không tìm được/);
    expect(r.keywords[0]!.error).toMatch(/web không tìm được/);
  });
});
