import type { TimelineV2 } from "@harness/contracts";

const seg = (start: number, seconds: number, caption: string) => ({ asset_id: "asset-1", start_ms: start * 1000, end_ms: (start + seconds) * 1000, caption, orientation: "landscape" });

/** Three beats, two clips each, one voiced line per beat; `s7`–`s9` are alternates. */
export function sampleTimeline(): TimelineV2 {
  return {
    schema_version: "studio.timeline/v2",
    production_id: "prod-1",
    canvas: { width: 1280, height: 720 },
    fps: 25,
    language: "vi",
    beats: [{ beat_id: "B01", title: "Mở" }, { beat_id: "B02", title: "Nấu" }, { beat_id: "B03", title: "Ăn" }],
    clips: [
      { clip_id: "C001", beat_id: "B01", segment_id: "s1", src_in: 1, src_out: 3 },
      { clip_id: "C002", beat_id: "B01", segment_id: "s2", src_in: 0, src_out: 2 },
      { clip_id: "C003", beat_id: "B02", segment_id: "s3", src_in: 0, src_out: 3 },
      { clip_id: "C004", beat_id: "B02", segment_id: "s4", src_in: 0, src_out: 3 },
      { clip_id: "C005", beat_id: "B03", segment_id: "s5", src_in: 0, src_out: 2 },
      { clip_id: "C006", beat_id: "B03", segment_id: "s6", src_in: 0, src_out: 2 },
    ],
    narration: [
      { line_id: "L001", beat_id: "B01", text: "Hà Nội buổi sáng", audio: { key: `audio/${"1".repeat(64)}.wav`, duration: 3 } },
      { line_id: "L002", beat_id: "B02", text: "Nồi nước dùng", audio: { key: `audio/${"2".repeat(64)}.wav`, duration: 4 } },
      { line_id: "L003", beat_id: "B03", text: "Một bát phở", audio: { key: `audio/${"3".repeat(64)}.wav`, duration: 2.5 } },
    ],
    texts: [{ text_id: "T001", beat_id: "B01", kind: "title", text: "Phở sáng", offset: 0.5, duration: 3, position: "top_left" }],
    music: null,
    source_audio: { muted: true },
    captions: { enabled: true },
    segments: {
      s1: seg(0, 8, "phố sáng"), s2: seg(8, 8, "gánh phở"), s3: seg(16, 8, "nồi nước"), s4: seg(24, 8, "hành nướng"),
      s5: seg(32, 8, "thực khách"), s6: seg(40, 8, "bát phở"), s7: seg(48, 8, "quán đông"), s8: seg(56, 8, "rau thơm"), s9: seg(64, 8, "chanh ớt"),
    },
    alternates: { B01: [{ segment_id: "s7", reason: "phố" }], B02: [{ segment_id: "s8", reason: "rau" }], B03: [{ segment_id: "s9", reason: "gia vị" }] },
  };
}
