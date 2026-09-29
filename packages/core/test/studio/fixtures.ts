import type { CatalogSegment, Selection, StudioBrief, StudioCatalog, StudioNarration, Treatment } from "@harness/contracts";

export function brief(over: Partial<StudioBrief> = {}): StudioBrief {
  return {
    schema_version: "studio.brief/v1", production_id: "prod-1", run_id: "run_X", owner_user_id: "auth0|owner",
    title: "Phở Hà Nội", topic: "Một buổi sáng ăn phở bò ở Hà Nội", folder_ids: ["f1"], target_seconds: 30,
    aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
    voice: { reference: null, reference_text: null, speed: 1 }, music: null, ...over,
  };
}

export function seg(id: string, seconds: number, over: Partial<CatalogSegment> = {}): CatalogSegment {
  return {
    id, asset_id: `asset-${id}`, start_ms: 10_000, end_ms: 10_000 + seconds * 1000, duration_s: seconds,
    caption_vi: `cảnh ${id}`, caption_en: `shot ${id}`, tags: [], keywords_vi: [], subjects: [], actions: [],
    shot_size: "wide", camera_motion: null, time_of_day: null, setting: null, people_count: null,
    orientation: "landscape", quality: 4, usable: true, approved: false, ...over,
  };
}

/** 12 usable landscape segments of 8 s: s01..s12. */
export function catalog(extra: CatalogSegment[] = []): StudioCatalog {
  const segments = Array.from({ length: 12 }, (_, i) => seg(`s${String(i + 1).padStart(2, "0")}`, 8)).concat(extra);
  return { schema_version: "studio.catalog/v1", production_id: "prod-1", folder_ids: ["f1"], total_available: segments.length, truncated: false, segments };
}

/** Three beats: 10 + 10 + 10 = 30 s. */
export function treatment(): Treatment {
  return {
    schema_version: "studio.treatment/v1", title: "Phở sáng", logline: "Một bát phở buổi sáng",
    beats: [
      { beat_id: "B01", purpose: "Mở", seconds: 10, visual_idea: "phố sáng", narration_idea: "giới thiệu" },
      { beat_id: "B02", purpose: "Nấu", seconds: 10, visual_idea: "nồi nước dùng", narration_idea: "nước dùng" },
      { beat_id: "B03", purpose: "Ăn", seconds: 10, visual_idea: "thực khách", narration_idea: "kết" },
    ],
  };
}

export function selection(): Selection {
  const beat = (id: string, picks: string[], alts: string[]) => ({
    beat_id: id,
    picks: picks.map((segment_id) => ({ segment_id, reason: "hợp ý" })),
    alternates: alts.map((segment_id) => ({ segment_id, reason: "dự phòng" })),
  });
  return {
    schema_version: "studio.selection/v1",
    beats: [beat("B01", ["s01", "s02"], ["s07", "s08", "s09"]), beat("B02", ["s03", "s04"], ["s09", "s10", "s11"]), beat("B03", ["s05", "s06"], ["s10", "s11", "s12"])],
  };
}

export function narration(): StudioNarration {
  return {
    schema_version: "studio.narration/v1", language: "vi",
    lines: [
      { line_id: "L001", beat_id: "B01", text: "Hà Nội buổi sáng thức dậy với mùi phở" },
      { line_id: "L002", beat_id: "B02", text: "Nồi nước dùng ninh xương suốt đêm" },
      { line_id: "L003", beat_id: "B02", text: "Hành nướng thơm lừng" },
      { line_id: "L004", beat_id: "B03", text: "Và một bát phở nóng hổi" },
    ],
  };
}
