import { describe, expect, it } from "vitest";
import { layoutTimeline } from "@studio/timeline";
import { sampleCutTimeline, sampleTimeline } from "./state/fixtures";
import { clipMuted, sourceTimeAt, textLookStyle } from "./Player";

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

describe("the preview's sound and text look (cut 1.1.0)", () => {
  it("a clip's own sound is off when the timeline's is, or when it is muted on its own", () => {
    expect(clipMuted({ source_audio: { muted: false } }, { muted: true })).toBe(true);
    expect(clipMuted({ source_audio: { muted: false } }, {})).toBe(false);
    expect(clipMuted({ source_audio: { muted: true } }, {})).toBe(true);
  });

  it("texts are white with a soft shadow by default; in the look, its colours and size, titles on its box", () => {
    expect(textLookStyle(undefined, "title")).toEqual({ color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.8)" });
    const look = { text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "l" as const };
    expect(textLookStyle(look, "title")).toEqual({ color: "#FFD166", fontSize: "1.25em", background: "#1D3557B3" });
    expect(textLookStyle(look, "callout")).toMatchObject({ color: "#FFD166", textShadow: expect.stringContaining("#000000") });
    expect(textLookStyle({ ...look, box_color: null }, "lower_third")).not.toHaveProperty("background");
  });
});
