import { describe, expect, it } from "vitest";
import { EdlSchema } from "@harness/contracts";
import { FIT, fitEdl } from "../../src/media/fit-edl.js";
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

const TWO_SOURCES = shotsFixture([sixShots(SRC_A, 0), sixShots(SRC_B, 1)]);

describe("fitEdl - voice tts", () => {
  it("trims an over-long entry to in + need (lead + lines + tail)", () => {
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 8, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 3 }]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES),
      transcript: null,
      voice: "tts",
    });
    // need = 3 + 0.3 + 0.4 = 3.7; 8 - 3.7 = 4.3 >= keepSlack, so it is trimmed
    expect(edl.entries).toEqual([{ source_id: SRC_A, in: 0, out: 3.7, order: 0, overlay: null, note: "" }]);
    expect(report.entries[0]).toMatchObject({ action: "trimmed", before: { in: 0, out: 8 }, after: { in: 0, out: 3.7 } });
    expect(report.total_seconds).toBe(3.7);
  });

  it("keeps an entry whose slack over need is below keepSlack", () => {
    // need = 4.0 + 0.7 = 4.7; entry is 4.9s, so the slack is 0.2 < 0.5 -> kept untouched.
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 4.9, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 4 }]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES),
      transcript: null,
      voice: "tts",
    });
    expect(edl.entries[0]).toMatchObject({ in: 0, out: 4.9 });
    expect(report.entries[0]!.action).toBe("kept");
  });

  it("sums every line of the same edl_order into one need", () => {
    const { edl } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 8, order: 0 }]),
      timing: timingFixture([
        { line_id: "L001", edl_order: 0, duration_seconds: 2 },
        { line_id: "L002", edl_order: 0, duration_seconds: 1.5 },
      ]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES),
      transcript: null,
      voice: "tts",
    });
    // need = 2 + 1.5 + 0.7 = 4.2
    expect(edl.entries[0]!.out).toBe(4.2);
  });

  it("extends a short entry to the end of its shot, then appends the adjacent shot", () => {
    const { edl, report, orderMap } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 10, out: 13, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES),
      transcript: null,
      voice: "tts",
    });
    // need = 6.7; shot s000-002 = [10,15] gives 5s, so 1.7s is appended from s000-003 = [15,20].
    expect(edl.entries).toEqual([
      { source_id: SRC_A, in: 10, out: 15, order: 0, overlay: null, note: "" },
      { source_id: SRC_A, in: 15, out: 16.7, order: 1, overlay: null, note: "fit: appended for L001" },
    ]);
    expect(report.entries.map((e) => e.action)).toEqual(["extended", "appended"]);
    expect(report.entries[1]!.before).toBeNull();
    expect(orderMap.get(0)).toEqual([0, 1]);
    expect(report.shortfalls).toEqual([]);
    expect(report.reused_seconds).toBe(0);
  });

  it("skips an adjacent shot marked unusable and takes the best-scoring unused shot instead", () => {
    const survey = surveyFor(TWO_SOURCES, { "s000-003": { usable: false }, "s001-004": { score: 5 } });
    const { edl } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 10, out: 13, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots: TWO_SOURCES,
      survey,
      transcript: null,
      voice: "tts",
    });
    expect(edl.entries[1]).toEqual({
      source_id: SRC_B,
      in: 20,
      out: 21.7,
      order: 1,
      overlay: null,
      note: "fit: appended for L001",
    });
  });

  it("never appends a shot the original EDL places later", () => {
    const survey = surveyFor(TWO_SOURCES, { "s001-000": { score: 5 } });
    const { edl } = fitEdl({
      edl: edlFixture([
        { source_id: SRC_A, in: 10, out: 13, order: 0 },
        { source_id: SRC_A, in: 15, out: 18, order: 1 }, // s000-003: used, even though it comes later
      ]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots: TWO_SOURCES,
      survey,
      transcript: null,
      voice: "tts",
    });
    const appended = edl.entries[1]!;
    expect(appended.note).toBe("fit: appended for L001");
    expect(appended.source_id).toBe(SRC_B);
    expect(appended).toMatchObject({ in: 0, out: 1.7 });
  });

  it("reuses the best-scoring used shot when nothing is unused, and records the shortfall", () => {
    const shots = shotsFixture([{ source_id: SRC_A, index: 0, duration: 10, shots: [[0, 5], [5, 10]] }]);
    const survey = surveyFor(shots, { "s000-000": { score: 3 }, "s000-001": { score: 5 } });
    const { edl, report, orderMap } = fitEdl({
      edl: edlFixture([
        { source_id: SRC_A, in: 0, out: 3, order: 0 },
        { source_id: SRC_A, in: 5, out: 8, order: 1 },
      ]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots,
      survey,
      transcript: null,
      voice: "tts",
    });
    // need 6.7; shot [0,5] gives 5, the adjacent shot is already used -> reuse the score-5 shot for 1.7s
    expect(edl.entries[1]).toEqual({
      source_id: SRC_A,
      in: 5,
      out: 6.7,
      order: 1,
      overlay: null,
      note: "fit: reused for L001",
    });
    expect(report.shortfalls).toEqual([{ line_ids: ["L001"], missing_seconds: 1.7 }]);
    expect(report.reused_seconds).toBe(1.7);
    expect(orderMap.get(0)).toEqual([0, 1]);
    expect(orderMap.get(1)).toEqual([2]);
  });

  it("records a bare shortfall and adds no entry when there is no footage at all", () => {
    const shots = shotsFixture([{ source_id: SRC_A, index: 0, duration: 30, shots: [] }]);
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 3, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots,
      survey: null,
      transcript: null,
      voice: "tts",
    });
    expect(edl.entries).toHaveLength(1);
    expect(edl.entries[0]).toMatchObject({ in: 0, out: 3 });
    expect(report.shortfalls).toEqual([{ line_ids: ["L001"], missing_seconds: 3.7 }]);
    expect(report.reused_seconds).toBe(0);
  });

  it("leaves an entry with no narration line alone and renumbers order contiguously", () => {
    const { edl, report, orderMap } = fitEdl({
      edl: edlFixture([
        { source_id: SRC_A, in: 10, out: 13, order: 0 },
        { source_id: SRC_B, in: 0, out: 4, order: 7, note: "b-roll", overlay: "avatar" },
      ]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 6 }]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES),
      transcript: null,
      voice: "tts",
    });
    expect(edl.entries.map((e) => e.order)).toEqual([0, 1, 2]);
    expect(edl.entries[2]).toEqual({ source_id: SRC_B, in: 0, out: 4, order: 2, overlay: "avatar", note: "b-roll" });
    expect(report.entries[2]!.action).toBe("kept");
    expect(orderMap.get(0)).toEqual([0, 1]);
    expect(orderMap.get(7)).toEqual([2]);
    expect(() => EdlSchema.parse(edl)).not.toThrow();
  });

  it("is deterministic: the same input twice gives a deep-equal result", () => {
    const input = {
      edl: edlFixture([{ source_id: SRC_A, in: 10, out: 13, order: 0 }]),
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 40 }]),
      shots: TWO_SOURCES,
      survey: surveyFor(TWO_SOURCES, { "s001-002": { score: 4 }, "s001-005": { score: 4 } }),
      transcript: null,
      voice: "tts" as const,
    };
    const a = fitEdl(input);
    const b = fitEdl(input);
    expect(a.edl).toEqual(b.edl);
    expect(a.report).toEqual(b.report);
    expect([...a.orderMap]).toEqual([...b.orderMap]);
  });
});

