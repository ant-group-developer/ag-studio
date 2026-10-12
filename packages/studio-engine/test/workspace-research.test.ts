/**
 * Crawling YouTube for a project (P5): the Data API through a fake fetch, yt-dlp through `fixtures/fake-yt-dlp.mjs`,
 * and the `research` job writing research/<date>-<slug>.{json,md}. No network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CrawlRequestSchema, StudioCrawlSchema } from "@harness/contracts";
import {
  createJob, createJobRunner, createProject, crawlSlug, getJob, researchHandler, seedWorkspace, slugify, studioLogger, YoutubeCrawler, ytDlp,
  type ResearchCache,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = new Date("2026-10-10T08:00:00Z");
const ROOT = resolve(__dirname, "..", "..", "..");
const FAKE_YTDLP = ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")] });

function video(id: string, o: { views: number; daysAgo?: number; channel?: string; title?: string; tags?: string[] }) {
  return {
    id,
    snippet: {
      channelId: o.channel ?? "UCchan1", channelTitle: o.channel ? `Kênh ${o.channel}` : "Kênh 1", title: o.title ?? `Video ${id}`,
      publishedAt: new Date(NOW.getTime() - (o.daysAgo ?? 10) * 86400_000).toISOString(), tags: o.tags ?? [],
    },
    statistics: { viewCount: String(o.views), likeCount: "10", commentCount: "2" },
    contentDetails: { duration: "PT6M30S" },
  };
}

function fakeYoutube(handlers: Record<string, (q: URLSearchParams) => { status?: number; body: unknown }>) {
  const calls: { resource: string; query: URLSearchParams }[] = [];
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const resource = url.pathname.split("/").pop()!;
    calls.push({ resource, query: url.searchParams });
    const h = handlers[resource];
    const { status = 200, body } = h ? h(url.searchParams) : { status: 404, body: { error: { errors: [{ reason: "notFound" }] } } };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const memoryCache = (): ResearchCache => {
  const store = new Map<string, { body: string; fetchedAt: string }>();
  return { async get(k) { return store.get(k) ?? null; }, async set(k, body, fetchedAt) { store.set(k, { body, fetchedAt }); } };
};

describe("YouTube crawl with the Data API", () => {
  it("trending: the region's most popular videos, a page at a time, one unit each", async () => {
    const yt = fakeYoutube({
      videos: (q) => q.get("pageToken")
        ? { body: { items: [video("v3", { views: 300 })] } }
        : { body: { items: [video("v1", { views: 100 }), video("v2", { views: 2000 })], nextPageToken: "p2" } },
    });
    const c = new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW });
    const doc = await c.crawl(CrawlRequestSchema.parse({ kind: "trending", region: "VN", max: 3, category: "19" }));
    expect(StudioCrawlSchema.parse(doc)).toBeTruthy();
    expect(doc.videos.map((v) => v.video_id)).toEqual(["v1", "v2", "v3"]);
    expect(yt.calls[0]!.query.get("chart")).toBe("mostPopular");
    expect(yt.calls[0]!.query.get("regionCode")).toBe("VN");
    expect(yt.calls[0]!.query.get("videoCategoryId")).toBe("19");
    expect(doc).toMatchObject({ source: "youtube_api", quota_units: 2, notes: [] });
    expect(doc.videos.find((v) => v.video_id === "v2")!.outlier).toBe(true);
  });

  it("topic: a search by views in the window, then the numbers; cached for the day", async () => {
    const yt = fakeYoutube({
      search: () => ({ body: { items: [{ id: { videoId: "a" } }, { id: { videoId: "b" } }] } }),
      videos: () => ({ body: { items: [video("a", { views: 50, title: "Phố cổ Hội An về đêm" }), video("b", { views: 900, title: "Phố cổ Hà Nội" })] } }),
    });
    const cache = memoryCache();
    const c = new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW, cache });
    const doc = await c.crawl(CrawlRequestSchema.parse({ kind: "topic", q: "phố cổ", max: 20, days: 30 }));
    expect(doc.videos.map((v) => v.video_id)).toEqual(["b", "a"]);
    const search = yt.calls.find((x) => x.resource === "search")!.query;
    expect(Object.fromEntries(["q", "type", "order", "regionCode", "relevanceLanguage", "maxResults"].map((k) => [k, search.get(k)])))
      .toEqual({ q: "phố cổ", type: "video", order: "viewCount", regionCode: "VN", relevanceLanguage: "vi", maxResults: "20" });
    expect(Date.parse(search.get("publishedAfter")!)).toBe(NOW.getTime() - 30 * 86400_000);
    expect(doc.quota_units).toBe(101);
    expect(doc.insights.top_title_terms.map((t) => t.term)).toContain("phố cổ");
    await new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW, cache }).crawl(CrawlRequestSchema.parse({ kind: "topic", q: "phố cổ", max: 20, days: 30 }));
    expect(yt.calls.filter((x) => x.resource === "search")).toHaveLength(1);
  });

  it("top channels: channels of the topic by subscribers, each with its best recent videos", async () => {
    const yt = fakeYoutube({
      search: () => ({ body: { items: [{ id: { channelId: "UCa" } }, { id: { channelId: "UCb" } }] } }),
      channels: () => ({ body: { items: [
        { id: "UCa", snippet: { title: "Kênh A" }, statistics: { subscriberCount: "1000", videoCount: "50", viewCount: "90000" }, contentDetails: { relatedPlaylists: { uploads: "UUa" } } },
        { id: "UCb", snippet: { title: "Kênh B" }, statistics: { subscriberCount: "5000", videoCount: "10", viewCount: "20000" }, contentDetails: { relatedPlaylists: { uploads: "UUb" } } },
      ] } }),
      playlistItems: (q) => ({ body: { items: [{ contentDetails: { videoId: `${q.get("playlistId")}-1` } }, { contentDetails: { videoId: `${q.get("playlistId")}-2` } }] } }),
      videos: (q) => ({ body: { items: q.get("id")!.split(",").map((id, i) => video(id, { views: (i + 1) * 100, channel: id.slice(2, 3) })) } }),
    });
    const doc = await new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW }).crawl(CrawlRequestSchema.parse({ kind: "top_channels", q: "du lịch", max: 2 }));
    expect(doc.channels.map((c) => [c.title, c.subscribers, c.videos.map((v) => v.video_id)])).toEqual([
      ["Kênh B", 5000, ["UUb-2", "UUb-1"]], ["Kênh A", 1000, ["UUa-2", "UUa-1"]],
    ]);
    expect(yt.calls.find((x) => x.resource === "search")!.query.get("type")).toBe("channel");
  });

  it("channel top: the channel's most viewed videos of all time", async () => {
    const yt = fakeYoutube({
      channels: (q) => ({ body: { items: [{ id: "UCx", snippet: { title: "Kênh X" }, statistics: { subscriberCount: "42" } }].filter(() => q.get("forHandle") === "@kenhx") } }),
      search: () => ({ body: { items: [{ id: { videoId: "x1" } }, { id: { videoId: "x2" } }] } }),
      videos: () => ({ body: { items: [video("x1", { views: 10 }), video("x2", { views: 99 })] } }),
    });
    const doc = await new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW }).crawl(CrawlRequestSchema.parse({ kind: "channel_top", channel: "https://www.youtube.com/@kenhx", max: 10 }));
    expect(doc.channel).toEqual({ channel_id: "UCx", title: "Kênh X", subscribers: 42 });
    expect(doc.videos.map((v) => v.video_id)).toEqual(["x2", "x1"]);
    expect(yt.calls.find((x) => x.resource === "search")!.query.get("channelId")).toBe("UCx");
  });

  it("says when the day's quota is gone", async () => {
    const yt = fakeYoutube({ videos: () => ({ status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } }) });
    await expect(new YoutubeCrawler({ apiKey: "k", fetch: yt.impl, now: () => NOW }).crawl(CrawlRequestSchema.parse({ kind: "trending" })))
      .rejects.toThrow("Hết hạn mức YouTube Data API trong ngày");
  });
});

describe("YouTube crawl with yt-dlp (no API key)", () => {
  it("topic: YouTube's search through yt-dlp, re-sorted by views, with a note", async () => {
    const c = new YoutubeCrawler({ ytdlp: FAKE_YTDLP, now: () => NOW });
    expect(c.source).toBe("yt-dlp");
    const doc = await c.crawl(CrawlRequestSchema.parse({ kind: "topic", q: "phố cổ", max: 5, days: 30 }));
    expect(doc.videos.map((v) => v.views)).toEqual([10000, 9000, 8000, 7000, 6000]);
    expect(doc).toMatchObject({ source: "yt-dlp", quota_units: 0 });
    expect(doc.notes[0]).toContain("yt-dlp");
  });

  it("top channels: the channels of the search results, by the views found", async () => {
    const doc = await new YoutubeCrawler({ ytdlp: FAKE_YTDLP, now: () => NOW }).crawl(CrawlRequestSchema.parse({ kind: "top_channels", q: "phố cổ", max: 2 }));
    expect(doc.channels.map((c) => [c.title, c.subscribers, c.videos.length])).toEqual([["Kênh B", null, 5], ["Kênh A", null, 5]]);
  });

  it("trending needs the API", async () => {
    await expect(new YoutubeCrawler({ ytdlp: FAKE_YTDLP, now: () => NOW }).crawl(CrawlRequestSchema.parse({ kind: "trending" }))).rejects.toThrow("YOUTUBE_API_KEY");
    await expect(new YoutubeCrawler({}).crawl(CrawlRequestSchema.parse({ kind: "trending" }))).rejects.toThrow("không crawl được");
  });
});

describe("research job", () => {
  it("names files by date and what was asked", () => {
    expect(slugify("Phố cổ Hội An — đêm rằm!")).toBe("pho-co-hoi-an-dem-ram");
    expect(crawlSlug(CrawlRequestSchema.parse({ kind: "trending", region: "VN" }))).toBe("xu-huong-vn");
    expect(crawlSlug(CrawlRequestSchema.parse({ kind: "channel_top", channel: "https://www.youtube.com/@KenhX" }))).toBe("kenh-kenhx");
  });

  it("writes research/<date>-<slug>.json and .md, and tells the thread", async () => {
    const w = world();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW.toISOString(), NOW.toISOString()]);
    const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u");
    const root = join(w.dir, "workspaces");
    const dir = seedWorkspace(root, project);
    const crawler = new YoutubeCrawler({ ytdlp: FAKE_YTDLP });
    const job = createJob(w.db, { projectId: project.id, kind: "research", title: "Chủ đề phố cổ", request: { crawl: { kind: "topic", q: "phố cổ", max: 5, days: 3650 } }, createdBy: "u" });
    const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "research" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { research: researchHandler({ db: w.db, crawler }) } });
    runner.tick();
    await runner.idle();
    const done = getJob(w.db, job.id)!;
    expect(done.status).toBe("done");
    const day = new Date().toISOString().slice(0, 10);
    const base = `research/${day}-chu-de-pho-co`;
    expect(JSON.parse(done.result!)).toMatchObject({ files: [`${base}.md`, `${base}.json`], videos: 5, source: "yt-dlp" });
    expect(StudioCrawlSchema.parse(JSON.parse(readFileSync(join(dir, `${base}.json`), "utf8"))).videos).toHaveLength(5);
    const md = readFileSync(join(dir, `${base}.md`), "utf8");
    expect(md).toContain('# Video xem nhiều: "phố cổ" (VN, 3650 ngày)');
    expect(md).toContain("| 1 | [Phố cổ 10](https://www.youtube.com/watch?v=srch0000010) | Kênh B | 10.000 |");
    expect(md).toContain("## Nhận xét nhanh");
    // the same crawl again the same day goes next to it
    createJob(w.db, { projectId: project.id, kind: "research", title: "Lại", request: { crawl: { kind: "topic", q: "phố cổ", max: 5, days: 3650 } }, createdBy: "u" });
    runner.tick();
    await runner.idle();
    expect(existsSync(join(dir, `${base}-2.md`))).toBe(true);
  });

  it("YouTube blocking the server: the job says so plainly, with its code and the way that is not blocked", async () => {
    const w = world();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW.toISOString(), NOW.toISOString()]);
    const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u");
    const root = join(w.dir, "workspaces");
    seedWorkspace(root, project);
    const crawler = new YoutubeCrawler({ ytdlp: ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs"), "--fake-blocked"] }) });
    const job = createJob(w.db, { projectId: project.id, kind: "research", title: "Chủ đề phố cổ", request: { crawl: { kind: "topic", q: "phố cổ", max: 5, days: 3650 } }, createdBy: "u" });
    const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "research" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { research: researchHandler({ db: w.db, crawler }) } });
    runner.tick();
    await runner.idle();
    const failed = getJob(w.db, job.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^yt-dlp không tìm được: YouTube đang chặn tải từ máy chủ Studio/);
    expect(failed.error).toContain("YOUTUBE_API_KEY");
    expect(failed.error).not.toContain("cookies");
    expect(JSON.parse(failed.result!)).toEqual({ error_code: "youtube_blocked" });
  });
});
