import type { TimelineV3 } from "@harness/contracts";

/** Three clips with section titles; two alternates. Used by editor tests and the playground. */
export function sampleTimeline(): TimelineV3 {
  return {
    schema_version: "studio.timeline/v3",
    production_id: "prod-1",
    episode_id: "ep-1",
    canvas: { width: 1280, height: 720 },
    fps: 25,
    language: "vi",
    clips: [
      { clip_id: "C001", asset_id: "asset-1", section_title: "Mở đầu" },
      { clip_id: "C002", asset_id: "asset-2", section_title: null },
      { clip_id: "C003", asset_id: "asset-3", section_title: "Kết" },
    ],
    texts: [
      { text_id: "T001", kind: "title", text: "Phở sáng Hà Nội", start: 0.5, duration: 3, position: "top_left" },
    ],
    music: null,
    source_audio: { muted: true },
    assets: {
      "asset-1": { title: "Phố cổ buổi sáng", summary_vi: "Hình ảnh phố cổ", duration_s: 10, orientation: "landscape" },
      "asset-2": { title: "Nồi phở", summary_vi: "Nấu phở", duration_s: 8, orientation: "landscape" },
      "asset-3": { title: "Bát phở", summary_vi: "Ăn phở", duration_s: 6, orientation: "landscape" },
      "asset-4": { title: "Quán đông", summary_vi: "Quán", duration_s: 9, orientation: "landscape" },
    },
    alternates: [
      { asset_id: "asset-4", reason: "góc nhìn khác" },
    ],
  };
}
