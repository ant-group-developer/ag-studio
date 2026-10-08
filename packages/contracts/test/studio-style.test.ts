import { describe, expect, it } from "vitest";
import {
  claudeOutputJsonSchema, STUDIO_FILE_SKILLS, STUDIO_SKILL_STEP, STUDIO_WEB_SKILLS, StudioResearchSchema, StudioStyleSchema, StudioWebFindsSchema,
  StyleRefsSchema, StyleWatchSchema, TEAM_SKILL_STEPS,
} from "../src/index.js";

const measured = { videos: 2, shots: 180, cuts_per_minute: 9.2, shot_seconds: { p25: 4.1, median: 6.5, p75: 9 }, first_shot_s: 2.1 };

export const style = {
  schema_version: "studio.style/v1", skipped: false, skipped_reason: null,
  name: "Du lịch chậm, ít chữ", summary: "Cảnh dài 5–8 giây, mở bằng montage ngắn, chữ serif nhỏ.",
  references: [{ video_id: "U_17EqTHUIo", title: "Kyoto in the rain", channel_title: "Mei Time", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", duration_s: 1299 }],
  measured,
  params: {
    cut_rhythm: "slow", shot_seconds: { min: 5, max: 8 }, transitions: ["cut"], opening: { seconds: 16, structure: "montage 8 cảnh rồi thẻ tiêu đề" },
    text_overlay: { density: "low", style: "serif nhỏ góc dưới trái" }, subtitles: "none", voice: "none", music: { mood: "calm", ducking: null },
    visual: "màu ấm, khung rộng", pace_notes: "giữ cảnh lâu khi có chuyển động chậm",
  },
  do: ["Mở bằng montage cảnh ~2 giây"], dont: ["Không đốt phụ đề"],
  evidence: [{ param: "opening", video_id: "U_17EqTHUIo", t: 2.5, note: "cảnh mở đầu ngắn" }],
};

describe("studio.style/v1", () => {
  it("holds a learned style, and a skipped one that says why", () => {
    expect(StudioStyleSchema.parse(style).params?.cut_rhythm).toBe("slow");
    const skipped = { ...style, skipped: true, skipped_reason: "Chưa nhập kênh tham khảo", references: [], measured: null, params: null, do: [], dont: [], evidence: [] };
    expect(StudioStyleSchema.parse(skipped).skipped).toBe(true);
  });

  it("refuses a reference that is not a YouTube video id", () => {
    expect(() => StudioStyleSchema.parse({ ...style, references: [{ ...style.references[0], video_id: "x; rm -rf /" }] })).toThrow();
  });

  it("is a files-mode skill whose output schema Claude can be given, every key required", () => {
    expect(STUDIO_FILE_SKILLS.has("studio-style")).toBe(true);
    const js = claudeOutputJsonSchema("studio-style") as { required: string[]; additionalProperties: boolean };
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(expect.arrayContaining(["params", "measured", "evidence"]));
    expect(TEAM_SKILL_STEPS).toContain(STUDIO_SKILL_STEP["studio-style"]);
  });

  it("the references picked and what watching them measured", () => {
    expect(StyleRefsSchema.parse({
      schema_version: "studio.style-refs/v1", production_id: "p", target_seconds: 1200, skipped_reason: null,
      picks: [{ video_id: "U_17EqTHUIo", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", channel_id: "UC1", channel_title: "Mei Time", title: "Kyoto", duration_s: 1299, views: 10, views_per_day: 1, published_at: "2026-01-01T00:00:00Z", reason: "gần thời lượng đích" }],
    }).picks).toHaveLength(1);
    expect(StyleWatchSchema.parse({
      schema_version: "studio.style-watch/v1", production_id: "p", skipped_reason: null, measured,
      videos: [{ label: "R1", video_id: "U_17EqTHUIo", title: "Kyoto", duration_s: 1299, error: null, measured, cuts: [2.1, 4.4],
        frames: [{ t: 2.5, file: "R1/f-2.500.jpg", kind: "opening", key: "productions/p/style/U_17EqTHUIo/f-2.500.jpg" }],
        sheets: [{ file: "R1/sheet-01.jpg", frames: [2.5] }] }],
    }).videos).toHaveLength(1);
  });
});

describe("research found on the web", () => {
  it("research says where its numbers come from; a video whose numbers Claude read off a page is estimated", () => {
    const base = { schema_version: "studio.research/v1", production_id: "p", fetched_at: null, quota_units: 0, skipped_reason: null, channels: [], keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] } };
    expect(StudioResearchSchema.parse(base).source).toBeUndefined(); // older documents: the YouTube API
    const video = { video_id: "U_17EqTHUIo", channel_id: "UC1", channel_title: "Mei Time", title: "Kyoto", published_at: "2026-01-01T00:00:00Z", duration_s: 1299, views: 10, likes: null, comments: null, tags: [], views_per_day: 1, outlier: false, estimated: true };
    const web = StudioResearchSchema.parse({ ...base, source: "web", keywords: [{ keyword: "kyoto", error: null, videos: [video] }] });
    expect(web.keywords[0]!.videos[0]!.estimated).toBe(true);
  });

  it("Claude's finds: links and the numbers it could read, for the gaps it was asked about", () => {
    const finds = StudioWebFindsSchema.parse({
      schema_version: "studio.web-finds/v1", skipped: false,
      channels: [{ input: "@meitime", channel_url: "https://www.youtube.com/@meitime", title: "Mei Time", notes: "",
        videos: [{ url: "https://www.youtube.com/watch?v=U_17EqTHUIo", title: "Kyoto in the rain", views: null, duration_s: 1299, published_at: null }] }],
      keywords: [], sources: ["https://www.youtube.com/@meitime/videos"],
    });
    expect(finds.channels[0]!.videos).toHaveLength(1);
    expect(STUDIO_WEB_SKILLS.has("studio-web-research")).toBe(true);
    expect((claudeOutputJsonSchema("studio-web-research") as { required: string[] }).required).toEqual(expect.arrayContaining(["channels", "keywords"]));
  });
});
