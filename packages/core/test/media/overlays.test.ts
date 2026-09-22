import { describe, expect, it } from "vitest";
import type { BrandProfile, CaptionCue, Edl, Narration, Overlays, TextEvent, Timeline } from "@harness/contracts";
import { OVERLAY, overlayDensityLimit, placeOverlays, raiseCaptions, resolveAnchor } from "../../src/media/overlays.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function brandFixture(overrides: Partial<BrandProfile> = {}): BrandProfile {
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
    transition: { kind: "cut", seconds: 0.4 },
    source_fit: "scale_pad",
    music: { tracks: [], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
    checksums: {},
    ...overrides,
  };
}

function timelineFixture(p: {
  voice?: Timeline["voice"];
  total_seconds: number;
  video?: Timeline["video"];
  narration?: Timeline["narration"];
  speech?: Timeline["speech"];
}): Timeline {
  return {
    schema_version: "harness.timeline/v1",
    voice: p.voice ?? "tts",
    language: "en",
    total_seconds: p.total_seconds,
    video: p.video ?? [],
    narration: p.narration ?? [],
    speech: p.speech ?? [],
  };
}

function overlaysFixture(items: Overlays["items"]): Overlays {
  return { schema_version: "harness.overlays/v1", items, transitions: [] };
}

describe("resolveAnchor", () => {
  const timeline = timelineFixture({
    total_seconds: 20,
    video: [
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 5, out: 10, start: 5, end: 10 },
    ],
    narration: [
      { line_id: "L001", wav: "L001.wav", start: 1, end: 4, words: [{ word: "hello", start: 1, end: 1.5 }, { word: "world", start: 1.5, end: 2 }] },
    ],
    speech: [{ source_id: SRC_A, start: 2, end: 6, text: "hi", words: [] }],
  });

  it("resolves line_id to the narration line's start", () => {
    expect(resolveAnchor({ line_id: "L001" }, timeline)).toBe(1);
  });

  it("resolves line_id + word_index to that word's start", () => {
    expect(resolveAnchor({ line_id: "L001", word_index: 1 }, timeline)).toBe(1.5);
  });

  it("resolves edl_order to the matching video segment's start", () => {
    expect(resolveAnchor({ edl_order: 1 }, timeline)).toBe(5);
  });

  it("resolves speech_index to the matching speech entry's start", () => {
    expect(resolveAnchor({ speech_index: 0 }, timeline)).toBe(2);
  });

  it("returns null for an unknown line_id", () => {
    expect(resolveAnchor({ line_id: "L999" }, timeline)).toBeNull();
  });

  it("returns null for an out-of-range word_index", () => {
    expect(resolveAnchor({ line_id: "L001", word_index: 9 }, timeline)).toBeNull();
  });

  it("returns null for an unknown edl_order", () => {
    expect(resolveAnchor({ edl_order: 9 }, timeline)).toBeNull();
  });

  it("returns null for an out-of-range speech_index", () => {
    expect(resolveAnchor({ speech_index: 9 }, timeline)).toBeNull();
  });
});

