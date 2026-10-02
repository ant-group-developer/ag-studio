import { describe, expect, it } from "vitest";
import { StudioResearchSchema } from "@harness/contracts";
import {
  durationBucket, estimateQuota, median, parseChannelInput, parseIsoDuration, titleTerms, YoutubeResearchSource,
  type ResearchCache,
} from "../src/youtube-research.js";

const NOW = new Date("2026-09-30T00:00:00Z");
const CHANNEL = "UC" + "a".repeat(22);

function video(id: string, o: { views: number; daysAgo: number; duration?: string; title?: string; tags?: string[]; channel?: string }) {
  return {
    id,
    snippet: {
      channelId: o.channel ?? CHANNEL, channelTitle: o.channel ? `Kênh ${o.channel}` : "Kênh A", title: o.title ?? `Video ${id}`,
      publishedAt: new Date(NOW.getTime() - o.daysAgo * 86400_000).toISOString(), tags: o.tags ?? [],
    },
    statistics: { viewCount: String(o.views), likeCount: "10", commentCount: "2" },
    contentDetails: { duration: o.duration ?? "PT5M" },
  };
}

/** A fake YouTube Data API: answers by resource, records every call. */
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

function memoryCache(): ResearchCache & { store: Map<string, { body: string; fetchedAt: string }> } {
  const store = new Map<string, { body: string; fetchedAt: string }>();
  return { store, async get(k) { return store.get(k) ?? null; }, async set(k, body, fetchedAt) { store.set(k, { body, fetchedAt }); } };
}

/** Reference channels as the research query takes them. */
const ref = (...urls: string[]) => urls.map((url) => ({ url, role: "reference" as const }));

describe("parseChannelInput", () => {
  it.each([
    [CHANNEL, { kind: "id", value: CHANNEL }],
    ["@AnUongVietNam", { kind: "handle", value: "@AnUongVietNam" }],
    ["https://www.youtube.com/@AnUongVietNam/videos", { kind: "handle", value: "@AnUongVietNam" }],
    [`youtube.com/channel/${CHANNEL}`, { kind: "id", value: CHANNEL }],
    ["https://www.youtube.com/user/oldname", { kind: "username", value: "oldname" }],
    ["https://www.youtube.com/c/Custom", { kind: "handle", value: "@Custom" }],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://youtu.be/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
  ])("%s", (input, expected) => {
    expect(parseChannelInput(input)).toEqual(expected);
  });

  it("rejects what is not YouTube", () => {
    expect(parseChannelInput("https://vimeo.com/123")).toBeNull();
    expect(parseChannelInput("   ")).toBeNull();
  });
});

describe("helpers", () => {
  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1M")).toBe(86460);
    expect(parseIsoDuration(undefined)).toBe(0);
    expect(parseIsoDuration("P0D")).toBe(0);
  });
  it("median, buckets, quota", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(durationBucket(30)).toBe("<1m");
    expect(durationBucket(400)).toBe("5-10m");
    expect(estimateQuota(2, 1)).toBe(2 * 3 + 201);
  });
  it("title terms skip function words and add bigrams", () => {
    expect(titleTerms("Phở bò của Hà Nội")).toEqual(["phở", "bò", "hà", "nội", "phở bò", "bò hà", "hà nội"]);
  });
});

