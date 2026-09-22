import { describe, expect, it } from "vitest";
import type { BrandProfile, Overlays, Timeline } from "@harness/contracts";
import { assignTransitions } from "../../src/media/transitions.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
const SRC_B = "src_01JBBBBBBBBBBBBBBBBBBBBBBB";

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

function timelineFixture(video: Timeline["video"]): Timeline {
  return { schema_version: "harness.timeline/v1", voice: "none", language: "en", total_seconds: video.at(-1)?.end ?? 0, video, narration: [], speech: [] };
}

function overlaysFixture(transitions: Overlays["transitions"]): Overlays {
  return { schema_version: "harness.overlays/v1", items: [], transitions };
}

describe("assignTransitions", () => {
  it("keeps a dissolve when the outgoing source has tail and the next segment is long enough", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 10, start: 0, end: 10 },
      { order: 1, source_id: SRC_B, in: 0, out: 3, start: 10, end: 13 },
    ]);
    const overlays = overlaysFixture([{ before_order: 1, kind: "dissolve" }]);
    const sourceDurations = new Map([[SRC_A, 10.5]]); // 10 + 0.4 <= 10.5
    const { transition_out, summary } = assignTransitions({ timeline, overlays, brand: brandFixture(), sourceDurations });
    expect(transition_out[0]).toEqual({ kind: "dissolve", seconds: 0.4, tail_available: true });
    expect(transition_out[1]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    expect(summary).toEqual({ requested: 1, applied: 1, downgraded: [] });
  });

  it("downgrades dissolve to cut with reason no_tail when the source runs out of picture", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 10, start: 0, end: 10 },
      { order: 1, source_id: SRC_B, in: 0, out: 3, start: 10, end: 13 },
    ]);
    const overlays = overlaysFixture([{ before_order: 1, kind: "dissolve" }]);
    const sourceDurations = new Map([[SRC_A, 10.3]]); // 10 + 0.4 > 10.3
    const { transition_out, summary } = assignTransitions({ timeline, overlays, brand: brandFixture(), sourceDurations });
    expect(transition_out[0]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    expect(summary).toEqual({ requested: 1, applied: 0, downgraded: [{ before_order: 1, reason: "no_tail" }] });
  });

  it("downgrades dissolve to cut with reason next_too_short when the incoming segment is under 2x seconds", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 10, start: 0, end: 10 },
      { order: 1, source_id: SRC_B, in: 0, out: 0.5, start: 10, end: 10.5 }, // 0.5s < 2 * 0.4
    ]);
    const overlays = overlaysFixture([{ before_order: 1, kind: "dissolve" }]);
    const sourceDurations = new Map([[SRC_A, 10.5]]);
    const { transition_out, summary } = assignTransitions({ timeline, overlays, brand: brandFixture(), sourceDurations });
    expect(transition_out[0]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    expect(summary).toEqual({ requested: 1, applied: 0, downgraded: [{ before_order: 1, reason: "next_too_short" }] });
  });

  it("lets the agent override with dip_black at a given before_order, applying it when both sides are long enough", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 4, start: 5, end: 9 },
      { order: 2, source_id: SRC_A, in: 0, out: 4, start: 9, end: 13 },
    ]);
    const overlays = overlaysFixture([{ before_order: 2, kind: "dip_black" }]);
    const { transition_out, summary } = assignTransitions({ timeline, overlays, brand: brandFixture(), sourceDurations: new Map() });
    expect(transition_out[0]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false }); // no override, brand default cut
    expect(transition_out[1]).toEqual({ kind: "dip_black", seconds: 0.4, tail_available: false });
    expect(transition_out[2]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false }); // last segment always cut
    expect(summary).toEqual({ requested: 1, applied: 1, downgraded: [] });
  });

  it("downgrades dip_black to cut with reason too_short when a side is shorter than seconds", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 0.2, start: 0, end: 0.2 }, // < 0.4
      { order: 1, source_id: SRC_A, in: 0, out: 4, start: 0.2, end: 4.2 },
    ]);
    const overlays = overlaysFixture([{ before_order: 1, kind: "dip_black" }]);
    const { transition_out, summary } = assignTransitions({ timeline, overlays, brand: brandFixture(), sourceDurations: new Map() });
    expect(transition_out[0]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    expect(summary).toEqual({ requested: 1, applied: 0, downgraded: [{ before_order: 1, reason: "too_short" }] });
  });

  it("cuts every segment and requests nothing when there is no brand and no overlay transitions", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 5, end: 10 },
    ]);
    const { transition_out, summary } = assignTransitions({ timeline, overlays: null, brand: null, sourceDurations: new Map() });
    expect(transition_out).toEqual([
      { kind: "cut", seconds: 0.4, tail_available: false },
      { kind: "cut", seconds: 0.4, tail_available: false },
    ]);
    expect(summary).toEqual({ requested: 0, applied: 0, downgraded: [] });
  });

  it("returns one transition_out per segment, and never counts the last segment toward requested", () => {
    const timeline = timelineFixture([
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 0, out: 5, start: 5, end: 10 },
      { order: 2, source_id: SRC_A, in: 0, out: 5, start: 10, end: 15 },
    ]);
    const brand = brandFixture({ transition: { kind: "dip_black", seconds: 0.4 } });
    const { transition_out, summary } = assignTransitions({ timeline, overlays: null, brand, sourceDurations: new Map() });
    expect(transition_out).toHaveLength(3);
    expect(transition_out[2]).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    // both non-last cuts requested dip_black and had enough length -> applied
    expect(summary.requested).toBe(2);
    expect(summary.applied).toBe(2);
  });
});