describe("placeOverlays", () => {
  const baseTimeline = (video: Timeline["video"]) => timelineFixture({ total_seconds: 30, video });

  it("drops an item whose anchor does not resolve", () => {
    const timeline = baseTimeline([{ order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 }]);
    const overlays = overlaysFixture([{ id: "OV01", kind: "title", text: "Hi", anchor: { edl_order: 9 } }]);
    const { events, dropped } = placeOverlays({ overlays, timeline, brand: brandFixture(), logo: null });
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ id: "OV01", reason: "anchor_missing" }]);
  });

  it("drops an item whose resolved span is under 0.5s (clamped by total_seconds)", () => {
    // title's brand seconds default is 4; anchored at 4.0 with total_seconds 4.2 -> end clamped to 4.2 -> span 0.2s < 0.5s
    const timeline = timelineFixture({
      total_seconds: 4.2,
      video: [{ order: 0, source_id: SRC_A, in: 0, out: 4, start: 0, end: 4 }, { order: 1, source_id: SRC_A, in: 0, out: 0.2, start: 4.0, end: 4.2 }],
    });
    const overlays = overlaysFixture([{ id: "OV01", kind: "title", text: "Hi", anchor: { edl_order: 1 } }]);
    const { events, dropped } = placeOverlays({ overlays, timeline, brand: brandFixture(), logo: null });
    expect(events).toEqual([]);
    expect(dropped).toEqual([{ id: "OV01", reason: "too_short" }]);
  });

  it("shifts a later same-zone overlap by the overlap amount, keeping its own duration", () => {
    const timeline = baseTimeline([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 3, end: 8 },
    ]);
    // both title (top zone), default seconds 4: OV01 [0,4), OV02 anchored at 3 -> [3,7) overlaps OV01 by 1s
    const overlays = overlaysFixture([
      { id: "OV01", kind: "title", text: "First", anchor: { edl_order: 0 } },
      { id: "OV02", kind: "title", text: "Second", anchor: { edl_order: 1 } },
    ]);
    const { events, dropped, warnings } = placeOverlays({ overlays, timeline, brand: brandFixture(), logo: null });
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([]);
    const first = events.find((e) => e.id === "OV01")!;
    const second = events.find((e) => e.id === "OV02")!;
    expect(first.start).toBe(0);
    expect(first.end).toBe(4);
    // shifted to start right after `first` ends, keeping its own 4s duration
    expect(second.start).toBe(4);
    expect(second.end).toBe(8);
  });

  it("drops a later same-zone overlap that would need to shift more than OVERLAY.max_shift_seconds", () => {
    const timeline = baseTimeline([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 1, end: 6 },
    ]);
    // OV01 title [0,4); OV02 title anchored at 1 -> [1,5) overlaps by 3s > max_shift_seconds (2)
    const overlays = overlaysFixture([
      { id: "OV01", kind: "title", text: "First", anchor: { edl_order: 0 } },
      { id: "OV02", kind: "title", text: "Second", anchor: { edl_order: 1 } },
    ]);
    const { events, dropped, warnings } = placeOverlays({ overlays, timeline, brand: brandFixture(), logo: null });
    expect(OVERLAY.max_shift_seconds).toBe(2);
    expect(events.map((e) => e.id)).toEqual(["OV01"]);
    expect(dropped).toEqual([{ id: "OV02", reason: "collision" }]);
    expect(warnings).toEqual(["overlay_dropped:OV02"]);
  });

  it("keeps two fully-overlapping events in different zones (title top, callout center)", () => {
    const timeline = baseTimeline([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 1, end: 6 },
    ]);
    const overlays = overlaysFixture([
      { id: "OV01", kind: "title", text: "Title", anchor: { edl_order: 0 } },
      { id: "OV02", kind: "callout", text: "42", anchor: { edl_order: 1 } },
    ]);
    const { events, dropped } = placeOverlays({ overlays, timeline, brand: brandFixture(), logo: null });
    expect(dropped).toEqual([]);
    expect(events.map((e) => e.id).sort()).toEqual(["OV01", "OV02"]);
    const title = events.find((e) => e.id === "OV01")!;
    const callout = events.find((e) => e.id === "OV02")!;
    // unshifted -- different zones never collide
    expect(title.start).toBe(0);
    expect(callout.start).toBe(1);
  });

  it("moves a top_right item matching the logo's right corner to top_left", () => {
    const brand = brandFixture({ text: { ...brandFixture().text, title: { size_px: 120, position: "top_right", box: true, animation: "slide_up", seconds: 4 } } });
    const timeline = baseTimeline([{ order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 }]);
    const overlays = overlaysFixture([{ id: "OV01", kind: "title", text: "Hi", anchor: { edl_order: 0 } }]);
    const { events } = placeOverlays({ overlays, timeline, brand, logo: { corner: "right" } });
    expect(events[0]!.position).toBe("top_left");
  });

  it("falls back to top_center (and is then itself shifted by zone collision) when the opposite corner is already occupied by an overlapping event", () => {
    const customText: BrandProfile["text"] = {
      title: { size_px: 120, position: "top_right", box: true, animation: "slide_up", seconds: 4 },
      callout: { size_px: 160, position: "top_left", box: false, animation: "pop", seconds: 4 },
      lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
    };
    const brand = brandFixture({ text: customText });
    const timeline = baseTimeline([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 3, end: 8 },
    ]);
    const overlays = overlaysFixture([
      { id: "OV01", kind: "callout", text: "Left", anchor: { edl_order: 0 } }, // stays top_left, [0,4)
      { id: "OV02", kind: "title", text: "Right", anchor: { edl_order: 1 } }, // top_right, anchored at 3 -> overlaps OV01's top_left by 1s -> top_center
    ]);
    const { events, dropped } = placeOverlays({ overlays, timeline, brand, logo: { corner: "right" } });
    expect(dropped).toEqual([]);
    const moved = events.find((e) => e.id === "OV02")!;
    expect(moved.position).toBe("top_center");
    // top_center is still zone "top", same as OV01 (top_left) -- also overlapping by 1s, so OV02 gets shifted
    // (not dropped, since the shift is within OVERLAY.max_shift_seconds) to start right after OV01 ends.
    expect(moved.start).toBe(4);
    expect(moved.end).toBe(8);
  });
});

