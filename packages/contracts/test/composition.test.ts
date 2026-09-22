import { describe, expect, it } from "vitest";
import {
  BrandProfileSchema, CaptionCueSchema, CompositionSchema, MusicTrackSchema, OverlaysSchema,
  ProjectConfigSchema, RenderReportSchema, TextEventSchema, newId,
} from "../src/index.js";

const NOW = "2026-09-22T00:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);

function overlaysSample() {
  return {
    schema_version: "harness.overlays/v1",
    items: [{ id: "OV01", kind: "title", text: "Chợ nổi Cái Răng", anchor: { line_id: "L001" } }],
    transitions: [{ before_order: 1, kind: "dissolve" }],
    music: { mood: "upbeat" },
  };
}

function brandMinimal() {
  return {
    schema_version: "harness.brand/v1",
    channel_id: "channel-a",
    revision: 1,
    fonts: { regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf", origin: "royalty_free", origin_note: "Google Fonts, OFL" },
    colors: { primary: "#FF6600" },
  };
}

function musicTrackSample(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "harness.music-track/v1", track_id: "upbeat-piano", display_name: "Upbeat Piano",
    file: "upbeat-piano.mp3", mood: ["upbeat"], duration_seconds: 120, origin: "royalty_free", origin_note: "Pixabay Music",
    checksum: SHA, created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function captionCueSample() {
  return { index: 1, start: 0, end: 2, lines: ["xin chào"], words: [] };
}

function textEventSample() {
  return { id: "OV01", kind: "title", text: "Chợ nổi Cái Răng", start: 0, end: 4, position: "top_left", animation: "slide_up" };
}

function compositionSample() {
  return {
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 30, codec: "h264" },
    voice: "tts", language: "vi", total_seconds: 4, request_id: newId("content_request"),
    brand: null,
    segments: [{
      order: 0, source_id: newId("source_item"), source_path: "E:/src/a.mp4", in: 0, out: 4, start: 0, end: 4,
      fit: "scale_pad", has_audio: true, transition_out: { kind: "cut", seconds: 0, tail_available: false },
    }],
    text_events: [], captions: { mode: "none", cues: [] },
    music: null, logo: null, narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    warnings: [],
  };
}

function renderReportSample() {
  return {
    schema_version: "harness.render-report/v1", encoder: "cpu", codec: "h264",
    output: { width: 3840, height: 2160, fps: 30, seconds: 4, bytes: 1000 },
    segments: { total: 1, rendered: 1, cached: 0, mezz_seconds: 1 },
    transitions: { requested: 0, applied: 0, downgraded: [] },
    captions: { mode: "none", cues: 0 },
    text_events: { total: 0, dropped: [] },
    music: { track_id: null, loop: false },
    loudness: { integrated_lufs: -14, true_peak_dbtp: -1, lra: 11 },
    brand: "absent", warnings: [], render_seconds: 1, ffmpeg_version: "6.0",
  };
}

describe("composition schemas", () => {
  it("parses a valid sample of each of the 7 new schemas", () => {
    expect(OverlaysSchema.parse(overlaysSample()).items).toHaveLength(1);
    expect(BrandProfileSchema.parse(brandMinimal()).channel_id).toBe("channel-a");
    expect(MusicTrackSchema.parse(musicTrackSample()).track_id).toBe("upbeat-piano");
    expect(CaptionCueSchema.parse(captionCueSample()).lines).toEqual(["xin chào"]);
    expect(TextEventSchema.parse(textEventSample()).kind).toBe("title");
    expect(CompositionSchema.parse(compositionSample()).segments).toHaveLength(1);
    expect(RenderReportSchema.parse(renderReportSample()).brand).toBe("absent");
  });
});

describe("OverlaysSchema", () => {
  it("rejects an id that does not match OV## / OV###", () => {
    const bad = overlaysSample();
    bad.items[0]!.id = "OV1";
    expect(OverlaysSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an anchor carrying both line_id and edl_order", () => {
    const bad = overlaysSample();
    (bad.items[0]!.anchor as Record<string, unknown>) = { line_id: "L001", edl_order: 0 };
    expect(OverlaysSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults items to [] when missing", () => {
    const { items: _items, ...withoutItems } = overlaysSample();
    expect(OverlaysSchema.parse(withoutItems).items).toEqual([]);
  });
});

describe("BrandProfileSchema", () => {
  it("parses the minimal shape (fonts, colors.primary) with every default from spec §2.1", () => {
    const b = BrandProfileSchema.parse(brandMinimal());
    expect(b.text.title.size_px).toBe(120);
    expect(b.subtitles.mode).toBe("burn-in");
    expect(b.transition.kind).toBe("cut");
    expect(b.music.gain_db).toBe(-18);
    expect(b.safe_margin_px).toBe(120);
    expect(b.colors.text).toBe("#FFFFFF");
  });

  it("rejects a color that is not 6 or 8 hex digits", () => {
    const bad = { ...brandMinimal(), colors: { primary: "#12345" } };
    expect(BrandProfileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a transition.seconds outside [0.2, 1.0]", () => {
    const bad = { ...brandMinimal(), transition: { seconds: 1.5 } };
    expect(BrandProfileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("MusicTrackSchema", () => {
  it("rejects a track_id that is too short to match the pattern", () => {
    expect(MusicTrackSchema.safeParse(musicTrackSample({ track_id: "A" })).success).toBe(false);
  });

  it("rejects an empty mood list", () => {
    expect(MusicTrackSchema.safeParse(musicTrackSample({ mood: [] })).success).toBe(false);
  });
});

describe("CompositionSchema", () => {
  it("rejects an output.width other than 3840", () => {
    const bad = compositionSample();
    bad.output.width = 1920;
    expect(CompositionSchema.safeParse(bad).success).toBe(false);
  });
});

const MINIMAL_PROJECT_CONFIG = {
  schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
  data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
};

describe("ProjectConfigSchema media.render", () => {
  it("an old project.yaml (no media.render) still parses with the new defaults", () => {
    const parsed = ProjectConfigSchema.parse(MINIMAL_PROJECT_CONFIG);
    expect(parsed.media.render).toEqual({ codec: "h264", encoder: "auto", fps: "auto", cache_max_gb: 60 });
  });

  it("rejects an fps that is not one of the allowed frame rates or \"auto\"", () => {
    const bad = { ...MINIMAL_PROJECT_CONFIG, media: { render: { fps: 29 } } };
    expect(ProjectConfigSchema.safeParse(bad).success).toBe(false);
  });
});
