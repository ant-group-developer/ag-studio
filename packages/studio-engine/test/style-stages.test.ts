/** Plan 3.2.0: picking the reference videos, keeping the approved style, and the brief carrying it. */
import { describe, expect, it } from "vitest";
import type { StudioBranding, StudioResearch, StudioRnd, StudioStyle, StyleRefs } from "@harness/contracts";
import { STUDIO_TYPES } from "@harness/core";
import { getProduction, productionStyle, saveProductionDocument, studioInProcessStages, type StudioStageDeps } from "../src/index.js";
import { fakeFootage, seedProduction, world, STYLE } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const RUN = "run_plan";

function setup() {
  const w = world();
  const prod = seedProduction(w.db);
  w.db.run("UPDATE productions SET run_id = ? WHERE id = ?", [RUN, prod]);
  const d: StudioStageDeps = { db: w.db, bucket: w.bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }) };
  return { ...w, prod, stages: studioInProcessStages(d) };
}

const seed = (prod: string) => ({
  schema_version: "studio.seed/v1", production_id: prod, run_id: RUN, owner_user_id: "auth0|owner", title: "Phở", folder_ids: ["folder-a"],
  channels: [{ url: "@meitime", role: "reference" }], keywords: [], aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null,
  hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: 1200, max_episodes: null },
});
const video = (id: string, duration_s: number, views_per_day: number) => ({
  video_id: id.padEnd(11, "x"), channel_id: "UCmei", channel_title: "Mei Time", title: id, published_at: "2026-06-01T00:00:00Z", duration_s,
  views: views_per_day * 10, likes: null, comments: null, tags: [], views_per_day, outlier: false,
});
const research = (prod: string): StudioResearch => ({
  schema_version: "studio.research/v1", production_id: prod, fetched_at: "2026-10-08T00:00:00Z", quota_units: 3, skipped_reason: null,
  channels: [{ input: "@meitime", role: "reference", channel_id: "UCmei", title: "Mei", subscribers: null, error: null, stats: null,
    videos: [video("a", 1250, 5), video("b", 30, 99), video("c", 900, 1)] }],
  keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] },
});
const RND: StudioRnd = {
  schema_version: "studio.rnd/v1", summary: "Series phở sáng.", market: { opportunities: [], gaps: [], risks: [], competitors: [] }, own_channels: null,
  footage_fit: { summary: "Nhiều cảnh phở", strong_themes: ["phở"], gaps: [] },
  direction: { description: "Mỗi tập một quán.", goal: "Người xem trẻ", audience: "18–30", tone: "Ấm áp", positioning: "Chân thật",
    content_pillars: [{ name: "Quán quen", description: "Quán lâu năm" }], episode_target_seconds: 300, max_episodes: 2, posting_schedule: "", keywords: ["phở"], episode_ideas: [], notes: "" },
};
const BRANDING: StudioBranding = {
  schema_version: "studio.branding/v1", series_name: "Phở Sáng", tagline: "", positioning: "Chân thật",
  voice: { personality: [], do: [], dont: [], signature_phrases: [], banned_words: [] },
  titles: { formulas: ["[Quán]"], rules: [], examples: ["Phở Bát Đàn"], max_chars: 40 }, description: { opening: "", cta: "", hashtags: [] },
  thumbnail: { concept: "Bát phở", text_rules: [], max_words: 3, text_case: "upper", palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "", do: [], dont: [] },
  on_screen_text: { style: "", max_chars: 40, rules: [] }, music_mood: [],
};

describe("style stages (plan 3.2.0)", () => {
  it("pick-references: long-form uploads of the reference channel nearest the series' episode length", async () => {
    const s = setup();
    const run = stageWorkspace({ runId: RUN, inputs: [
      { type: STUDIO_TYPES.seed, name: "seed.json", json: seed(s.prod) },
      { type: STUDIO_TYPES.research, name: "research.json", json: research(s.prod) },
    ] });
    await runStage(s.stages["studio-pick-references"], run);
    const refs = run.json<StyleRefs>("references.json");
    expect(refs).toMatchObject({ schema_version: "studio.style-refs/v1", production_id: s.prod, target_seconds: 1200, skipped_reason: null });
    expect(refs.picks.map((p) => p.video_id[0])).toEqual(["a", "c"]);
  });

  it("apply-style: the approved style, or a skipped one, becomes the production's", async () => {
    const s = setup();
    const run = stageWorkspace({ runId: RUN, inputs: [{ type: STUDIO_TYPES.style, name: "style.json", json: STYLE }] });
    await runStage(s.stages["studio-apply-style"], run);
    const p = getProduction(s.db, s.prod)!;
    expect(productionStyle(p)?.name).toBe("Chậm");
    expect(p.style_updated_by).toBe(`gate:${RUN}`);
  });

  it("finalize-brief-v2 carries the production's style; a skipped style, or the first version, does not", async () => {
    const s = setup();
    saveProductionDocument(s.db, s.prod, "rnd", RND, "u");
    saveProductionDocument(s.db, s.prod, "branding", BRANDING, "u");
    saveProductionDocument(s.db, s.prod, "style", STYLE, "u");
    const inputs = [{ type: STUDIO_TYPES.seed, name: "seed.json", json: seed(s.prod) }];
    const v2 = stageWorkspace({ runId: RUN, inputs });
    await runStage(s.stages["studio-finalize-brief-v2"], v2);
    expect(v2.json<StudioStyle>("style.json").name).toBe("Chậm");
    const v1 = stageWorkspace({ runId: RUN, inputs });
    await runStage(s.stages["studio-finalize-brief"], v1);
    expect(v1.has("style.json")).toBe(false);
    saveProductionDocument(s.db, s.prod, "style", { ...STYLE, skipped: true, skipped_reason: "Chưa nhập kênh tham khảo", params: null, measured: null, references: [], evidence: [] }, "u");
    const skipped = stageWorkspace({ runId: RUN, inputs });
    await runStage(s.stages["studio-finalize-brief-v2"], skipped);
    expect(skipped.has("style.json")).toBe(false);
    expect(skipped.has("brief.json")).toBe(true);
  });
});
