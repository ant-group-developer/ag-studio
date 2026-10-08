import { describe, expect, it } from "vitest";
import type { CatalogAsset, SeriesPlan, StudioBrief, StudioCatalog, StudioEpisode, YoutubeKit } from "@harness/contracts";
import { validateSeriesPlan, validateTrendReport, validateYoutubeKit } from "../../src/studio/validate.js";

// ---------------------------------------------------------------------------
// v3 fixtures
// ---------------------------------------------------------------------------

function brief(over: Partial<StudioBrief> = {}): StudioBrief {
  return {
    schema_version: "studio.brief/v2", production_id: "prod-1", run_id: "run_X", owner_user_id: "auth0|owner",
    title: "Phở Hà Nội", description: "Một buổi sáng ăn phở bò ở Hà Nội",
    goal: "Chia sẻ văn hóa ẩm thực", audience: "Người yêu ẩm thực", tone: "Thân thiện",
    notes: "", folder_ids: ["f1"], episode_target_seconds: 120, max_episodes: 5,
    aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
    music: null, youtube_channels: [], keywords: ["phở", "ẩm thực"], ...over,
  };
}

function asset(id: string, durationS: number, over: Partial<CatalogAsset> = {}): CatalogAsset {
  return {
    asset_id: id, name: `Video ${id}`, title_vi: `Tiêu đề ${id}`, summary_vi: `Tóm tắt ${id}`,
    duration_s: durationS, orientation: "landscape", genre: "documentary",
    topics: [], subjects: [], places: [], actions: [], keywords_vi: [],
    tags: [], mood: "neutral", setting: "outdoor", time_of_day: "day", people_count: "0",
    shot_variety: [], has_speech: false, quality: 4, usable: true, approved: false, project_names: [], ...over,
  };
}

function catalog(extra: CatalogAsset[] = []): StudioCatalog {
  const assets = [
    asset("a01", 30), asset("a02", 30), asset("a03", 30),
    asset("a04", 30), asset("a05", 30), asset("a06", 30),
  ].concat(extra);
  return {
    schema_version: "studio.catalog/v2", production_id: "prod-1", folder_ids: ["f1"],
    total_available: assets.length, truncated: false, assets,
  };
}

function seriesPlan(over: Partial<SeriesPlan> = {}): SeriesPlan {
  return {
    schema_version: "studio.series-plan/v1",
    series_title: "Phở sáng Hà Nội",
    rationale: "Ba tập đủ để kể câu chuyện",
    episodes: [
      {
        idx: 1, title: "Tập 1: Phở bò truyền thống", hook: "Bát phở đầu ngày",
        logline: "Khám phá phở bò cổ truyền Hà Nội",
        target_seconds: 120,
        items: [
          { asset_id: "a01", reason: "mở đầu", section_title: "Giới thiệu" },
          { asset_id: "a02", reason: "nước dùng", section_title: null },
          { asset_id: "a03", reason: "thưởng thức", section_title: "Trải nghiệm" },
        ],
        alternates: [{ asset_id: "a04", reason: "dự phòng" }],
        texts_suggested: [],
      },
    ],
    ...over,
  };
}

function youtubeKit(over: Partial<YoutubeKit> = {}): YoutubeKit {
  return {
    schema_version: "studio.youtube-kit/v1",
    titles: ["Phở bò Hà Nội chuẩn vị — Tập 1", "Bí quyết phở bò Hà Nội", "Một buổi sáng với phở Hà Nội"],
    description: "Khám phá ẩm thực Hà Nội qua bát phở.",
    tags: ["phở", "ẩm thực"],
    hashtags: ["#phở", "#HàNội"],
    thumbnails: [
      { asset_id: "a01", text: "Phở bò" },
      { asset_id: "a02", text: "Nước dùng" },
      { asset_id: "a03", text: "Thưởng thức" },
    ],
    playlist: "Phở Hà Nội",
    ...over,
  };
}

