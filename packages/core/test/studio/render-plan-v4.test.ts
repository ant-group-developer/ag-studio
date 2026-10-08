import { describe, expect, it } from "vitest";
import { CompositionSchema, TimelineV4Schema, upgradeTimelineV3, type TimelineV3, type TimelineV4 } from "@harness/contracts";
import { applyTimelineOps, setCaptions, setClipMuted, setTransition, TimelineOpError, trimClip } from "../../src/studio/layout.js";
import { studioOverlayAss } from "../../src/studio/overlay.js";
import { timelineToComposition } from "../../src/studio/render-plan.js";

const asset = (d: number) => ({ title: "Video", summary_vi: "Clip", duration_s: d, orientation: "landscape" as const });
const KEY = "b".repeat(64);

function cut(): TimelineV4 {
  const v3: TimelineV3 = {
    schema_version: "studio.timeline/v3", production_id: "prod-1", episode_id: "ep-1", canvas: { width: 3840, height: 2160 }, fps: 30, language: "vi",
    clips: [], texts: [{ text_id: "T001", kind: "title", text: "Hoa Lư", start: 0.5, duration: 3, position: "top_left" }],
    music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true },
    source_audio: { muted: false },
    assets: { a01: asset(20), a02: asset(10) },
    alternates: [],
  };
  const clip = (clip_id: string, asset_id: string, inS: number, out: number | null, line_id: string | null, kind: "cut" | "dissolve") => ({
    clip_id, asset_id, section_title: null, in: inS, out, shot_id: "s000-001", line_id, transition_out: { kind, seconds: kind === "cut" ? 0 : 0.4 },
  });
  return TimelineV4Schema.parse({
    ...upgradeTimelineV3(v3),
    edit_style: "cut",
    clips: [clip("C001", "a01", 2, 5, "L001", "dissolve"), clip("C002", "a02", 1, 5, null, "dissolve"), clip("C003", "a01", 10, 14, "L002", "cut")],
    narration: {
      voice: "tts", lead_seconds: 0.3,
      lines: [
        { line_id: "L001", text: "Phố cổ Hoa Lư lúc chiều tà.", audio: { key: KEY, duration_s: 2.4, words: [
          { word: "Phố", start: 0, end: 0.3 }, { word: "cổ", start: 0.3, end: 0.6 }, { word: "Hoa", start: 0.6, end: 0.9 },
          { word: "Lư", start: 0.9, end: 1.2 }, { word: "lúc", start: 1.3, end: 1.6 }, { word: "chiều", start: 1.6, end: 2 }, { word: "tà.", start: 2, end: 2.4 },
        ] } },
        { line_id: "L002", text: "Đền vua Đinh.", audio: { key: KEY, duration_s: 1.5, words: [
          { word: "Đền", start: 0, end: 0.4 }, { word: "vua", start: 0.4, end: 0.8 }, { word: "Đinh.", start: 0.8, end: 1.5 },
        ] } },
      ],
    },
    captions: { mode: "burn-in" },
  });
}

