import { describe, expect, it } from "vitest";
import type { StudioBranding, StudioCatalog, StudioEpisode, StudioHints, StudioRnd, StudioSeed, YoutubeKit } from "@harness/contracts";
import { effectiveBrief, type BriefBase } from "../../src/studio/brief.js";
import { summarizeCatalog } from "../../src/studio/catalog.js";
import { contrastRatio, isFollowUpWarning, validateBranding, validateRnd, validateYoutubeKit } from "../../src/studio/validate.js";

const hints = (over: Partial<StudioHints> = {}): StudioHints => ({
  description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: null, max_episodes: null, ...over,
});

const seed = (over: Partial<StudioSeed> = {}): StudioSeed => ({
  schema_version: "studio.seed/v1", production_id: "p", run_id: "run_1", owner_user_id: "u", title: "Phở sáng",
  folder_ids: ["f1"], channels: [{ url: "@kenhA", role: "reference" }], keywords: ["phở"],
  aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null, hints: hints(), ...over,
});

const rnd = (over: Partial<StudioRnd["direction"]> = {}, own: StudioRnd["own_channels"] = null): StudioRnd => ({
  schema_version: "studio.rnd/v1", summary: "Series phở sáng.",
  market: { opportunities: [], gaps: [], risks: [], competitors: [] },
  own_channels: own,
  footage_fit: { summary: "Nhiều cảnh phở", strong_themes: ["phở"], gaps: [] },
  direction: {
    description: "Mỗi tập một quán phở.", goal: "Người xem trẻ", audience: "18–30", tone: "Ấm áp", positioning: "Chân thật",
    content_pillars: [{ name: "Quán quen", description: "Quán lâu năm" }], episode_target_seconds: 300, max_episodes: 4,
    posting_schedule: "", keywords: ["Phở Hà Nội", "phở"], episode_ideas: [], notes: "Quay buổi sáng", ...over,
  },
});

const branding = (over: Partial<StudioBranding> = {}): StudioBranding => ({
  schema_version: "studio.branding/v1", series_name: "Phở Sáng", tagline: "", positioning: "Chân thật",
  voice: { personality: [], do: [], dont: [], signature_phrases: [], banned_words: ["sốc"] },
  titles: { formulas: ["[Quán] — [điều bất ngờ]"], rules: [], examples: ["Phở Bát Đàn — xếp hàng từ 6 giờ"], max_chars: 40 },
  description: { opening: "", cta: "", hashtags: ["#PhởSáng"] },
  thumbnail: {
    concept: "Cận cảnh bát phở", text_rules: [], max_words: 3, text_case: "upper",
    palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "", do: [], dont: [],
  },
  on_screen_text: { style: "", max_chars: 40, rules: [] },
  music_mood: [],
  ...over,
});

describe("validateRnd", () => {
  it("passes an R&D within the hints", () => {
    const v = validateRnd(rnd(), { seed: seed({ hints: hints({ max_episodes: 4 }) }) });
    expect(v).toMatchObject({ ok: true, problems: [], warnings: [] });
  });

  it("warns (hint_*) when the direction leaves the numbers the person typed; the executor makes Claude fix those", () => {
    const v = validateRnd(rnd({ episode_target_seconds: 600, max_episodes: 6 }), { seed: seed({ hints: hints({ episode_target_seconds: 300, max_episodes: 4 }) }) });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(["hint_episode_target", "hint_max_episodes"]);
    expect(v.warnings.every(isFollowUpWarning)).toBe(true);
  });

  it("needs the own channels assessed when the person named some, and distinct pillar names", () => {
    const own = seed({ channels: [{ url: "@minh", role: "own" }] });
    const pillars = [{ name: "Quán quen", description: "a" }, { name: "quán quen", description: "b" }];
    const v = validateRnd(rnd({ content_pillars: pillars }), { seed: own });
    expect(v.problems.map((p) => p.code)).toEqual(["own_channels_missing", "duplicate_pillar"]);
    const assessed = validateRnd(rnd({}, { assessment: "Kênh mới", strengths: [], weaknesses: [], recommendations: [] }), { seed: own });
    expect(assessed.ok).toBe(true);
  });

  it("reports schema problems as Vietnamese-path messages", () => {
    const v = validateRnd({ schema_version: "studio.rnd/v1" }, { seed: seed() });
    expect(v.ok).toBe(false);
    expect(v.problems[0]!.code).toBe("schema");
  });
});

describe("validateBranding", () => {
  it("the text look must read on its box, or on its outline when it has no box", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    const look = (text_color: string, outline_color: string, box_color: string | null) =>
      branding({ on_screen_text: { ...branding().on_screen_text, look: { text_color, outline_color, box_color, size: "m" } } });
    expect(validateBranding(look("#FFFFFF", "#000000", "#1D3557")).ok).toBe(true);
    expect(validateBranding(look("#FFFFFF", "#000000", null)).ok).toBe(true);
    const onBox = validateBranding(look("#FFFFFF", "#000000", "#F1FAEE"));
    expect(onBox.problems).toEqual([expect.objectContaining({ code: "text_look_no_contrast", message: expect.stringContaining("hộp #F1FAEE") })]);
    expect(validateBranding(look("#FFFF00", "#FFFFFF", null)).problems.map((p) => p.code)).toEqual(["text_look_no_contrast"]);
    expect(validateBranding(look("#FFFFFF", "#000000", "#000")).problems[0]?.code).toBe("schema");
  });

  it("refuses unreadable thumbnail colours and warns about examples off the rules", () => {
    const v = validateBranding(branding({
      titles: { formulas: ["x"], rules: [], examples: ["Một tiêu đề rất dài vượt quá bốn mươi ký tự cho phép", "Tin sốc về phở"], max_chars: 40 },
      thumbnail: { ...branding().thumbnail, palette: { text: "#ffffff", outline: "#FFFFFF", accent: "#E63946" } },
    }));
    expect(v.problems.map((p) => p.code)).toEqual(["palette_no_contrast"]);
    expect(v.warnings.map((p) => p.code)).toEqual(["example_too_long", "example_banned_word"]);
  });
});