describe("fitEdl - voice original", () => {
  const SHOTS = shotsFixture([{ source_id: SRC_A, index: 0, duration: 30, shots: [[0, 15], [15, 30]] }]);

  it("pulls `in` back to the trailing edge of the silence before it, never past the gap centre", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [{ start: 9.5, end: 10.6, text: "one two", words: words([["one", 9.5, 9.8], ["two", 10.1, 10.6]]) }],
      },
    ]);
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 10.2, out: 14, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    // gap [9.8, 10.1] is 0.3s long and its edge is 0.1s from t=10.2 -> in = 10.1 - 0.08
    expect(edl.entries[0]!.in).toBe(10.02);
    expect(report.entries[0]!.action).toBe("snapped");
    expect(report.warnings).toEqual([]);
  });

  it("pushes `out` forward to the leading edge of the silence after it", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [{ start: 12, end: 13.2, text: "three four", words: words([["three", 12, 12.5], ["four", 12.9, 13.2]]) }],
      },
    ]);
    const { edl } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 5, out: 12.3, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    // gap [12.5, 12.9] -> out = 12.5 + 0.08 (centre 12.7 is later, so the handle wins)
    expect(edl.entries[0]!.out).toBe(12.58);
  });

  it("never moves a point past the centre of a short gap", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [{ start: 9, end: 10, text: "a b", words: words([["a", 9, 9.4], ["b", 9.56, 10]]) }],
      },
    ]);
    const { edl } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 9.7, out: 14, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    // gap [9.4, 9.56] is exactly 0.16s: 9.56 - 0.08 == centre 9.48, and never earlier than it
    expect(edl.entries[0]!.in).toBe(9.48);
  });

  it("keeps a point and warns when no silence of minGap sits inside the snap window", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [
          {
            start: 9,
            end: 11,
            text: "a b c",
            words: words([["a", 9, 9.9], ["b", 9.95, 10.5], ["c", 10.55, 11]]),
          },
        ],
      },
    ]);
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 10.2, out: 14, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    expect(edl.entries[0]!.in).toBe(10.2);
    expect(report.entries[0]!.action).toBe("kept");
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("10.2");
    expect(report.warnings[0]).toContain("order 0");
  });

  it("snaps to segment boundaries when the transcript has no word alignment", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "segment",
        segments: [
          { start: 4.8, end: 8, text: "first" },
          { start: 11.9, end: 12.4, text: "second" },
        ],
      },
    ]);
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 5, out: 12.2, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    expect(edl.entries[0]).toMatchObject({ in: 4.8, out: 12.4 });
    expect(report.entries[0]!.action).toBe("snapped");
  });

  it("leaves a cut point that is not inside a word alone", () => {
    const transcript = transcriptFixture([
      {
        source_id: SRC_A,
        alignment: "word",
        segments: [{ start: 9.5, end: 10.6, text: "one two", words: words([["one", 9.5, 9.8], ["two", 10.1, 10.6]]) }],
      },
    ]);
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 9.9, out: 14, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript,
      voice: "original",
    });
    expect(edl.entries[0]).toMatchObject({ in: 9.9, out: 14 });
    expect(report.entries[0]!.action).toBe("kept");
  });
});

