import { describe, expect, it } from "vitest";
import { snapEntry } from "../../src/media/snap.js";
import { SRC_A, transcriptFixture, words } from "./fixtures.js";

const O = { window: 0.4, minGap: 0.15, handle: 0.08, minEntry: 0.2 };

/** One word-aligned source; `duration` bounds the trailing silence, so a test can remove it entirely by
 * ending the last word exactly at the duration. */
function snap(p: { in: number; out: number; words: [string, number, number][]; duration: number }) {
  const t = transcriptFixture([
    { source_id: SRC_A, alignment: "word", segments: [{ start: 0, end: p.duration, text: "s", words: words(p.words) }] },
  ]);
  return snapEntry({ order: 0, in: p.in, out: p.out, source: t.sources[0], sourceDuration: p.duration, o: O });
}

describe("snapEntry - inclusive bounds survive decimal subtraction", () => {
  // Each of these gaps is a nominal 0.15s written as a difference of decimals, which in binary floating
  // point lands just under 0.15 at some positions and just over it at others.
  it.each([
    { name: "[1.0, 1.15]", words: [["a", 0, 1.0], ["b", 1.15, 2.0]] as [string, number, number][], at: 1.3, duration: 2.0 },
    { name: "[9.4, 9.55]", words: [["a", 0, 9.4], ["b", 9.55, 10.0]] as [string, number, number][], at: 9.7, duration: 10.0 },
    { name: "[9.8, 9.95]", words: [["a", 0, 9.8], ["b", 9.95, 10.5]] as [string, number, number][], at: 10.1, duration: 10.5 },
  ])("accepts an exactly-minGap silence at $name", ({ words: w, at, duration }) => {
    const r = snap({ in: at, out: duration, words: w, duration });
    expect(r.warnings).toEqual([]);
    expect(r.snapped).toBe(true);
    expect(r.in).toBeLessThan(at);
  });

  it("accepts a silence edge exactly the snap window away", () => {
    // |10.0 - 10.4| evaluates to 0.40000000000000036
    const r = snap({ in: 10.4, out: 11, words: [["a", 0, 9.6], ["b", 10.0, 11.0]], duration: 11 });
    expect(r.snapped).toBe(true);
    expect(r.in).toBeCloseTo(9.92, 6);
    expect(r.warnings).toEqual([]);
  });

  it("still rejects a silence just under minGap", () => {
    const r = snap({ in: 9.7, out: 10, words: [["a", 0, 9.4], ["b", 9.549, 10.0]], duration: 10 });
    expect(r.snapped).toBe(false);
    expect(r.in).toBe(9.7);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("no silence");
  });

  it("still rejects a silence edge just outside the snap window", () => {
    const r = snap({ in: 8.999, out: 10, words: [["a", 0, 9.4], ["b", 9.801, 10.0]], duration: 10 });
    expect(r.snapped).toBe(false);
    expect(r.in).toBe(8.999);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("snapEntry - the two points are resolved as a pair", () => {
  it("keeps the original cut when both points would fall back onto the silence between them", () => {
    const r = snap({ in: 9.95, out: 10.35, words: [["a", 9.0, 10.0], ["b", 10.3, 11.3]], duration: 30 });
    expect(r).toMatchObject({ in: 9.95, out: 10.35, snapped: false });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("order 0");
    expect(r.warnings[0]).toContain("kept its original cut points");
  });

  it("prefers the expanding-only pair when the shrinking fallback would eat the entry", () => {
    // `in` has a real silence before it; `out` has none after it and would otherwise fall back into the
    // same silence, leaving almost nothing. Only the `in` snap is applied.
    const r = snap({
      in: 9.95,
      out: 10.35,
      words: [["a", 9.0, 9.6], ["b", 9.8, 10.0], ["c", 10.3, 11.3]],
      duration: 30,
    });
    expect(r.in).toBeCloseTo(9.72, 6); // gap [9.6, 9.8] -> 9.8 - 0.08
    expect(r.out).toBe(10.35);
    expect(r.snapped).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("still allows a shrinking snap when it leaves a healthy entry", () => {
    // `out` is inside a word with no silence after it in range; the silence before it is used, and the
    // entry is still long enough, so the shrink stands.
    const r = snap({ in: 0, out: 10.35, words: [["a", 9.0, 10.0], ["b", 10.3, 11.3]], duration: 30 });
    expect(r.out).toBeCloseTo(10.08, 6);
    expect(r.snapped).toBe(true);
  });
});
