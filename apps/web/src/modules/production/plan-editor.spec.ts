/**
 * vitest unit tests for:
 * 1. Plan editor ops: SeriesPlanSchema.parse passes after edits
 * 2. YouTube kit: tags ≤ 500 chars (YOUTUBE_TAGS_MAX_CHARS)
 */
import { describe, expect, it } from "vitest";
import { SeriesPlanSchema, YOUTUBE_TAGS_MAX_CHARS } from "@harness/contracts";
import type { SeriesPlan, PlannedEpisode } from "@harness/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEpisode(idx: number): PlannedEpisode {
  return {
    idx,
    title: `Tập ${idx}`,
    hook: "hook text",
    logline: "logline text",
    target_seconds: 300,
    items: [{ asset_id: `asset-${idx}-1`, reason: "good clip", section_title: null }],
    alternates: [],
    texts_suggested: [],
  };
}

function makePlan(episodeCount = 2): SeriesPlan {
  return {
    schema_version: "studio.series-plan/v1",
    series_title: "Test Series",
    rationale: "Test rationale",
    episodes: Array.from({ length: episodeCount }, (_, i) => makeEpisode(i + 1)),
  };
}

// ---------------------------------------------------------------------------
// SeriesPlan schema tests
// ---------------------------------------------------------------------------
describe("SeriesPlanSchema", () => {
  it("parses a minimal valid plan", () => {
    const plan = makePlan(1);
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("parses after adding an episode", () => {
    const plan = makePlan(2);
    plan.episodes.push(makeEpisode(3));
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("parses after removing an episode item and reindexing", () => {
    const plan = makePlan(3);
    // Remove episode 2, reindex
    plan.episodes = plan.episodes.filter((e) => e.idx !== 2).map((e, i) => ({ ...e, idx: i + 1 }));
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    expect(result.data?.episodes).toHaveLength(2);
  });

  it("parses after reordering items within an episode", () => {
    const plan = makePlan(1);
    const ep = plan.episodes[0]!;
    ep.items.push({ asset_id: "asset-2", reason: "second", section_title: "New section" });
    // Swap order
    ep.items = [ep.items[1]!, ep.items[0]!];
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("parses after updating a section_title", () => {
    const plan = makePlan(1);
    plan.episodes[0]!.items[0]!.section_title = "Mở đầu";
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("fails when no episodes", () => {
    const plan = makePlan(0);
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("fails when an episode has no items", () => {
    const plan = makePlan(1);
    plan.episodes[0]!.items = [];
    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// YouTube tags ≤ 500 chars
// ---------------------------------------------------------------------------
describe("YouTube tags character counter", () => {
  const tagsChars = (tags: string[]) => tags.join(",").length;

  it("YOUTUBE_TAGS_MAX_CHARS is 500", () => {
    expect(YOUTUBE_TAGS_MAX_CHARS).toBe(500);
  });

  it("tags within limit pass", () => {
    const tags = ["phở", "Hà Nội", "buổi sáng", "ẩm thực"];
    expect(tagsChars(tags)).toBeLessThanOrEqual(YOUTUBE_TAGS_MAX_CHARS);
  });

  it("tags at exactly 500 chars pass", () => {
    const tag = "a".repeat(100);
    const tags = Array.from({ length: 4 }, () => tag); // 4*100 + 3 commas = 403 — under limit
    // Build tags that total exactly 500 chars joined by commas
    const budget = YOUTUBE_TAGS_MAX_CHARS;
    const shortTags: string[] = [];
    let used = 0;
    for (let i = 0; i < 5; i++) {
      const sep = i === 0 ? 0 : 1;
      const space = budget - used - sep;
      if (space <= 0) break;
      const t = "x".repeat(Math.min(space, 100));
      shortTags.push(t);
      used += sep + t.length;
    }
    expect(tagsChars(shortTags)).toBeLessThanOrEqual(YOUTUBE_TAGS_MAX_CHARS);
  });

  it("tags over 500 chars are detected as exceeding limit", () => {
    const longTags = Array.from({ length: 6 }, (_, i) => `tag${i}`.padEnd(100, "x"));
    expect(tagsChars(longTags)).toBeGreaterThan(YOUTUBE_TAGS_MAX_CHARS);
  });

  it("catalogPicker: adding a catalog asset to episode still parses the plan", () => {
    // Simulates the "Thêm video" action from CatalogPickerModal:
    // user picks an asset from the catalog; it gets appended with reason: "added"
    const plan = makePlan(1);
    const ep = plan.episodes[0]!;
    const catalogAssetId = "catalog-asset-uuid-001";

    // Simulate CatalogPickerModal onAddAsset
    ep.items = [
      ...ep.items,
      { asset_id: catalogAssetId, reason: "added", section_title: null },
    ];

    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    expect(result.data?.episodes[0]?.items).toHaveLength(2);
    expect(result.data?.episodes[0]?.items[1]?.asset_id).toBe(catalogAssetId);
    expect(result.data?.episodes[0]?.items[1]?.reason).toBe("added");
  });

  it("mergeEpisode: combining two episodes keeps both item sets", () => {
    // This is a pure function test for the merge logic used in PlanEditor
    const ep1 = makeEpisode(1);
    const ep2 = makeEpisode(2);
    ep2.items.push({ asset_id: "extra", reason: "extra", section_title: null });

    const merged: PlannedEpisode = {
      ...ep1,
      items: [...ep1.items, ...ep2.items],
      alternates: [...ep1.alternates, ...ep2.alternates],
    };
    const plan: SeriesPlan = {
      schema_version: "studio.series-plan/v1",
      series_title: "S",
      rationale: "R",
      episodes: [{ ...merged, idx: 1 }],
    };

    const result = SeriesPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    expect(result.data?.episodes[0]?.items).toHaveLength(3); // 1 from ep1 + 2 from ep2
  });
});
