import { describe, expect, it } from "vitest";
import type { BrandProfile, CaptionCue, TextEvent } from "@harness/contracts";
import { buildAss, countDialogues, wrapTextLines } from "../../src/media/ass.js";

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

  describe("texts at one position at the same time (feedback-vps §4.1)", () => {
    const at = (ass: string, id: string) => {
      const line = ass.split("\n").filter((l) => l.startsWith("Dialogue: 1,")).find((l) => l.endsWith(id))!;
      const m = /\\an(\d)\\pos\((\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\)/.exec(line)!;
      return { an: Number(m[1]), x: Number(m[2]), y: Number(m[3]), line };
    };
    const ev = (id: string, text: string, start: number, end: number, position: TextEvent["position"], extra: Partial<TextEvent> = {}): TextEvent =>
      ({ id, kind: "lower_third", text, start, end, position, animation: "fade", ...extra });

    it("stack instead of covering each other: up the screen at the bottom, down it at the top", () => {
      const events = [
        ev("A", "Kiyomizu-dera", 0, 10, "bottom_left"),
        ev("B", "清水寺", 2, 8, "bottom_left"),
        ev("C", "Kyoto", 0, 10, "top_center"),
        ev("D", "京都", 0, 10, "top_center"),
      ];
      const ass = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: events, logo: null, canvas: CANVAS });
      const step = Math.round(72 * (1.3 + 0.3));
      expect(at(ass, "Kiyomizu-dera").y).toBe(2160 - 120);
      expect(at(ass, "清水寺").y).toBe(2160 - 120 - step);
      expect(at(ass, "Kyoto").y).toBe(120);
      expect(at(ass, "京都").y).toBe(120 + step);
      // same x: one column, two lines
      expect(at(ass, "清水寺").x).toBe(at(ass, "Kiyomizu-dera").x);
    });

    it("a text that does not overlap keeps the first slot, and a freed slot is taken again", () => {
      const events = [ev("A", "one", 0, 4, "bottom_left"), ev("B", "two", 1, 9, "bottom_left"), ev("C", "three", 5, 7, "bottom_left"), ev("D", "four", 20, 22, "bottom_left")];
      const ass = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: events, logo: null, canvas: CANVAS });
      expect(at(ass, "one").y).toBe(2040);
      expect(at(ass, "two").y).toBeLessThan(2040);
      expect(at(ass, "three").y).toBe(2040);
      expect(at(ass, "four").y).toBe(2040);
    });

    it("is the same whatever order the events come in", () => {
      const events = [ev("A", "first", 0, 5, "center"), ev("B", "second", 0, 5, "center"), ev("C", "third", 1, 5, "center")];
      const one = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: events, logo: null, canvas: CANVAS });
      const two = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: [...events].reverse(), logo: null, canvas: CANVAS });
      expect(at(two, "third").y).toBe(at(one, "third").y);
      expect(new Set(["first", "second", "third"].map((t) => at(one, t).y)).size).toBe(3);
    });

    it("a text's own size is drawn with \\fs and makes its slot taller", () => {
      const events = [ev("A", "big", 0, 5, "bottom_left", { size: "l" }), ev("B", "small", 0, 5, "bottom_left", { size: "s" })];
      const ass = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: events, logo: null, canvas: CANVAS });
      expect(at(ass, "big").line).toContain(`\\fs${Math.round(72 * 1.25)}`);
      expect(at(ass, "small").line).toContain(`\\fs${Math.round(72 * 0.8)}`);
      expect(at(ass, "small").y).toBe(2040 - Math.round(90 * 1.6));
      expect(buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: [ev("A", "plain", 0, 5, "bottom_left")], logo: null, canvas: CANVAS })).not.toContain("\\fs");
    });

    it("a long text wraps inside the picture and stacks by its line count", () => {
      const long = "A walk through the old streets of Higashiyama, past tea houses, temples and the stone steps of Sannenzaka";
      const events = [ev("A", long, 0, 5, "bottom_left"), ev("B", "second", 0, 5, "bottom_left")];
      const ass = buildAss({ brand: brandFixture(), mode: "none", cues: [], text_events: events, logo: null, canvas: { width: 1920, height: 1080 } });
      const lines = wrapTextLines(long, 72, 1920 - 240);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join(" ")).toBe(long);
      expect(at(ass, "second").y).toBe(1080 - 120 - Math.round(72 * (lines.length * 1.3 + 0.3)));
      expect(ass).toContain(lines.join("\\N"));
    });
  });

  it("wraps CJK text between characters and Latin text at spaces", () => {
    expect(wrapTextLines("日本語の長い文章です", 100, 500)).toEqual(["日本語の長", "い文章です"]);
    expect(wrapTextLines("one two three", 100, 400)).toEqual(["one two", "three"]);
    expect(wrapTextLines("short", 100, 3000)).toEqual(["short"]);
    expect(wrapTextLines("line one\nline two", 100, 3000)).toEqual(["line one", "line two"]);
  });

  it("a shadow and a script font only when asked", () => {
    const plain = buildAss({ brand: brandFixture(), mode: "burn-in", cues: CUES, text_events: TEXT_EVENTS, logo: null, canvas: CANVAS });
    const styles = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Style:")).map((l) => l.split(",")[17]);
    expect(styles(plain).every((s) => s === "0")).toBe(true);
    const shadowed = buildAss({ brand: brandFixture(), mode: "burn-in", cues: CUES, text_events: TEXT_EVENTS, logo: null, canvas: CANVAS, shadow: true });
    expect(styles(shadowed).every((s) => Number(s) >= 2)).toBe(true);
    const jp = buildAss({
      brand: brandFixture(), mode: "burn-in", cues: [{ index: 1, start: 0, end: 2, lines: ["ありがとう"], raise_px: 0, words: [] }],
      text_events: [{ id: "T1", kind: "title", text: "清水寺", start: 0, end: 2, position: "top_left", animation: "fade" }, ...TEXT_EVENTS],
      logo: null, canvas: CANVAS, scriptFont: (t) => (/[\u3040-\u9fff]/.test(t) ? "Noto Sans JP" : null),
    });
    expect(jp).toContain("{\\fnNoto Sans JP}ありがとう");
    expect(jp.split("\n").find((l) => l.endsWith("清水寺"))).toContain("\\fnNoto Sans JP");
    expect(jp.split("\n").find((l) => l.endsWith("Breaking"))).not.toContain("\\fn");
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
