import { describe, expect, it } from "vitest";
import type { StudioResearch } from "@harness/contracts";
import { researchGaps, validateWebFinds, youtubeVideoIdOf } from "../../src/studio/research-web.js";

const empty = (over: Partial<StudioResearch> = {}): StudioResearch => ({
  schema_version: "studio.research/v1", production_id: "p", fetched_at: "2026-10-08T00:00:00.000Z", quota_units: 3, skipped_reason: null,
  channels: [], keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] }, ...over,
});
const video = { video_id: "U_17EqTHUIo", channel_id: "UC1", channel_title: "Mei Time", title: "Kyoto", published_at: "2026-01-01T00:00:00Z", duration_s: 1299, views: 10, likes: null, comments: null, tags: [], views_per_day: 1, outlier: false };
const query = { channels: [{ url: "@meitime", role: "reference" as const }, { url: "@mine", role: "own" as const }], keywords: ["kyoto vlog", "phở"] };

describe("researchGaps", () => {
  it("everything asked is a gap when the research was skipped (no API key)", () => {
    expect(researchGaps(empty({ skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker", fetched_at: null }), query)).toEqual({
      channels: [{ input: "@meitime", role: "reference" }, { input: "@mine", role: "own" }], keywords: ["kyoto vlog", "phở"],
    });
  });

  it("only what YouTube refused is a gap; an existing channel or keyword with no videos is not", () => {
    const r = empty({
      channels: [
        { input: "@meitime", role: "reference", channel_id: null, title: null, subscribers: null, error: "quotaExceeded", videos: [], stats: null },
        { input: "@mine", role: "own", channel_id: "UC2", title: "Mine", subscribers: 1, error: null, videos: [], stats: null },
      ],
      keywords: [{ keyword: "kyoto vlog", error: null, videos: [video] }, { keyword: "phở", error: "YouTube search trả 500", videos: [] }],
    });
    expect(researchGaps(r, query)).toEqual({ channels: [{ input: "@meitime", role: "reference" }], keywords: ["phở"] });
  });

  it("nothing asked, nothing missing", () => {
    expect(researchGaps(empty({ skipped_reason: "Chưa nhập kênh YouTube hoặc từ khoá" }), { channels: [], keywords: [] })).toEqual({ channels: [], keywords: [] });
  });
});

describe("youtubeVideoIdOf", () => {
  it("reads the id of a watch, short, youtu.be or embed link, and nothing else", () => {
    expect(youtubeVideoIdOf("https://www.youtube.com/watch?v=U_17EqTHUIo&t=3")).toBe("U_17EqTHUIo");
    expect(youtubeVideoIdOf("https://youtu.be/U_17EqTHUIo")).toBe("U_17EqTHUIo");
    expect(youtubeVideoIdOf("https://m.youtube.com/shorts/U_17EqTHUIo")).toBe("U_17EqTHUIo");
    expect(youtubeVideoIdOf("https://www.youtube.com/@meitime")).toBeNull();
    expect(youtubeVideoIdOf("https://evil.example/watch?v=U_17EqTHUIo")).toBeNull();
    expect(youtubeVideoIdOf("https://www.youtube.com/watch?v=short")).toBeNull();
  });
});

describe("validateWebFinds", () => {
  const gaps = { channels: [{ input: "@meitime", role: "reference" as const }], keywords: ["phở"] };
  const found = (url: string) => ({ url, title: "t", views: null, duration_s: null, published_at: null });
  const finds = (over: Record<string, unknown> = {}) => ({
    schema_version: "studio.web-finds/v1", skipped: false,
    channels: [{ input: "@meitime", channel_url: "https://www.youtube.com/@meitime", title: "Mei Time", notes: "", videos: [found("https://www.youtube.com/watch?v=U_17EqTHUIo")] }],
    keywords: [{ keyword: "phở", videos: [found("https://youtu.be/AAAAAAAAAAA")] }],
    sources: [], ...over,
  });

  it("accepts YouTube links for exactly the gaps asked", () => {
    const v = validateWebFinds(finds(), { gaps });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("a link that is not a YouTube video, a channel that is not a channel, or an answer nobody asked for is a problem", () => {
    const bad = finds({
      channels: [{ input: "@other", channel_url: "https://evil.example/@x", title: null, notes: "", videos: [found("https://evil.example/v.mp4")] }],
      keywords: [],
    });
    const codes = validateWebFinds(bad, { gaps }).problems.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["not_asked", "not_youtube_channel", "not_youtube_video"]));
  });

  it("a gap Claude found nothing for is only a warning; saying skipped while gaps remain is a problem", () => {
    const v = validateWebFinds(finds({ keywords: [] }), { gaps });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(["gap_unanswered"]);
    expect(validateWebFinds(finds({ skipped: true }), { gaps }).problems.map((p) => p.code)).toContain("skipped_with_gaps");
  });
});
