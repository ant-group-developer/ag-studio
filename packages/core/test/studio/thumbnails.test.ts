import { describe, expect, it } from "vitest";
import type { StudioBranding, ThumbnailStyle } from "@harness/contracts";
import type { TimelineLayout } from "../../src/studio/layout.js";
import {
  frameCandidateTimes, suggestionFrame, thumbnailAss, thumbnailFontSize, thumbnailStyle, thumbnailTextLayout, thumbnailTextLines,
} from "../../src/studio/thumbnails.js";

function layout(clips: [string, number][], texts: [number, number][] = []): TimelineLayout {
  let t = 0;
  return {
    clips: clips.map(([asset, d], i) => {
      const c = { clip_id: `C${String(i + 1).padStart(3, "0")}`, asset_id: asset, section_title: null, start: t, end: t + d, duration: d };
      t += d;
      return c;
    }),
    texts: texts.map(([start, end], i) => ({ text_id: `T${String(i + 1).padStart(3, "0")}`, kind: "title", text: "x", start, duration: end - start, end, position: "top_left" })),
    sections: [],
    duration: t,
  } as TimelineLayout;
}

const style = (over: Partial<ThumbnailStyle> = {}): ThumbnailStyle => ({
  position: "bottom", size: "l", text_color: "#FFFFFF", outline_color: "#000000", box_color: null, uppercase: false, ...over,
});

describe("frameCandidateTimes", () => {
  it("cuts three clean moments inside each clip, away from its edges", () => {
    const f = frameCandidateTimes(layout([["a1", 10], ["a2", 10]]));
    expect(f.map((x) => x.t_s)).toEqual([2.75, 5, 7.25, 12.75, 15, 17.25]);
    expect(f.map((x) => x.asset_id)).toEqual(["a1", "a1", "a1", "a2", "a2", "a2"]);
    expect(f[0]!.clip_id).toBe("C001");
  });

  it("skips moments with words on screen, but keeps one frame for each asset the kit picked", () => {
    // a title over 0..10 covers all of a1; a2 is clean
    const f = frameCandidateTimes(layout([["a1", 10], ["a2", 10]], [[0, 10]]), { kitAssetIds: ["a1"] });
    expect(f.filter((x) => x.asset_id === "a1").map((x) => x.t_s)).toEqual([5]);
    expect(f.filter((x) => x.asset_id === "a2")).toHaveLength(3);
  });

  it("thins to `max` evenly and still keeps the kit's frames; a very short clip gets its middle", () => {
    const clips = Array.from({ length: 20 }, (_, i) => [`a${i}`, 6] as [string, number]);
    const f = frameCandidateTimes(layout(clips), { max: 10, kitAssetIds: ["a19"] });
    expect(f).toHaveLength(10);
    expect(f.some((x) => x.asset_id === "a19")).toBe(true);
    expect(f.map((x) => x.t_s)).toEqual([...f.map((x) => x.t_s)].sort((a, b) => a - b));
    expect(frameCandidateTimes(layout([["a", 0.8]])).map((x) => x.t_s)).toEqual([0.4]);
  });

  it("picks the candidate nearest the middle of an asset's clip for a suggestion", () => {
    const l = layout([["a1", 10], ["a2", 10]]);
    const f = frameCandidateTimes(l);
    expect(suggestionFrame(l, f, "a2")!.t_s).toBe(15);
    expect(suggestionFrame(l, f, "nope")).toBeNull();
  });
});

describe("thumbnail words", () => {
  it("takes the branding's colours, position and case", () => {
    const branding = { thumbnail: { palette: { text: "#ffd60a", outline: "#1d1d1d", accent: "#e63946" }, position: "top", text_case: "upper" } } as StudioBranding;
    expect(thumbnailStyle(branding)).toEqual({ position: "top", size: "l", text_color: "#FFD60A", outline_color: "#1D1D1D", box_color: null, uppercase: true });
    expect(thumbnailStyle(null)).toEqual(style());
  });

  it("wraps into at most three lines and upper-cases Vietnamese", () => {
    expect(thumbnailFontSize(1280, 720, "l")).toBe(108);
    // 108 px bold glyphs: about 19 characters fit in 90% of 1280 px
    expect(thumbnailTextLines("phở bát đàn xếp hàng từ sáu giờ sáng", { width: 1280, height: 720, style: style({ uppercase: true }) }))
      .toEqual(["PHỞ BÁT ĐÀN XẾP", "HÀNG TỪ SÁU GIỜ", "SÁNG"]);
    expect(thumbnailTextLines("phở ngon", { width: 1280, height: 720, style: style() })).toEqual(["phở ngon"]);
    const many = thumbnailTextLines("một hai ba bốn năm sáu bảy tám chín mười mười một mười hai", { width: 1280, height: 720, style: style({ position: "left" }) });
    expect(many).toHaveLength(3);
    expect(thumbnailTextLines("   ", { width: 1280, height: 720, style: style() })).toEqual([]);
  });

  it("draws the lines with libass: frame size, alignment, colours, escaped text", () => {
    const ass = thumbnailAss({ width: 1280, height: 720, lines: ["PHỞ {NGON}", "6 GIỜ"], style: style({ position: "top", text_color: "#FFD60A" }) });
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("PlayResY: 720");
    expect(ass).toContain("WrapStyle: 2");
    const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Thumb"))!;
    expect(styleLine.split(",")[1]).toBe("Arial");
    expect(styleLine.split(",")[3]).toBe("&H000AD6FF");
    expect(styleLine.split(",")[18]).toBe("8");
    expect(ass).toContain("PHỞ \\{NGON\\}\\N6 GIỜ");
    const boxed = thumbnailAss({ width: 1280, height: 720, lines: ["A"], style: style({ box_color: "#E63946" }) });
    expect(boxed.split("\n").find((l) => l.startsWith("Style: Thumb"))!.split(",")[15]).toBe("3");
  });

  it("places the lines for the Canva PDF where libass puts them: margin, alignment, line height", () => {
    const measure = (text: string, size: number) => text.length * size * 0.5;
    const bottom = thumbnailTextLayout({ width: 1280, height: 720, lines: ["AB", "ABCD"], style: style(), measure });
    // 720 * 0.15 = 108 px font, 36 px margin, two 124.2 px lines ending at the margin
    expect(bottom.size).toBe(108);
    expect(bottom.lines.map((l) => Math.round(l.x))).toEqual([586, 532]);
    expect(Math.round(bottom.lines[1]!.baseline - bottom.lines[0]!.baseline)).toBe(124);
    expect(Math.round(bottom.lines[0]!.baseline)).toBe(Math.round(720 - 36 - 2 * 124.2 + 108 * 0.905));
    const left = thumbnailTextLayout({ width: 1280, height: 720, lines: ["AB"], style: style({ position: "left" }), measure });
    expect(left.lines[0]!.x).toBe(36);
    const right = thumbnailTextLayout({ width: 1280, height: 720, lines: ["AB"], style: style({ position: "right" }), measure });
    expect(right.lines[0]!.x).toBe(1280 - 36 - 108);
    const top = thumbnailTextLayout({ width: 720, height: 1280, lines: ["AB"], style: style({ position: "top", size: "s" }), measure });
    expect(top.size).toBe(65);
    expect(top.lines[0]!.baseline).toBeCloseTo(36 + 65 * 0.905);
  });
});