function episode(assetIds: string[] = ["a01", "a02", "a03"]): StudioEpisode {
  const assetMap = Object.fromEntries(
    assetIds.map((id) => [id, { title: `Video ${id}`, summary_vi: `Tóm tắt ${id}`, duration_s: 30, orientation: "landscape" }]),
  );
  return {
    schema_version: "studio.episode/v1",
    production_id: "prod-1", episode_id: "ep-1",
    idx: 1, title: "Tập 1", hook: "Hook 1", logline: "Logline 1",
    target_seconds: 120,
    items: assetIds.map((id) => ({ asset_id: id, reason: "chọn", section_title: null })),
    alternates: [],
    texts_suggested: [],
    assets: assetMap,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("series-plan-valid", () => {
  it("passes a valid series plan", () => {
    const r = validateSeriesPlan(seriesPlan(), { brief: brief(), catalog: catalog().assets });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("rejects an asset not in the catalog", () => {
    const plan = seriesPlan();
    plan.episodes[0]!.items[0]!.asset_id = "does-not-exist";
    const r = validateSeriesPlan(plan, { brief: brief(), catalog: catalog().assets });
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "unknown_asset" }));
  });

  it("rejects a plan with more episodes than max_episodes", () => {
    const plan = seriesPlan({
      episodes: [
        ...seriesPlan().episodes,
        { ...seriesPlan().episodes[0]!, idx: 2, items: [{ asset_id: "a04", reason: "x", section_title: null }] },
      ],
    });
    const r = validateSeriesPlan(plan, { brief: brief({ max_episodes: 1 }), catalog: catalog().assets });
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "too_many_episodes" }));
  });

  it("rejects non-usable footage", () => {
    const c = catalog([asset("bad1", 30, { usable: false })]);
    const plan = seriesPlan();
    plan.episodes[0]!.items[0]!.asset_id = "bad1";
    const r = validateSeriesPlan(plan, { brief: brief(), catalog: c.assets });
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "not_usable" }));
  });

  it("a shot-cut episode is cut from longer footage: no ±20% on the videos' total, but a pool large enough", () => {
    const cut = (target: number, over: Partial<SeriesPlan["episodes"][number]> = {}) => seriesPlan({
      episodes: [{ ...seriesPlan().episodes[0]!, target_seconds: target, edit_style: "cut", narration: "tts", ...over }],
    });
    // 3 × 30 s of footage for a 30 s cut: fine (a whole-video episode would be 200% off target)
    const ok = validateSeriesPlan(cut(30), { brief: brief(), catalog: catalog().assets });
    expect(ok.problems).toEqual([]);
    expect(ok.warnings.map((w) => w.code)).not.toContain("duration_off_target");
    expect(validateSeriesPlan(seriesPlan({ episodes: [{ ...seriesPlan().episodes[0]!, target_seconds: 30 }] }), { brief: brief(), catalog: catalog().assets })
      .warnings.map((w) => w.code)).toContain("duration_off_target");
    // 90 s of footage for an 80 s cut: too little to choose from
    expect(validateSeriesPlan(cut(80), { brief: brief(), catalog: catalog().assets }).warnings.map((w) => w.code)).toContain("pool_too_short");
    // a whole-video episode has no narration to choose
    const r = validateSeriesPlan(seriesPlan({ episodes: [{ ...seriesPlan().episodes[0]!, edit_style: "whole", narration: "tts" }] }), { brief: brief(), catalog: catalog().assets });
    expect(r.problems.map((p) => p.code)).toContain("narration_needs_cut");
  });

  it("narration declined for the production: no episode is read aloud", () => {
    const cut = (narration?: "tts" | "none" | "original") => seriesPlan({
      episodes: [{ ...seriesPlan().episodes[0]!, target_seconds: 30, edit_style: "cut", ...(narration ? { narration } : {}) }],
    });
    const declined = brief({ narration_voice: "none" });
    expect(validateSeriesPlan(cut("tts"), { brief: declined, catalog: catalog().assets }).problems.map((p) => p.code)).toContain("narration_needs_voice");
    // absent = tts
    expect(validateSeriesPlan(cut(), { brief: declined, catalog: catalog().assets }).problems.map((p) => p.code)).toContain("narration_needs_voice");
    expect(validateSeriesPlan(cut("original"), { brief: declined, catalog: catalog().assets }).problems).toEqual([]);
    // no voice yet: still allowed, the episode asks before reading
    expect(validateSeriesPlan(cut("tts"), { brief: brief({ narration_voice: "missing" }), catalog: catalog().assets }).problems).toEqual([]);
    expect(validateSeriesPlan(cut("tts"), { brief: brief(), catalog: catalog().assets }).problems).toEqual([]);
  });

  it("a shot-cut episode takes at most 40 videos", () => {
    const many = Array.from({ length: 41 }, (_, i) => asset(`c${i}`, 30));
    const plan = seriesPlan({ episodes: [{ ...seriesPlan().episodes[0]!, edit_style: "cut", items: many.map((a) => ({ asset_id: a.asset_id, reason: "r", section_title: null })), alternates: [] }] });
    const r = validateSeriesPlan(plan, { brief: brief(), catalog: catalog(many).assets });
    expect(r.problems.map((p) => p.code)).toContain("too_many_sources");
  });

  it("reports schema problems for malformed input", () => {
    const r = validateSeriesPlan({ schema_version: "studio.series-plan/v1" }, { brief: brief(), catalog: catalog().assets });
    expect(r.ok).toBe(false);
    expect(r.problems.every((p) => p.code === "schema")).toBe(true);
  });
});