describe("fitEdl - all modes", () => {
  const SHOTS = shotsFixture([sixShots(SRC_A, 0)]);

  it("voice none leaves every entry exactly as it was", () => {
    const edlIn = edlFixture([
      { source_id: SRC_A, in: 1, out: 4, order: 0 },
      { source_id: SRC_A, in: 20, out: 24, order: 1 },
    ]);
    const { edl, report } = fitEdl({
      edl: edlIn,
      timing: timingFixture([{ line_id: "L001", edl_order: 0, duration_seconds: 30 }]),
      shots: SHOTS,
      survey: null,
      transcript: null,
      voice: "none",
    });
    expect(edl.entries).toEqual(edlIn.entries);
    expect(report.entries.every((e) => e.action === "kept")).toBe(true);
    expect(report.voice).toBe("none");
  });

  it("clamps in/out into the source duration", () => {
    const { edl } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 28, out: 44, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript: null,
      voice: "none",
    });
    expect(edl.entries[0]).toMatchObject({ in: 28, out: 30 });
  });

  it("drops an entry shorter than minEntry after clamping and keeps it in the report", () => {
    const { edl, report, orderMap } = fitEdl({
      edl: edlFixture([
        { source_id: SRC_A, in: 1, out: 4, order: 0 },
        { source_id: SRC_A, in: 29.95, out: 30.5, order: 1 },
      ]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript: null,
      voice: "none",
    });
    expect(edl.entries).toHaveLength(1);
    expect(edl.entries[0]!.order).toBe(0);
    expect(report.entries[1]).toMatchObject({ action: "dropped", after: { in: 29.95, out: 30 } });
    expect(report.warnings).toHaveLength(1);
    expect(orderMap.get(0)).toEqual([0]);
    expect(orderMap.get(1)).toEqual([]);
  });

  it("keeps the first original entry when every entry would be dropped", () => {
    const { edl, report } = fitEdl({
      edl: edlFixture([{ source_id: SRC_A, in: 29.95, out: 30.5, order: 3 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript: null,
      voice: "none",
    });
    expect(edl.entries).toEqual([{ source_id: SRC_A, in: 29.95, out: 30.5, order: 0, overlay: null, note: "" }]);
    expect(report.warnings.some((w) => w.includes("every entry"))).toBe(true);
    expect(() => EdlSchema.parse(edl)).not.toThrow();
  });

  it("reports within_target against the requested window", () => {
    const base = {
      edl: edlFixture([{ source_id: SRC_A, in: 0, out: 4, order: 0 }]),
      timing: timingFixture([]),
      shots: SHOTS,
      survey: null,
      transcript: null,
      voice: "none" as const,
    };
    expect(fitEdl({ ...base, target_duration_seconds: [3, 5] }).report).toMatchObject({
      within_target: true,
      target_duration_seconds: [3, 5],
      total_seconds: 4,
    });
    expect(fitEdl({ ...base, target_duration_seconds: [10, 20] }).report.within_target).toBe(false);
    const noTarget = fitEdl(base).report;
    expect(noTarget.within_target).toBe(true);
    expect("target_duration_seconds" in noTarget).toBe(false);
  });

  it("exposes the fit constants from the brief", () => {
    expect(FIT).toEqual({ lead: 0.3, tail: 0.4, keepSlack: 0.5, snapWindow: 0.4, minGap: 0.15, handle: 0.08, minEntry: 0.2 });
  });
});