describe("timelineToComposition on v4", () => {
  it("plays each clip's range of its source, back to back", () => {
    const c = CompositionSchema.parse(timelineToComposition(cut()));
    expect(c.segments.map((s) => [s.order, s.source_path, s.in, s.out, s.start, s.end])).toEqual([
      [0, "asset:a01", 2, 5, 0, 3], [1, "asset:a02", 1, 5, 3, 7], [2, "asset:a01", 10, 14, 7, 11],
    ]);
    expect(c.total_seconds).toBe(11);
    expect(c.output).toEqual({ width: 3840, height: 2160, fps: 30, codec: "h264" });
  });

  it("dissolves where there is a tail, cuts where there is none, never moves a segment", () => {
    const c = timelineToComposition(cut());
    expect(c.segments.map((s) => s.transition_out)).toEqual([
      { kind: "dissolve", seconds: 0.4, tail_available: true },
      { kind: "dissolve", seconds: 0.4, tail_available: true },
      { kind: "cut", seconds: 0, tail_available: false },
    ]);
    expect(c.transitions).toEqual({ requested: 2, applied: 2, downgraded: [] });

    const noTail = timelineToComposition(trimClip(cut(), "C002", 6, null));
    expect(noTail.segments[1]?.transition_out).toEqual({ kind: "cut", seconds: 0.4, tail_available: false });
    expect(noTail.transitions).toEqual({ requested: 2, applied: 1, downgraded: [{ before_order: 2, reason: "no_tail" }] });

    const asCut = timelineToComposition(setTransition(cut(), "C001", "cut", 0));
    expect(asCut.segments.map((s) => [s.start, s.end])).toEqual(timelineToComposition(cut()).segments.map((s) => [s.start, s.end]));
  });

  it("reads the narration over the picture from the voice store", () => {
    const c = timelineToComposition(cut());
    expect(c.voice).toBe("tts");
    expect(c.narration).toEqual([
      { line_id: "L001", wav: "stage:voice/L001.wav", start: 0.3, end: 2.7 },
      { line_id: "L002", wav: "stage:voice/L002.wav", start: 7.3, end: 8.8 },
    ]);
  });

  it("burns subtitles from the words, at their place on the episode", () => {
    const c = timelineToComposition(cut());
    expect(c.captions.mode).toBe("burn-in");
    expect(c.captions.cues.length).toBeGreaterThan(0);
    expect(c.captions.cues[0]?.start).toBeCloseTo(0.3, 3);
    expect(c.captions.cues.at(-1)?.end).toBeCloseTo(8.8, 3);
    expect(c.captions.cues.flatMap((q) => q.words.map((w) => w.word))).toEqual(["Phố", "cổ", "Hoa", "Lư", "lúc", "chiều", "tà.", "Đền", "vua", "Đinh."]);
    const ass = studioOverlayAss(c) ?? "";
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length).toBe(c.captions.cues.length + c.text_events.length);

    const off = timelineToComposition(setCaptions(cut(), "none"));
    expect(off.captions).toEqual({ mode: "none", cues: [] });
  });

  it("ducks the music under the narration when the timeline asks for it", () => {
    const c = timelineToComposition(cut());
    expect(c.music?.duck.windows).toEqual([{ start: 0.3, end: 2.7 }, { start: 7.3, end: 8.8 }]);
    const flat = cut();
    flat.music = { ...flat.music!, ducking: false };
    expect(timelineToComposition(flat).music?.duck.windows).toEqual([]);
  });

  it("lines written but not read (narration declined) become subtitles only: no WAV, no ducking, timed by length", () => {
    const t = cut();
    t.narration = { voice: "none", lead_seconds: 0.3, lines: t.narration.lines.map((l) => ({ ...l, audio: null })) };
    const c = CompositionSchema.parse(timelineToComposition(t));
    expect(c.voice).toBe("none");
    expect(c.narration).toEqual([]);
    expect(c.music?.duck.windows).toEqual([]);
    expect(c.captions.mode).toBe("burn-in");
    expect(c.captions.cues.flatMap((q) => q.words.map((w) => w.word))).toEqual(["Phố", "cổ", "Hoa", "Lư", "lúc", "chiều", "tà.", "Đền", "vua", "Đinh."]);
    // each line is its characters at 14 per second (vi), from 0.3 s after its clip
    expect(c.captions.cues[0]?.start).toBeCloseTo(0.3, 3);
    const l1 = c.captions.cues.filter((q) => q.start < 7).at(-1)!;
    expect(l1.end).toBeCloseTo(0.3 + "Phố cổ Hoa Lư lúc chiều tà.".length / 14, 2);
    expect(c.captions.cues.at(-1)?.end).toBeCloseTo(7.3 + "Đền vua Đinh.".length / 14, 2);
    expect(c.warnings.some((w) => w.startsWith("word_interpolated"))).toBe(false);
    // captions off: nothing at all
    expect(timelineToComposition({ ...t, captions: { mode: "none" } }).captions).toEqual({ mode: "none", cues: [] });
  });

  it("a timeline with no narration and no captions renders as before", () => {
    const t = cut();
    t.narration = { voice: "none", lead_seconds: 0.3, lines: [] };
    t.clips = t.clips.map((c) => ({ ...c, line_id: null }));
    t.captions = { mode: "none" };
    const c = timelineToComposition(t);
    expect(c.voice).toBe("none");
    expect(c.narration).toEqual([]);
    expect(c.captions).toEqual({ mode: "none", cues: [] });
    expect(c.music?.duck.windows).toEqual([]);
  });

  it("cut 1.1.0: a clip muted on its own is silent, the others keep their sound; the timeline's switch still wins", () => {
    const t = setClipMuted(cut(), "C002", true);
    expect(t.clips.map((c) => c.muted)).toEqual([undefined, true, undefined]);
    expect(CompositionSchema.parse(timelineToComposition(t)).segments.map((s) => s.has_audio)).toEqual([true, false, true]);
    // on again: the key goes, the document is as before
    expect(setClipMuted(t, "C002", false)).toEqual(cut());
    expect(timelineToComposition({ ...t, source_audio: { muted: true } }).segments.map((s) => s.has_audio)).toEqual([false, false, false]);
    // the chat's edit, and only on a shot-cut timeline's clips
    expect(applyTimelineOps(cut(), [{ op: "setClipMuted", clip_id: "C003", muted: true }], {}).clips[2]!.muted).toBe(true);
    expect(() => applyTimelineOps(cut(), [{ op: "setClipMuted", clip_id: "C009", muted: true }], {})).toThrow(TimelineOpError);
    expect(TimelineV4Schema.parse(t).clips[1]!.muted).toBe(true);
  });

  it("cut 1.1.0: the timeline's text look reaches the composition and the burnt-in texts; without one, as before", () => {
    const plain = timelineToComposition(cut());
    expect("text_style" in plain).toBe(false);
    const look = { text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "l" as const };
    const c = CompositionSchema.parse(timelineToComposition({ ...cut(), text_style: look }));
    expect(c.text_style).toEqual(look);
    const ass = studioOverlayAss(c)!;
    const style = (name: string) => ass.split("\n").find((l) => l.startsWith(`Style: ${name},`))!.split(",");
    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, …, BorderStyle (15)
    const title = style("Title");
    expect(title[3]).toBe("&H0066D1FF");
    expect(title[5]).toBe(title[6]); // the box is filled with the box colour, not the outline's black
    expect(title[15]).toBe("3");
    expect(Number(title[2])).toBe(Math.round(120 * 1.25));
    expect(style("Callout")[15]).toBe("1");
    // the default look is untouched: its box keeps the outline colour as before
    const before = studioOverlayAss(CompositionSchema.parse(plain))!.split("\n").find((l) => l.startsWith("Style: Title,"))!.split(",");
    expect(before[5]).toBe("&H00000000");
    // no box colour: no text sits on a box
    expect(studioOverlayAss(timelineToComposition({ ...cut(), text_style: { ...look, box_color: null } }))!.split("\n")
      .filter((l) => l.startsWith("Style:")).every((l) => l.split(",")[15] === "1")).toBe(true);
  });

  it("the footage's own speech (narration original) plays at its own level, not lowered as background", () => {
    const t = cut();
    t.narration = { voice: "original", lead_seconds: 0.3, lines: [] };
    t.clips = t.clips.map((c) => ({ ...c, line_id: null }));
    const c = timelineToComposition(t);
    expect(c.voice).toBe("original");
    expect(c.narration).toEqual([]);
    expect(c.segments.every((s) => s.has_audio)).toBe(true);
    expect(CompositionSchema.parse(c).voice).toBe("original");
  });
});
