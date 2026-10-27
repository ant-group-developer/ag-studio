import { describe, expect, it } from "vitest";
import { SIZE_RUN_MAX, shotGrammarIssues, type GrammarShot } from "../../src/studio/shot-grammar.js";

const shot = (order: number, over: Partial<GrammarShot> = {}): GrammarShot => ({ order, source_id: `src-${order}`, shot_id: `s00${order}-000`, ...over });
const codes = (shots: GrammarShot[]) => shotGrammarIssues(shots).map((i) => i.code);

describe("editing grammar from what each shot is", () => {
  it("says nothing of shots it knows nothing about, nor of a cut that changes size", () => {
    expect(codes([shot(1), shot(2), shot(3)])).toEqual([]);
    expect(codes([shot(1, { size: "wide" }), shot(2, { size: "medium", source_id: "src-1" }), shot(3, { size: "close", source_id: "src-1" })])).toEqual([]);
  });

  it("two shots of one source of one size back to back; the same size from another source is fine", () => {
    expect(codes([shot(1, { size: "wide" }), shot(2, { size: "medium", source_id: "a" }), shot(3, { size: "medium", source_id: "a" })])).toEqual(["same_size_cut"]);
    expect(codes([shot(1, { size: "wide" }), shot(2, { size: "medium" }), shot(3, { size: "medium" })])).toEqual([]);
  });

  it("a screen direction reversed across a cut, and opposite pans", () => {
    expect(codes([shot(1, { direction: "left_to_right" }), shot(2, { direction: "right_to_left" })])).toEqual(["direction_flip"]);
    expect(codes([shot(1, { direction: "left_to_right" }), shot(2, { direction: "toward" })])).toEqual([]);
    expect(codes([shot(1, { motion: "pan_left" }), shot(2, { motion: "pan_right" })])).toEqual(["pan_clash"]);
    expect(codes([shot(1, { motion: "pan_left" }), shot(2, { motion: "pan_left" })])).toEqual([]);
  });

  it("an opening on a close or a detail; a medium opening is left alone", () => {
    expect(codes([shot(1, { size: "detail" }), shot(2)])).toEqual(["opening_not_wide"]);
    expect(codes([shot(1, { size: "medium" }), shot(2)])).toEqual([]);
  });

  it("once, when more than five shots in a row are of one size", () => {
    const run = Array.from({ length: SIZE_RUN_MAX + 3 }, (_, i) => shot(i + 1, { size: "medium" }));
    expect(codes(run)).toEqual(["size_monotony"]);
    expect(codes(run.slice(0, SIZE_RUN_MAX))).toEqual([]);
  });
});