describe("YoutubeResearchSource", () => {
  const brief = { production_id: "p1", channels: ref("@KenhA"), keywords: ["phở hà nội"] };

  it("researches a channel and a keyword into a valid document", async () => {
    const uploads = [
      video("v0000000001", { views: 1000, daysAgo: 10, title: "Phở bò Hà Nội ngon nhất" }),
      video("v0000000002", { views: 1100, daysAgo: 11 }),
      video("v0000000003", { views: 30000, daysAgo: 12, title: "Phở bò Hà Nội gia truyền", tags: ["phở", "hà nội"] }),
      video("v0000000004", { views: 900, daysAgo: 20, duration: "PT40S" }),
    ];
    const searched = [
      video("s0000000001", { views: 50000, daysAgo: 5, channel: "UC" + "b".repeat(22), tags: ["phở", "hà nội"] }),
      video("s0000000002", { views: 2000, daysAgo: 5, channel: "UC" + "b".repeat(22) }),
    ];
    const yt = fakeYoutube({
      channels: (q) => {
        expect(q.get("forHandle")).toBe("@KenhA");
        return { body: { items: [{ id: CHANNEL, snippet: { title: "Kênh A" }, statistics: { subscriberCount: "1200" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] } };
      },
      playlistItems: () => ({ body: { items: uploads.map((v) => ({ contentDetails: { videoId: v.id } })) } }),
      search: (q) => {
        expect(q.get("regionCode")).toBe("VN");
        expect(q.get("type")).toBe("video");
        return { body: { items: searched.map((v) => ({ id: { videoId: v.id } })) } };
      },
      videos: (q) => ({ body: { items: [...uploads, ...searched].filter((v) => q.get("id")!.split(",").includes(v.id)) } }),
    });
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW }).research(brief);
    expect(StudioResearchSchema.parse(r)).toBeTruthy();
    const ch = r.channels[0]!;
    expect(ch).toMatchObject({ channel_id: CHANNEL, title: "Kênh A", subscribers: 1200, error: null });
    expect(ch.videos).toHaveLength(4);
    expect(ch.videos.find((v) => v.video_id === "v0000000003")!.outlier).toBe(true);
    expect(ch.videos.find((v) => v.video_id === "v0000000001")!.outlier).toBe(false);
    expect(ch.stats!.shorts_ratio).toBe(0.25);
    expect(r.keywords[0]!.videos.map((v) => v.video_id)).toEqual(["s0000000001", "s0000000002"]);
    // 1 channel + 1 playlist + 1 videos (channel) + 2 searches + 1 videos (keyword)
    expect(r.quota_units).toBe(3 + 200 + 1);
    expect(r.insights.frequent_channels[0]).toMatchObject({ count: 2 });
    expect(r.insights.top_tags.map((t) => t.term)).toContain("phở");
    expect(yt.calls.every((c) => c.query.get("key") === "k")).toBe(true);
  });

  it("finds the channel of a video link", async () => {
    const yt = fakeYoutube({
      videos: (q) => ({ body: { items: q.get("part") === "snippet" ? [video("dQw4w9WgXcQ", { views: 1, daysAgo: 1 })] : [] } }),
      channels: (q) => ({ body: { items: [{ id: q.get("id"), snippet: { title: "Kênh A" }, statistics: { hiddenSubscriberCount: true }, contentDetails: { relatedPlaylists: {} } }] } }),
    });
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW })
      .research({ production_id: "p1", channels: ref("https://youtu.be/dQw4w9WgXcQ"), keywords: [] });
    expect(r.channels[0]).toMatchObject({ channel_id: CHANNEL, subscribers: null, error: null });
  });

  it("serves a repeated keyword search from the cache the same day", async () => {
    const yt = fakeYoutube({ search: () => ({ body: { items: [] } }), videos: () => ({ body: { items: [] } }) });
    const cache = memoryCache();
    const src = new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW, cache });
    await src.research({ production_id: "p1", channels: ref(), keywords: ["phở"] });
    const second = await src.research({ production_id: "p1", channels: ref(), keywords: ["phở"] });
    expect(yt.calls.filter((c) => c.resource === "search")).toHaveLength(2);
    expect(second.quota_units).toBe(0);
    expect([...cache.store.keys()].every((k) => !k.includes("key="))).toBe(true);
  });

  it("records per-entry errors and stops calling once the quota is gone", async () => {
    const yt = fakeYoutube({
      channels: () => ({ status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } }),
    });
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW })
      .research({ production_id: "p1", channels: ref("@A1c", "@B2c"), keywords: ["phở"] });
    expect(r.channels.map((c) => c.error)).toEqual(["Hết hạn mức YouTube Data API trong ngày", "Hết hạn mức YouTube Data API trong ngày"]);
    expect(r.keywords[0]!.error).toBe("Hết hạn mức YouTube Data API trong ngày");
    expect(yt.calls).toHaveLength(1);
  });

  it("skips without calling YouTube when there is nothing to research", async () => {
    const yt = fakeYoutube({});
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl }).research({ production_id: "p1", channels: ref(), keywords: [] });
    expect(r.fetched_at).toBeNull();
    expect(r.skipped_reason).toBeTruthy();
    expect(yt.calls).toHaveLength(0);
  });

  it("flags an unreadable channel input without a call", async () => {
    const yt = fakeYoutube({});
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW })
      .research({ production_id: "p1", channels: ref("không phải link"), keywords: [] });
    expect(r.channels[0]!.error).toMatch(/Không nhận ra/);
    expect(yt.calls).toHaveLength(0);
  });
});

describe("own and reference channels", () => {
  it("marks each channel's role and keeps the team's own videos out of the market insights", async () => {
    const OWN = "UC" + "o".repeat(22);
    const yt = fakeYoutube({
      channels: (q) => {
        const own = q.get("forHandle") === "@Minh";
        return { body: { items: [{ id: own ? OWN : CHANNEL, snippet: { title: own ? "Kênh mình" : "Kênh A" }, statistics: { subscriberCount: "10" }, contentDetails: { relatedPlaylists: { uploads: own ? "UUO" : "UUA" } } }] } };
      },
      playlistItems: (q) => ({
        body: { items: (q.get("playlistId") === "UUO" ? ["o0000000001", "o0000000002"] : ["a0000000001", "a0000000002"]).map((videoId) => ({ contentDetails: { videoId } })) },
      }),
      videos: (q) => ({
        body: {
          items: [
            video("o0000000001", { views: 900000, daysAgo: 3, channel: OWN, tags: ["riêng của mình"] }),
            video("o0000000002", { views: 800000, daysAgo: 3, channel: OWN, tags: ["riêng của mình"] }),
            video("a0000000001", { views: 5000, daysAgo: 3, tags: ["phở"] }),
            video("a0000000002", { views: 4000, daysAgo: 3, tags: ["phở"] }),
          ].filter((v) => q.get("id")!.split(",").includes(v.id)),
        },
      }),
    });
    const r = await new YoutubeResearchSource({ apiKey: "k", fetch: yt.impl, now: () => NOW })
      .research({ production_id: "p1", channels: [{ url: "@Minh", role: "own" }, { url: "@KenhA", role: "reference" }], keywords: [] });
    expect(r.channels.map((c) => [c.title, c.role])).toEqual([["Kênh mình", "own"], ["Kênh A", "reference"]]);
    const tags = r.insights.top_tags.map((t) => t.term);
    expect(tags).toContain("phở");
    expect(tags).not.toContain("riêng của mình");
  });
});
