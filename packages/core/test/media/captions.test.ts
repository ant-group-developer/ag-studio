import { describe, expect, it } from "vitest";
import type { CaptionCue, Timeline, Word } from "@harness/contracts";
import { CAPTION, buildCaptionCues, toSrt, toVtt, wrapLines } from "../../src/media/captions.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function w(word: string, start: number, end: number): Word {
  return { word, start, end };
}

function ttsTimeline(narration: Timeline["narration"]): Timeline {
  return {
    schema_version: "harness.timeline/v1",
    voice: "tts",
    language: "en",
    total_seconds: narration.at(-1)?.end ?? 0,
    video: [],
    narration,
    speech: [],
  };
}

function originalTimeline(speech: Timeline["speech"]): Timeline {
  return {
    schema_version: "harness.timeline/v1",
    voice: "original",
    language: "en",
    total_seconds: speech.at(-1)?.end ?? 0,
    video: [],
    narration: [],
    speech,
  };
}

describe("buildCaptionCues", () => {
  it("groups tts words into cues, closing on max duration, punctuation and silence, never under min duration", () => {
    const line1Words = [w("Hello", 0, 0.3), w("world", 0.35, 0.6), w("this", 0.65, 0.9), w("is", 0.95, 1.1), w("a", 1.15, 1.3), w("test.", 1.35, 1.6)];
    const line2Words = [
      w("Next", 2.0, 2.3),
      w("part", 2.35, 2.6),
      // 0.7s silence >= CAPTION.silence_break_seconds -> break after "part"
      w("continues", 3.3, 3.6),
      w("the", 3.65, 3.85),
      w("story", 3.9, 4.15),
      w("here", 4.2, 4.4),
    ];
    const timeline = ttsTimeline([
      { line_id: "L001", wav: "L001.wav", start: 0, end: 1.6, words: line1Words },
      { line_id: "L002", wav: "L002.wav", start: 2.0, end: 4.4, words: line2Words },
    ]);

    const { cues, warnings } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    expect(warnings).toEqual([]);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const cue of cues) {
      const duration = cue.end - cue.start;
      expect(duration).toBeLessThanOrEqual(CAPTION.max_cue_seconds + 1e-9);
      expect(duration).toBeGreaterThanOrEqual(CAPTION.min_cue_seconds - 1e-9);
    }
    // punctuation break: the cue ending in "test." (duration 1.6s >= 1.2s) stops there, not merging with line 2
    const punctCue = cues.find((c) => c.words.at(-1)?.word === "test.");
    expect(punctCue).toBeDefined();
    expect(punctCue!.words.map((word) => word.word)).toEqual(["Hello", "world", "this", "is", "a", "test."]);
    // silence break: "part" and "continues" end up in different cues
    const partCue = cues.find((c) => c.words.some((word) => word.word === "part"));
    const continuesCue = cues.find((c) => c.words.some((word) => word.word === "continues"));
    expect(partCue).not.toBe(continuesCue);
    expect(partCue!.words.map((word) => word.word)).toEqual(["Next", "part"]);
    // "part" cue was under 0.8s (0.6s) and got extended, without crossing into "continues" (start 3.3)
    expect(partCue!.end - partCue!.start).toBeCloseTo(0.8, 6);
  });

  it("interpolates a word with missing timing linearly between its timed neighbours and warns", () => {
    const words: Word[] = [w("one", 0, 0.5), { word: "two", start: 10, end: 5 }, w("three", 1.0, 1.5)];
    const timeline = ttsTimeline([{ line_id: "L001", wav: "L001.wav", start: 0, end: 1.5, words }]);

    const { cues, warnings } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    expect(warnings).toEqual(["word_interpolated:L001:1"]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.words).toEqual([
      { word: "one", start: 0, end: 0.5 },
      { word: "two", start: 0.5, end: 1 },
      { word: "three", start: 1, end: 1.5 },
    ]);
  });

  it("builds cues from original speech segments, never merging across a segment boundary", () => {
    const timeline = originalTimeline([
      { source_id: SRC_A, start: 0, end: 0.7, text: "Alpha Beta", words: [w("Alpha", 0, 0.4), w("Beta", 0.45, 0.7)] },
      { source_id: SRC_A, start: 0.75, end: 1.5, text: "Gamma Delta", words: [w("Gamma", 0.75, 1.1), w("Delta", 1.15, 1.5)] },
    ]);

    const { cues } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    expect(cues).toHaveLength(2);
    expect(cues[0]!.words.map((word) => word.word)).toEqual(["Alpha", "Beta"]);
    expect(cues[1]!.words.map((word) => word.word)).toEqual(["Gamma", "Delta"]);
  });

  it("splits on a silence gap that floating-point subtraction rounds just under the threshold", () => {
    const words = [w("Alpha", 0, 0.2), w("Beta", 0.7, 1.0)];
    // 0.7 - 0.2 === 0.49999999999999994 in IEEE754 -- just under CAPTION.silence_break_seconds (0.5)
    // without an epsilon, so this gap must still count as a silence break.
    expect(0.7 - 0.2).toBeLessThan(CAPTION.silence_break_seconds);
    const timeline = ttsTimeline([{ line_id: "L001", wav: "L001.wav", start: 0, end: 1.0, words }]);

    const { cues } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    expect(cues).toHaveLength(2);
    expect(cues[0]!.words.map((word) => word.word)).toEqual(["Alpha"]);
    expect(cues[1]!.words.map((word) => word.word)).toEqual(["Beta"]);
  });

  it("never lets a cue overshoot max_cue_seconds, closing before the word that would push it past 6s", () => {
    const words = [w("one", 0, 5.9), w("two", 5.95, 7.5)];
    const timeline = ttsTimeline([{ line_id: "L001", wav: "L001.wav", start: 0, end: 7.5, words }]);

    const { cues } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(CAPTION.max_cue_seconds + 1e-9);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.words.map((word) => word.word)).toEqual(["one"]);
    expect(cues[1]!.words.map((word) => word.word)).toEqual(["two"]);
  });

  it("caps a short cue's extended end at next.start - cue_gap_seconds, never overlapping the next cue", () => {
    const timeline = ttsTimeline([
      { line_id: "L001", wav: "L001.wav", start: 0, end: 0.3, words: [w("Hi", 0, 0.3)] },
      { line_id: "L002", wav: "L002.wav", start: 0.5, end: 0.9, words: [w("There", 0.5, 0.9)] },
    ]);

    const { cues } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });

    expect(cues).toHaveLength(2);
    // cue0 is under min_cue_seconds (0.3s); start+0.8=0.8 would overlap cue1 (starts 0.5), so the cap binds
    // at next.start - cue_gap_seconds = 0.5 - 0.05 = 0.45.
    expect(cues[0]!.end).toBeCloseTo(0.45, 6);
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start);
  });

  it("returns no cues when voice is none", () => {
    const timeline: Timeline = {
      schema_version: "harness.timeline/v1",
      voice: "none",
      language: "en",
      total_seconds: 5,
      video: [],
      narration: [],
      speech: [],
    };
    const { cues, warnings } = buildCaptionCues({ timeline, max_chars_per_line: 42, max_lines: 2 });
    expect(cues).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("wrapLines", () => {
  it("does not split a trailing number+unit pair like '27,5 %'", () => {
    const lines = wrapLines("Giá tăng 27,5 % so với năm trước", 20, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    const joined = lines.join(" ").replace(/\s+/g, " ");
    expect(joined).toBe("Giá tăng 27,5 % so với năm trước");
    // the cluster "27,5 %" never ends up split across two different lines
    expect(lines.some((l) => l.includes("27,5 %"))).toBe(true);
  });

  it("caps at maxLines, with the last line taking the remainder", () => {
    const lines = wrapLines("one two three four five six seven eight nine ten", 10, 2);
    expect(lines).toHaveLength(2);
  });

  it("returns no lines for empty text", () => {
    expect(wrapLines("", 20, 2)).toEqual([]);
  });
});

describe("toSrt / toVtt", () => {
  const cues: CaptionCue[] = [
    { index: 1, start: 0.3, end: 3.1, lines: ["line1", "line2"], raise_px: 0, words: [] },
    { index: 2, start: 3.15, end: 5.0, lines: ["another"], raise_px: 0, words: [] },
  ];

  it("writes SRT with comma decimal separators", () => {
    const srt = toSrt(cues);
    expect(srt).toBe(
      "1\n00:00:00,300 --> 00:00:03,100\nline1\nline2\n\n" + "2\n00:00:03,150 --> 00:00:05,000\nanother\n\n",
    );
  });

  it("returns an empty string for no cues", () => {
    expect(toSrt([])).toBe("");
  });

  it("writes VTT starting with WEBVTT and dot decimal separators", () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.300 --> 00:00:03.100");
  });

  it("still returns the WEBVTT header for no cues", () => {
    expect(toVtt([])).toBe("WEBVTT\n\n");
  });
});
