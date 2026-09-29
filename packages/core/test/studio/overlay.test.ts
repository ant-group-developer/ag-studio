import { describe, expect, it } from "vitest";
import type { TimelineV2 } from "@harness/contracts";
import { buildStudioTimeline } from "../../src/studio/build-timeline.js";
import { studioDefaultBrand, studioOverlayAss } from "../../src/studio/overlay.js";
import { timelineToComposition } from "../../src/studio/render-plan.js";
import { brief, catalog, narration, selection, treatment } from "./fixtures.js";

const AUDIO = new Map([
  ["L001", { key: "audio/a1.wav", duration: 3 }],
  ["L002", { key: "audio/a2.wav", duration: 2.5 }],
  ["L003", { key: "audio/a3.wav", duration: 1.75 }],
  ["L004", { key: "audio/a4.wav", duration: 2 }],
]);

function built(): TimelineV2 {
  return buildStudioTimeline({ brief: brief(), treatment: treatment(), catalog: catalog().segments, selection: selection(), narration: narration(), audio: AUDIO });
}

const dialogues = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

describe("studioOverlayAss", () => {
  it("burns every subtitle cue and text item in Arial", () => {
    const t = built();
    t.texts = [{ text_id: "T001", beat_id: t.clips[0]!.beat_id, kind: "title", text: "Phở bò Hà Nội", offset: 0.5, duration: 2, position: "top_left" }];
    const comp = timelineToComposition(t, { audioInput: (k) => `stage:${k}` });
    const ass = studioOverlayAss(comp)!;

    expect(ass).toContain(`PlayResX: ${comp.output.width}`);
    const styles = ass.split("\n").filter((l) => l.startsWith("Style:"));
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s.split(",")[1]).toBe("Arial");
    // one line per cue, plus the title
    expect(dialogues(ass)).toHaveLength(comp.captions.cues.length + 1);
    expect(ass).toContain("Phở bò Hà Nội");
  });

  it("returns null when there is nothing to burn in", () => {
    const t = built();
    t.captions.enabled = false;
    t.texts = [];
    expect(studioOverlayAss(timelineToComposition(t, { audioInput: (k) => k }))).toBeNull();
  });

  it("scales the 4K-tuned sizes to the canvas' short edge", () => {
    const fullHd = studioDefaultBrand({ width: 1920, height: 1080 });
    expect(fullHd.subtitles.size_px).toBe(44);
    expect(fullHd.text.title.size_px).toBe(60);
    expect(studioDefaultBrand({ width: 1080, height: 1920 }).subtitles.size_px).toBe(44);
    // never under the schema's 24 px floor
    expect(studioDefaultBrand({ width: 640, height: 360 }).text.lower_third.size_px).toBe(24);
  });
});