describe("validateYoutubeKit with a branding", () => {
  const episode = { items: [{ asset_id: "a1", reason: "r", section_title: null }] } as unknown as StudioEpisode;
  const kit = (over: Partial<YoutubeKit> = {}): YoutubeKit => ({
    schema_version: "studio.youtube-kit/v1", titles: ["Phở Bát Đàn", "Phở Lý Quốc Sư", "Phở Thìn"], description: "Sáng nay ăn phở",
    tags: ["phở"], hashtags: ["#PhởSáng"], thumbnails: [{ asset_id: "a1", text: "PHỞ NGON" }, { asset_id: "a1", text: "XẾP HÀNG" }, { asset_id: "a1", text: "6 GIỜ SÁNG" }],
    playlist: "Phở Sáng", ...over,
  });

  it("passes a kit that follows the branding", () => {
    expect(validateYoutubeKit(kit(), { episode, branding: branding() }).warnings).toEqual([]);
  });

  it("warns (branding_*) on a long title, a banned word, too many or lower-case thumbnail words, a missing series hashtag", () => {
    const v = validateYoutubeKit(kit({
      titles: ["Phở Bát Đàn và câu chuyện xếp hàng lúc sáu giờ sáng", "Tin sốc: phở", "Phở Thìn"],
      thumbnails: [{ asset_id: "a1", text: "Phở ngon" }, { asset_id: "a1", text: "XẾP HÀNG DÀI QUÁ" }, { asset_id: "a1", text: "OK" }],
      hashtags: [],
    }), { episode, branding: branding() });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual([
      "branding_title_too_long", "branding_banned_word", "branding_thumbnail_case", "branding_thumbnail_words", "branding_hashtag_missing",
    ]);
    expect(validateYoutubeKit(kit({ hashtags: [] }), { episode }).warnings).toEqual([]);
  });
});

describe("effectiveBrief", () => {
  const base: BriefBase = {
    production_id: "p", run_id: "run_2", owner_user_id: "u", title: "Phở sáng", folder_ids: ["f1"], aspect: "16:9",
    canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null, youtube_channels: ["@kenhA"], keywords: ["phở", "bún"],
  };

  it("takes the approved R&D's direction and merges its SEO keywords after the research keywords", () => {
    const b = effectiveBrief(base, hints({ goal: "cũ", episode_target_seconds: 120 }), rnd());
    expect(b).toMatchObject({
      description: "Mỗi tập một quán phở.", goal: "Người xem trẻ", tone: "Ấm áp", notes: "Quay buổi sáng",
      episode_target_seconds: 300, max_episodes: 4, keywords: ["phở", "bún", "Phở Hà Nội"],
    });
  });

  it("keeps what the person typed when there is no R&D, and refuses without length and count", () => {
    expect(effectiveBrief(base, hints({ description: "Chủ đề", episode_target_seconds: 120, max_episodes: 2 }), null))
      .toMatchObject({ description: "Chủ đề", episode_target_seconds: 120, max_episodes: 2, goal: "" });
    expect(effectiveBrief(base, hints({ episode_target_seconds: 120, max_episodes: 2 }), null).description).toBe("Phở sáng");
    expect(() => effectiveBrief(base, hints(), null)).toThrow(/R&D/);
  });
});

describe("summarizeCatalog", () => {
  it("counts what the footage is about and samples it evenly", () => {
    const assets = Array.from({ length: 10 }, (_, i) => ({
      asset_id: `a${i}`, name: `v${i}`, title_vi: i % 2 ? `Phở ${i}` : "", summary_vi: "x".repeat(200), duration_s: 30.4, orientation: i < 8 ? "landscape" : null,
      genre: "food", topics: ["phở", i < 3 ? "phố cổ" : "chợ"], subjects: [], places: ["Hà Nội"], actions: [], keywords_vi: [], tags: [],
      mood: "ấm", setting: "", time_of_day: "morning", people_count: "", shot_variety: ["close-up"], has_speech: i === 0, quality: 4,
      usable: true, approved: false, project_names: [],
    }));
    const c: StudioCatalog = { schema_version: "studio.catalog/v2", production_id: "p", folder_ids: ["f1"], total_available: 12, truncated: false, assets };
    const s = summarizeCatalog(c, { samples: 4 });
    expect(s).toMatchObject({ total_available: 12, kept: 10, total_duration_s: 304, with_speech: 1 });
    expect(s.top.topics).toEqual([{ term: "phở", count: 10 }, { term: "chợ", count: 7 }, { term: "phố cổ", count: 3 }]);
    expect(s.orientations).toEqual([{ term: "landscape", count: 8 }, { term: "unknown", count: 2 }]);
    expect(s.samples.map((x) => x.asset_id)).toEqual(["a0", "a2", "a5", "a7"]);
    expect(s.samples[0]!.title).toBe("v0");
    expect(s.samples[0]!.summary.length).toBe(158);
  });
});
