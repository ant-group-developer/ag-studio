import { describe, expect, it } from "vitest";
import type { BrandProfile, CaptionCue, TextEvent } from "@harness/contracts";
import { buildAss, countDialogues } from "../../src/media/ass.js";

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

const CUES: CaptionCue[] = [
  { index: 1, start: 0, end: 2, lines: ["hello there"], raise_px: 0, words: [] },
  { index: 2, start: 2, end: 4, lines: ["second cue"], raise_px: 0, words: [] },
  { index: 3, start: 4, end: 6, lines: ["a{b}"], raise_px: 0, words: [] },
];

const TEXT_EVENTS: TextEvent[] = [
  { id: "OV01", kind: "title", text: "Breaking", start: 0.3, end: 4.3, position: "top_left", animation: "slide_up" },
  { id: "OV02", kind: "callout", text: "Wow", start: 1, end: 3, position: "center", animation: "pop" },
];

const CANVAS = { width: 3840, height: 2160 };

describe("buildAss", () => {
  it("counts one Dialogue per cue plus one per text event in burn-in mode", () => {
    const ass = buildAss({ brand: brandFixture(), mode: "burn-in", cues: CUES, text_events: TEXT_EVENTS, logo: null, canvas: CANVAS });
    expect(countDialogues(ass)).toBe(5);
  });

  it("emits karaoke \\kf tags whose centiseconds sum to the cue's own duration", () => {
    const karaokeCue: CaptionCue = {
      index: 1,
      start: 0,
      end: 2,
      lines: ["hi there friend"],
      raise_px: 0,
      words: [
        { word: "hi", start: 0.1, end: 0.4 },
        { word: "there", start: 0.5, end: 0.9 },
        { word: "friend", start: 1.0, end: 1.5 },
      ],
    };
    const ass = buildAss({ brand: brandFixture(), mode: "karaoke", cues: [karaokeCue], text_events: [], logo: null, canvas: CANVAS });
    const dialogueLine = ass.split("\n").find((l) => l.startsWith("Dialogue: 0,"))!;
    expect(dialogueLine).toContain("\\kf");
    const totalCs = [...dialogueLine.matchAll(/\\kf(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(totalCs).toBeGreaterThanOrEqual(Math.round((karaokeCue.end - karaokeCue.start) * 100) - 1);
    expect(totalCs).toBeLessThanOrEqual(Math.round((karaokeCue.end - karaokeCue.start) * 100) + 1);
    // Task 11 (the first real render): libass draws only what sits INSIDE the `\kf` segments, so dropping
    // the separating spaces made every karaoke line read as one long word. Strip the tags and the drawn
    // text must be the cue's own line back again.
    // `Dialogue:` has 9 comma-separated fields before the text, and the text itself may contain commas.
    const drawn = dialogueLine.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "");
    expect(drawn).toBe("hi there friend");
  });

  // Two words that abut (no measurable silence between them) still need the separator, and it must not
  // invent a `\kf` segment: a zero-length gap has no time to give one.
  it("separates abutting karaoke words with a bare space, adding no extra \\kf segment", () => {
    const cue: CaptionCue = {
      index: 1, start: 0, end: 1, lines: ["one two"], raise_px: 0,
      words: [{ word: "one", start: 0, end: 0.5 }, { word: "two", start: 0.5, end: 1 }],
    };
    const ass = buildAss({ brand: brandFixture(), mode: "karaoke", cues: [cue], text_events: [], logo: null, canvas: CANVAS });
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue: 0,"))!;
    expect(line.endsWith("{\\kf50}one {\\kf50}two")).toBe(true);
    expect([...line.matchAll(/\\kf(\d+)/g)]).toHaveLength(2);
  });

  it("puts no separator space after a \\N line break", () => {
    const cue: CaptionCue = {
      index: 1, start: 0, end: 1.2, lines: ["one two", "three"], raise_px: 0,
      words: [
        { word: "one", start: 0, end: 0.4 },
        { word: "two", start: 0.4, end: 0.8 },
        { word: "three", start: 0.9, end: 1.2 },
      ],
    };
    const ass = buildAss({ brand: brandFixture(), mode: "karaoke", cues: [cue], text_events: [], logo: null, canvas: CANVAS });
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue: 0,"))!;
    expect(line).toContain("\\N{\\kf10}{\\kf30}three");
    expect(line).not.toContain("\\N ");
  });

  it("emits no cue Dialogue lines in mode none, but keeps text events", () => {
    const ass = buildAss({ brand: brandFixture(), mode: "none", cues: CUES, text_events: TEXT_EVENTS, logo: null, canvas: CANVAS });
    expect(countDialogues(ass)).toBe(2);
  });

  it("escapes braces in cue text", () => {
    const ass = buildAss({ brand: brandFixture(), mode: "burn-in", cues: CUES, text_events: [], logo: null, canvas: CANVAS });
    expect(ass).toContain("a\\{b\\}");
    expect(ass).not.toContain("a{b}");
  });

  it("converts brand colors to &HAABBGGRR", () => {
    const brand = brandFixture({ colors: { primary: "#112233", text: "#F2C94C", text_outline: "#000000B3", box: "#000000B3" } });
    const ass = buildAss({ brand, mode: "burn-in", cues: [], text_events: [], logo: null, canvas: CANVAS });
    expect(ass).toContain("&H004CC9F2"); // text color, no alpha -> opaque
    expect(ass).toContain("&H4C000000"); // text_outline #000000B3 -> AA = 255-179 = 76 = 0x4C
  });

  it("generates \\move for a slide_up text event", () => {
    const ass = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: TEXT_EVENTS, logo: null, canvas: CANVAS });
    expect(ass).toMatch(/\\move\(\d+,\d+,\d+,\d+,0,250\)/);
  });

  it("returns zero Dialogue lines and a valid header when brand is null, regardless of mode", () => {
    for (const mode of ["burn-in", "karaoke", "none"] as const) {
      const ass = buildAss({ brand: null, mode, cues: CUES, text_events: TEXT_EVENTS, logo: null, canvas: CANVAS });
      expect(countDialogues(ass)).toBe(0);
      expect(ass).toContain("[Script Info]");
      expect(ass).toContain("PlayResX: 3840");
      expect(ass).toContain("Style: Sub,Arial,");
    }
  });
});
