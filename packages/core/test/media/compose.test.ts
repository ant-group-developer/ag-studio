import { describe, expect, it } from "vitest";
import { CompositionSchema, isHarnessError, newId, type BrandProfile, type MediaConfig, type MusicTrack, type Overlays, type Timeline } from "@harness/contracts";
import { buildComposition, type ComposeInput } from "../../src/media/compose.js";
import { countDialogues } from "../../src/media/ass.js";
import { assignTransitions } from "../../src/media/transitions.js";
import type { LoadedBrand } from "../../src/library/brands.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
const SRC_B = "src_01JBBBBBBBBBBBBBBBBBBBBBBB";

function brandProfileFixture(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: "harness.brand/v1",
    channel_id: "ch1",
    revision: 1,
    fonts: { regular: "brands/ch1/fonts/Inter-Regular.ttf", bold: "brands/ch1/fonts/Inter-Bold.ttf", origin: "own", origin_note: "in-house" },
    colors: { primary: "#112233", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
    safe_margin_px: 120,
    text: {
      title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
      callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
      lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
    },
    subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
    logo: { path: "logo.png", corner: "right", opacity: 0.8, height_px: 140 },
    transition: { kind: "cut", seconds: 0.4 },
    source_fit: "scale_pad",
    music: { tracks: ["calm-01", "upbeat-01"], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
    checksums: { "fonts.regular": `sha256:${"a".repeat(64)}`, "fonts.bold": `sha256:${"b".repeat(64)}`, logo: `sha256:${"c".repeat(64)}` },
    ...overrides,
  };
}

function loadedBrandFixture(overrides: Partial<BrandProfile> = {}): LoadedBrand {
  return {
    brand: brandProfileFixture(overrides),
    dir: "/kho/brands/ch1",
    fonts_dir: "/kho/brands/ch1/fonts",
    font_regular_path: "/kho/brands/ch1/fonts/Inter-Regular.ttf",
    font_bold_path: "/kho/brands/ch1/fonts/Inter-Bold.ttf",
    logo_path: "/kho/brands/ch1/logo.png",
  };
}

function trackFixture(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1",
    track_id: "track-a",
    display_name: "Track A",
    file: "music/track-a/track.mp3",
    mood: ["calm"],
    duration_seconds: 120,
    loop_ok: true,
    origin: "own",
    origin_note: "in-house",
    checksum: `sha256:${"a".repeat(64)}`,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function threeSegmentTimeline(): Timeline {
  return {
    schema_version: "harness.timeline/v1",
    voice: "tts",
    language: "en",
    total_seconds: 15,
    video: [
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 5, out: 10, start: 5, end: 10 },
      { order: 2, source_id: SRC_A, in: 10, out: 15, start: 10, end: 15 },
    ],
    narration: [
      {
        line_id: "L001",
        wav: "L001.wav",
        start: 0,
        end: 15,
        words: [
          { word: "Xin", start: 0, end: 1 },
          { word: "chao", start: 2, end: 3 },
          { word: "cac", start: 4, end: 5 },
        ],
      },
    ],
    speech: [],
  };
}

const RENDER: MediaConfig["render"] = { codec: "h264", encoder: "auto", fps: 30, cache_max_gb: 60 };

function threeItemOverlays(): Overlays {
  return {
    schema_version: "harness.overlays/v1",
    items: [
      { id: "OV01", kind: "title", text: "Tieu de", anchor: { line_id: "L001" } },
      { id: "OV02", kind: "callout", text: "42", anchor: { edl_order: 1 } },
      { id: "OV03", kind: "lower_third", text: "Nguon: test", anchor: { edl_order: 2 } },
    ],
    transitions: [],
  };
}

function baseInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  const brand = loadedBrandFixture();
  const tracks = [trackFixture({ track_id: "calm-01", mood: ["calm"] }), trackFixture({ track_id: "upbeat-01", mood: ["upbeat"] })];
  return {
    timeline: threeSegmentTimeline(),
    overlays: threeItemOverlays(),
    narration: null,
    edl: { schema_version: "harness.edl/v1", entries: [{ source_id: SRC_A, in: 0, out: 15, order: 0, overlay: null, note: "" }] },
    brand,
    tracks,
    trackPath: (t) => `/kho/music/${t.track_id}/track.mp3`,
    sources: new Map([[SRC_A, { path: "/abs/source-a.mp4", duration_seconds: 20, has_audio: true, fps: 30 }]]),
    voiceSetDir: "/abs/voice",
    request_id: newId("content_request"),
    render: RENDER,
    ...overrides,
  };
}

