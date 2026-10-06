import { describe, expect, it } from "vitest";
import {
  claudeOutputJsonSchema, SeriesPlanSchema, STUDIO_SKILL_OUTPUTS, StudioBrandingSchema, StudioResearchSchema, StudioRndSchema, StudioSeedSchema,
  type StudioSkill,
} from "../src/studio.js";

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems"];

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, visit);
}

describe("claudeOutputJsonSchema", () => {
  for (const skill of Object.keys(STUDIO_SKILL_OUTPUTS) as StudioSkill[]) {
    it(`${skill}: only keywords structured outputs accept, every object closed`, () => {
      const schema = claudeOutputJsonSchema(skill);
      expect(schema.type).toBe("object");
      walk(schema, (o) => {
        for (const k of UNSUPPORTED) expect(o, `${skill} still has ${k}`).not.toHaveProperty(k);
        if (o.type === "object") {
          expect(o.additionalProperties).toBe(false);
          expect(o.required).toEqual(Object.keys(o.properties as object));
        }
      });
    });
  }

  it("an episode's edit style is optional on disk but always answered by Claude", () => {
    const t = claudeOutputJsonSchema("studio-plan-episodes") as {
      properties: { episodes: { items: { required: string[]; properties: Record<string, { enum?: string[] }> } } };
    };
    const ep = t.properties.episodes.items;
    expect(ep.required).toEqual(expect.arrayContaining(["edit_style", "narration"]));
    expect(ep.properties.edit_style?.enum).toEqual(["whole", "cut"]);
    const plan = {
      schema_version: "studio.series-plan/v1", series_title: "S", rationale: "R",
      episodes: [{ idx: 1, title: "T", hook: "H", logline: "L", target_seconds: 60, items: [{ asset_id: "a", reason: "r", section_title: null }], alternates: [], texts_suggested: [] }],
    };
    expect(SeriesPlanSchema.parse(plan).episodes[0]!.edit_style).toBeUndefined();
    expect(SeriesPlanSchema.parse({ ...plan, episodes: [{ ...plan.episodes[0]!, edit_style: "cut", narration: "none" }] }).episodes[0]).toMatchObject({ edit_style: "cut", narration: "none" });
    expect(SeriesPlanSchema.safeParse({ ...plan, episodes: [{ ...plan.episodes[0]!, edit_style: "trim" }] }).success).toBe(false);
  });

  it("keeps the enum/const shape Claude has to follow", () => {
    const t = claudeOutputJsonSchema("studio-plan-episodes") as { properties: { schema_version: { const?: string; enum?: string[] } } };
    const v = t.properties.schema_version;
    expect(v.const ?? v.enum?.[0]).toBe("studio.series-plan/v1");
  });
});

describe("research-first documents", () => {
  it("reads research written before channels had a role as reference channels", () => {
    const doc = StudioResearchSchema.parse({
      schema_version: "studio.research/v1", production_id: "p", fetched_at: null, quota_units: 0, skipped_reason: null,
      channels: [{ input: "@a", channel_id: null, title: null, subscribers: null, error: null, videos: [], stats: null }],
      keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] },
    });
    expect(doc.channels[0]!.role).toBe("reference");
  });

  it("parses an R&D, a branding and a seed; refuses a bad colour and a bad series hashtag", () => {
    expect(StudioRndSchema.parse(RND).direction.max_episodes).toBe(4);
    expect(StudioBrandingSchema.parse(BRANDING).thumbnail.palette.accent).toBe("#E63946");
    expect(StudioBrandingSchema.safeParse({ ...BRANDING, thumbnail: { ...BRANDING.thumbnail, palette: { ...BRANDING.thumbnail.palette, text: "white" } } }).success).toBe(false);
    expect(StudioBrandingSchema.safeParse({ ...BRANDING, description: { ...BRANDING.description, hashtags: ["#Phở-HN"] } }).success).toBe(false);
    expect(StudioSeedSchema.parse(SEED).channels.map((c) => c.role)).toEqual(["own", "reference"]);
  });
});

export const RND = {
  schema_version: "studio.rnd/v1",
  summary: "Series phở sáng cho người trẻ Hà Nội.",
  market: { opportunities: ["Ít kênh quay phở sáng sớm"], gaps: [], risks: ["Trùng chủ đề với kênh lớn"], competitors: [{ channel: "Kênh A", strengths: "Quay đẹp", weaknesses: "Ra video thưa" }] },
  own_channels: { assessment: "Kênh mới, 1k subscriber", strengths: ["Footage nhiều"], weaknesses: ["Tiêu đề nhạt"], recommendations: ["Đăng đều 2 tập/tuần"] },
  footage_fit: { summary: "Nhiều cảnh phở và phố cổ", strong_themes: ["phở", "phố cổ"], gaps: ["Ít cảnh người bán"] },
  direction: {
    description: "Mỗi tập một quán phở sáng.", goal: "Tăng người xem trẻ", audience: "18–30, Hà Nội", tone: "Ấm áp",
    positioning: "Phở sáng chân thật", content_pillars: [{ name: "Quán quen", description: "Quán lâu năm" }],
    episode_target_seconds: 300, max_episodes: 4, posting_schedule: "T3, T6 19:00", keywords: ["phở Hà Nội"],
    episode_ideas: [{ title: "Phở Bát Đàn", angle: "Xếp hàng từ 6 giờ" }], notes: "",
  },
};

export const BRANDING = {
  schema_version: "studio.branding/v1",
  series_name: "Phở Sáng", tagline: "Một bát phở, một buổi sáng", positioning: "Phở sáng chân thật cho người trẻ",
  voice: { personality: ["ấm áp"], do: ["kể như bạn bè"], dont: ["giật tít"], signature_phrases: ["Sáng nay ăn gì?"], banned_words: ["sốc"] },
  titles: { formulas: ["[Quán] — [điều bất ngờ]"], rules: ["≤ 60 ký tự"], examples: ["Phở Bát Đàn — xếp hàng từ 6 giờ"], max_chars: 60 },
  description: { opening: "Sáng nay mình ghé…", cta: "Theo dõi kênh để xem tập sau", hashtags: ["#PhởSáng"] },
  thumbnail: {
    concept: "Cận cảnh bát phở bốc khói", text_rules: ["2–4 chữ"], max_words: 4, text_case: "upper",
    palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "thèm", do: ["khói"], dont: ["chữ nhỏ"],
  },
  on_screen_text: { style: "Chữ trắng viền đen", max_chars: 40, rules: [] },
  music_mood: ["ấm áp"],
};

export const SEED = {
  schema_version: "studio.seed/v1", production_id: "p", run_id: "run_1", owner_user_id: "u", title: "Phở sáng",
  folder_ids: ["f1"], channels: [{ url: "@kenhminh", role: "own" }, { url: "@kenhA", role: "reference" }], keywords: ["phở"],
  aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null,
  hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: null, max_episodes: 4 },
};
