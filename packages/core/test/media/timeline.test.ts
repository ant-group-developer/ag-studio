import { describe, expect, it } from "vitest";
import { TimelineSchema } from "@harness/contracts";
import { buildTimeline } from "../../src/media/timeline.js";
import { fitEdl } from "../../src/media/fit-edl.js";
import {
  SRC_A,
  SRC_B,
  edlFixture,
  shotsFixture,
  sixShots,
  surveyFor,
  timingFixture,
  transcriptFixture,
  words,
} from "./fixtures.js";

describe("buildTimeline", () => {
  it("lays video entries end to end on the programme clock", () => {
    const t = buildTimeline({
      edl: edlFixture([
        { source_id: SRC_A, in: 41.2, out: 50.3, order: 0 },
        { source_id: SRC_B, in: 2, out: 4.5, order: 1 },
      ]),
      timing: timingFixture([]),
      transcript: null,
      voice: "none",
      language: "en",
      orderMap: new Map([[0, [0]], [1, [1]]]),
    });
    expect(t.video).toEqual([
      { order: 0, source_id: SRC_A, in: 41.2, out: 50.3, start: 0, end: 9.1 },
      { order: 1, source_id: SRC_B, in: 2, out: 4.5, start: 9.1, end: 11.6 },
    ]);
    expect(t.total_seconds).toBe(11.6);
    expect(t.narration).toEqual([]);
    expect(t.speech).toEqual([]);
    expect(() => TimelineSchema.parse(t)).not.toThrow();
  });

  it("places the first line of a group at the entry start + lead and chains the rest", () => {
    const t = buildTimeline({
      edl: edlFixture([
        { source_id: SRC_A, in: 0, out: 10, order: 0 },
        { source_id: SRC_A, in: 10, out: 15, order: 1 },
      ]),
      timing: timingFixture([
        { line_id: "L001", edl_order: 0, duration_seconds: 2, words: words([["Every", 0, 0.25]]) },
        { line_id: "L002", edl_order: 0, duration_seconds: 1.5 },
        { line_id: "L003", edl_order: 1, duration_seconds: 3 },
      ]),
      transcript: null,
      voice: "tts",
      language: "en",
      orderMap: new Map([[0, [0]], [1, [1]]]),
    });
    expect(t.narration).toEqual([
      { line_id: "L001", wav: "voice/L001.wav", start: 0.3, end: 2.3, words: [{ word: "Every", start: 0.3, end: 0.55 }] },
      { line_id: "L002", wav: "voice/L002.wav", start: 2.3, end: 3.8, words: [] },
      { line_id: "L003", wav: "voice/L003.wav", start: 10.3, end: 13.3, words: [] },
    ]);
  });

  it("anchors a group on the first new order that its original order produced", () => {
    const t = buildTimeline({
      edl: edlFixture([
        { source_id: SRC_A, in: 0, out: 5, order: 0 },
        { source_id: SRC_A, in: 5, out: 8, order: 1 },
        { source_id: SRC_B, in: 0, out: 4, order: 2 },
      ]),
      timing: timingFixture([{ line_id: "L001", edl_order: 9, duration_seconds: 2 }]),
      transcript: null,
      voice: "tts",
      language: "en",
      // original order 9 was fitted into new orders 1 and 2 (an appended entry followed it)
      orderMap: new Map([[9, [1, 2]]]),
    });
    expect(t.narration[0]).toMatchObject({ start: 5.3, end: 7.3 });
  });

  it("skips a narration group whose entry was dropped or is unknown", () => {
    const t = buildTimeline({
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 5, order: 0 }]),
      timing: timingFixture([
        { line_id: "L001", edl_order: 0, duration_seconds: 2 },
        { line_id: "L002", edl_order: 1, duration_seconds: 2 },
        { line_id: "L003", edl_order: 4, duration_seconds: 2 },
      ]),
      transcript: null,
      voice: "tts",
      language: "en",
      orderMap: new Map([[0, [0]], [1, []]]),
    });
    expect(t.narration.map((n) => n.line_id)).toEqual(["L001"]);
  });

  it("clips source speech to each cut and moves it onto the programme clock", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [
          { start: 1, end: 2, text: "before the cut", words: words([["before", 1, 1.5], ["cut", 1.5, 2]]) },
          {
            start: 9.5,
            end: 11.5,
            text: "spans the boundary here",
            words: words([["spans", 9.5, 10], ["the", 10.2, 10.6], ["boundary", 10.7, 11], ["here", 11.1, 11.5]]),
          },
          { start: 12, end: 13, text: "fully inside", words: words([["fully", 12, 12.5], ["inside", 12.5, 13]]) },
        ],
      },
    ]);
    const t = buildTimeline({
      edl: edlFixture([{ source_id: SRC_A, in: 10, out: 14, order: 0 }]),
      timing: timingFixture([]),
      transcript,
      voice: "original",
      language: "en",
      orderMap: new Map([[0, [0]]]),
    });
    expect(t.speech).toEqual([
      // [9.5,11.5] clipped to [10,11.5] -> programme [0, 1.5]; "spans" starts before the cut and is dropped
      {
        source_id: SRC_A,
        start: 0,
        end: 1.5,
        text: "the boundary here",
        words: [
          { word: "the", start: 0.2, end: 0.6 },
          { word: "boundary", start: 0.7, end: 1 },
          { word: "here", start: 1.1, end: 1.5 },
        ],
      },
      // wholly inside the cut -> the full segment text survives
      {
        source_id: SRC_A,
        start: 2,
        end: 3,
        text: "fully inside",
        words: [
          { word: "fully", start: 2, end: 2.5 },
          { word: "inside", start: 2.5, end: 3 },
        ],
      },
    ]);
  });

  it("emits no speech track unless the voice is original", () => {
    const transcript = transcriptFixture([
      { source_id: SRC_A, alignment: "word", segments: [{ start: 0, end: 2, text: "hi", words: words([["hi", 0, 2]]) }] },
    ]);
    for (const voice of ["none", "tts"] as const) {
      const t = buildTimeline({
        edl: edlFixture([{ source_id: SRC_A, in: 0, out: 5, order: 0 }]),
        timing: timingFixture([]),
        transcript,
        voice,
        language: "en",
        orderMap: new Map([[0, [0]]]),
      });
      expect(t.speech).toEqual([]);
    }
  });

  it("consumes fitEdl's own output and orderMap end to end", () => {
    const shots = shotsFixture([sixShots(SRC_A, 0), sixShots(SRC_B, 1)]);
    const fitted = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 10, out: 13, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots,
      survey: surveyFor(shots),
      transcript: null,
      voice: "tts",
    });
    const t = buildTimeline({
      edl: fitted.edl,
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      transcript: null,
      voice: "tts",
      language: "vi",
      orderMap: fitted.orderMap,
    });
    expect(t.video.map((v) => [v.start, v.end])).toEqual([[0, 5], [5, 6.7]]);
    expect(t.total_seconds).toBe(6.7);
    expect(t.narration[0]).toMatchObject({ start: 0.3, end: 6.3 });
    expect(t.language).toBe("vi");
  });
});