describe("buildComposition", () => {
  it("builds a schema-valid composition whose segments mirror the timeline exactly, with brand/overlays/music resolved", () => {
    const input = baseInput();
    const { composition, srt, ass } = buildComposition(input);

    expect(() => CompositionSchema.parse(composition)).not.toThrow();

    expect(composition.segments).toHaveLength(3);
    for (let i = 0; i < input.timeline.video.length; i++) {
      const seg = composition.segments[i]!;
      const t = input.timeline.video[i]!;
      expect(seg.order).toBe(t.order);
      expect(seg.source_id).toBe(t.source_id);
      expect(seg.in).toBe(t.in);
      expect(seg.out).toBe(t.out);
      expect(seg.start).toBe(t.start);
      expect(seg.end).toBe(t.end);
    }

    expect(composition.text_events).toHaveLength(3);
    expect(composition.captions.cues.length).toBeGreaterThan(0);
    expect(["calm-01", "upbeat-01"]).toContain(composition.music?.track_id);
    expect(composition.logo).not.toBeNull();

    const expectedDialogues = composition.captions.cues.length + composition.text_events.length;
    expect(countDialogues(ass)).toBe(expectedDialogues);
    const srtBlocks = srt.trim().length === 0 ? 0 : srt.trim().split(/\n\n+/).length;
    expect(srtBlocks).toBe(composition.captions.cues.length);
  });

  it("drops overlays and turns off captions/music when there is no brand, with the ignored-overlays warning", () => {
    const input = baseInput({ brand: null });
    const { composition } = buildComposition(input);

    expect(composition.text_events).toEqual([]);
    expect(composition.captions.mode).toBe("none");
    expect(composition.music).toBeNull();
    expect(composition.music_reason).toBe("no_brand");
    expect(composition.warnings).toContain("overlays_ignored_no_brand");
    // cues are still computed for SRT/VTT even though the brand (and so the ASS burn-in) is gone.
    expect(composition.captions.cues.length).toBeGreaterThan(0);
  });

  it("lets subtitlesOverride win over the brand's subtitles.mode", () => {
    const input = baseInput({ subtitlesOverride: "karaoke" });
    const { composition } = buildComposition(input);
    expect(input.brand!.brand.subtitles.mode).toBe("burn-in"); // brand default, not what we expect
    expect(composition.captions.mode).toBe("karaoke");
  });

  it("uses a numeric render.fps as-is", () => {
    const input = baseInput({ render: { ...RENDER, fps: 25 } });
    const { composition } = buildComposition(input);
    expect(composition.output.fps).toBe(25);
  });

  it("auto fps votes by total screen time and snaps to the nearest candidate -- the longer 30fps source wins over the shorter 25fps one", () => {
    const timeline: Timeline = {
      schema_version: "harness.timeline/v1",
      voice: "none",
      language: "en",
      total_seconds: 15,
      video: [
        { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 }, // 5s on the 25fps source
        { order: 1, source_id: SRC_B, in: 0, out: 10, start: 5, end: 15 }, // 10s on the 30fps source
      ],
      narration: [],
      speech: [],
    };
    const input = baseInput({
      timeline,
      overlays: null,
      sources: new Map([
        [SRC_A, { path: "/abs/a.mp4", duration_seconds: 20, has_audio: true, fps: 25 }],
        [SRC_B, { path: "/abs/b.mp4", duration_seconds: 20, has_audio: true, fps: 30 }],
      ]),
      render: { ...RENDER, fps: "auto" },
    });
    const { composition } = buildComposition(input);
    expect(composition.output.fps).toBe(30);
  });

  it("throws CONFIG_INVALID when voice is tts and voiceSetDir is null", () => {
    const input = baseInput({ voiceSetDir: null });
    try {
      buildComposition(input);
      expect.fail("expected buildComposition to throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("forces captions.mode to 'none' with no brand even when subtitlesOverride asks for karaoke -- there is no font/style to burn it with, and buildAss always emits zero Dialogue lines with no brand", () => {
    const input = baseInput({ brand: null, subtitlesOverride: "karaoke" });
    const { composition, ass } = buildComposition(input);

    expect(composition.captions.mode).toBe("none");
    // cues are still computed for SRT/VTT even though there is no brand to burn them in with.
    expect(composition.captions.cues.length).toBeGreaterThan(0);
    expect(composition.text_events).toEqual([]);
    expect(countDialogues(ass)).toBe(0);
    // The exact equation composition-valid's dialogue-count check enforces: with mode "none" the cue count
    // does not enter it at all, so a non-empty cues[] can never desync it from the (empty) ASS.
    const expectedDialogues = (composition.captions.mode === "none" ? 0 : composition.captions.cues.length) + composition.text_events.length;
    expect(countDialogues(ass)).toBe(expectedDialogues);
  });

  it("builds segments and their transition_out from an order-sorted copy of timeline.video, so an out-of-order input still lines each transition up with its own segment", () => {
    const timeline: Timeline = {
      schema_version: "harness.timeline/v1",
      voice: "none",
      language: "en",
      total_seconds: 15,
      video: [
        { order: 1, source_id: SRC_A, in: 5, out: 10, start: 5, end: 10 },
        { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
        { order: 2, source_id: SRC_A, in: 10, out: 15, start: 10, end: 15 },
      ],
      narration: [],
      speech: [],
    };
    const sourceDurations = new Map([[SRC_A, 20]]);
    const brand = brandProfileFixture({ transition: { kind: "dissolve", seconds: 0.4 } });
    const input = baseInput({ timeline, overlays: null, brand: loadedBrandFixture({ transition: { kind: "dissolve", seconds: 0.4 } }) });
    const { composition } = buildComposition(input);

    // Segments come out order-ascending regardless of the input's own order.
    expect(composition.segments.map((s) => s.order)).toEqual([0, 1, 2]);

    // Independently-computed expectation: assignTransitions sorts its own copy internally, so it produces
    // the same transition_out per `order` no matter what order `timeline.video` is handed in.
    const expected = assignTransitions({ timeline, overlays: null, brand, sourceDurations });
    for (const seg of composition.segments) {
      const expectedIndex = [0, 1, 2].indexOf(seg.order);
      expect(seg.transition_out).toEqual(expected.transition_out[expectedIndex]);
    }
  });
});
