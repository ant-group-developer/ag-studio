import { describe, expect, it } from "vitest";
import { layoutTimeline } from "@studio/timeline";
import { sampleCutTimeline, sampleTimeline } from "./state/fixtures";
import { sourceTimeAt } from "./Player";

describe("sourceTimeAt", () => {
  it("a shot-cut clip seeks into its video from its in", () => {
    const [c1, c2] = layoutTimeline(sampleCutTimeline()).clips;
    expect(sourceTimeAt(c1!, 0)).toBe(1);   // C001 plays 1–5 s of its video
    expect(sourceTimeAt(c1!, 2.5)).toBe(3.5);
    expect(sourceTimeAt(c2!, c2!.start + 1)).toBe(1);
  });

  it("a whole video seeks from its start", () => {
    const [, c2] = layoutTimeline(sampleTimeline()).clips;
    expect(sourceTimeAt(c2!, c2!.start + 2)).toBe(2);
    expect(sourceTimeAt(c2!, c2!.start - 1)).toBe(0);
  });
});