describe("raiseCaptions", () => {
  const brand = brandFixture();

  it("raises a cue overlapping a lower_third event by size_px * 1.6, rounded", () => {
    const cues: CaptionCue[] = [
      { index: 1, start: 0, end: 2, lines: ["hi"], raise_px: 0, words: [] },
      { index: 2, start: 5, end: 7, lines: ["bye"], raise_px: 0, words: [] },
    ];
    const events: TextEvent[] = [{ id: "OV01", kind: "lower_third", text: "Source", start: 1, end: 3, position: "bottom_left", animation: "fade" }];
    const result = raiseCaptions(cues, events, brand);
    expect(result[0]!.raise_px).toBe(Math.round(72 * 1.6));
    expect(result[1]!.raise_px).toBe(0);
  });

  it("leaves cues unchanged when there are no lower_third events", () => {
    const cues: CaptionCue[] = [{ index: 1, start: 0, end: 2, lines: ["hi"], raise_px: 0, words: [] }];
    expect(raiseCaptions(cues, [], brand)).toEqual(cues);
  });
});

describe("overlayDensityLimit", () => {
  it("uses narration character count / cps for tts, floor(seconds / spacing)", () => {
    const narration: Narration = {
      schema_version: "harness.narration/v1",
      language: "en",
      lines: [
        { line_id: "L001", edl_order: 0, text: "a".repeat(600) },
        { line_id: "L002", edl_order: 1, text: "b".repeat(600) },
      ],
    };
    const edl: Edl = { schema_version: "harness.edl/v1", entries: [{ source_id: SRC_A, in: 0, out: 1, order: 0, overlay: null, note: "" }] };
    // 1200 chars / 15 cps (en) = 80s; medium spacing 8 -> floor(80/8) = 10
    expect(overlayDensityLimit({ narration, edl, language: "en", density: "medium" })).toBe(10);
  });

  it("uses total EDL screen time when there is no narration", () => {
    const edl: Edl = {
      schema_version: "harness.edl/v1",
      entries: [
        { source_id: SRC_A, in: 0, out: 40, order: 0, overlay: null, note: "" },
        { source_id: SRC_A, in: 0, out: 40, order: 1, overlay: null, note: "" },
      ],
    };
    // 80s total, high spacing 5 -> floor(80/5) = 16
    expect(overlayDensityLimit({ narration: null, edl, language: "en", density: "high" })).toBe(16);
  });
});