describe("youtube-kit-valid", () => {
  it("accepts only hashtags YouTube links: letters, digits and _", () => {
    expect(validateYoutubeKit(youtubeKit({ hashtags: ["#Phở_Hà_Nội", "#Tập1"] }), { episode: episode() }).ok).toBe(true);
    for (const bad of ["#Phở-Hà-Nội", "#(Tập1)", "#Phở—Bò", "#a.b"]) {
      expect(validateYoutubeKit(youtubeKit({ hashtags: [bad] }), { episode: episode() }).ok).toBe(false);
    }
  });

  it("passes a valid youtube kit", () => {
    const r = validateYoutubeKit(youtubeKit(), { episode: episode() });
    expect(r.ok).toBe(true);
  });

  it("rejects a thumbnail whose asset is not in the episode", () => {
    const kit = youtubeKit();
    kit.thumbnails[0]!.asset_id = "not-in-episode";
    const r = validateYoutubeKit(kit, { episode: episode() });
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "thumbnail_not_in_episode" }));
  });

  it("a shot-cut episode: a thumbnail's video must still have a clip in the approved cut", () => {
    const timeline = { clips: [{ asset_id: "a01" }, { asset_id: "a02" }, { asset_id: "a01" }] };
    const r = validateYoutubeKit(youtubeKit(), { episode: episode(), timeline });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ code: "thumbnail_not_in_timeline", message: expect.stringContaining("a03") })]);
    expect(validateYoutubeKit(youtubeKit(), { episode: episode(), timeline: { clips: [...timeline.clips, { asset_id: "a03" }] } }).ok).toBe(true);
    // not in the episode at all: that problem only
    const kit = youtubeKit();
    kit.thumbnails[2]!.asset_id = "nowhere";
    expect(validateYoutubeKit(kit, { episode: episode(), timeline }).problems.map((p) => p.code)).toEqual(["thumbnail_not_in_episode"]);
  });

  it("rejects duplicate titles", () => {
    const kit = youtubeKit({ titles: ["Phở bò", "Phở bò", "Phở bò khác"] });
    const r = validateYoutubeKit(kit, { episode: episode() });
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "duplicate_title" }));
  });
});

describe("trend-report-valid", () => {
  it("passes a valid trend report", () => {
    const r = validateTrendReport({
      schema_version: "studio.trend-report/v1",
      skipped: false,
      summary: "Dữ liệu cho thấy video ngắn 3–5 phút với hook mạnh hoạt động tốt nhất.",
      working_angles: ["Trải nghiệm thực tế", "Bí mật ít người biết"],
      title_patterns: ["[Từ khoá] — [Con số]"],
      hook_patterns: ["Câu hỏi cá nhân hoá"],
      thumbnail_patterns: ["Cận cảnh khuôn mặt"],
      recommended_duration_s: 90,
      posting_schedule: "Thứ 3 và Thứ 6, 18:00–20:00",
      recommendations: ["Dùng nhạc nhẹ nhàng"],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects malformed trend report", () => {
    const r = validateTrendReport({ schema_version: "studio.trend-report/v1" });
    expect(r.ok).toBe(false);
    expect(r.problems.every((p) => p.code === "schema")).toBe(true);
  });
});
