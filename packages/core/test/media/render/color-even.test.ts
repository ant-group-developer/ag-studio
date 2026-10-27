import { describe, expect, it } from "vitest";
import {
  COLOR_MAX_CHROMA, COLOR_MAX_GAIN, COLOR_MAX_OFFSET, colorFixes, colorFixFilter, parseSignalstats, signalstatsArgs, type ColorStats,
} from "../../../src/media/render/color-even.js";

const stats = (y: number, low: number, high: number, u = 128, v = 128): ColorStats => ({ y, low, high, u, v });

describe("even colour", () => {
  it("reads the averages of the printed frames", () => {
    const frame = (y: number, u: number) => [
      `[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YLOW=${y - 50}`, `[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=${y}`,
      `[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YHIGH=${y + 50}`, `[Parsed_metadata_4 @ 0x1] lavfi.signalstats.UAVG=${u}`,
      "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.VAVG=130", "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YMIN=16",
    ].join("\n");
    expect(parseSignalstats(`${frame(100, 126)}\n${frame(120, 130)}`)).toEqual({ y: 110, low: 60, high: 160, u: 128, v: 130 });
    expect(parseSignalstats("no frames")).toBeNull();
  });

  it("measures the picture of the file at a small size", () => {
    const argv = signalstatsArgs("ffmpeg", "body.mp4");
    expect(argv.join(" ")).toContain("signalstats,metadata=mode=print");
    expect(argv.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("leaves the median segment alone and moves the odd one part of the way", () => {
    const fixes = colorFixes([stats(110, 40, 180), stats(112, 42, 182), stats(80, 50, 130, 124, 136), stats(111, 41, 181)]);
    expect(fixes[0]).toBeNull();
    expect(fixes[3]).toBeNull();
    const odd = fixes[2]!;
    // more contrast, brighter, the cast pulled back toward the others
    expect(odd.gain).toBeGreaterThan(1);
    expect(odd.offset + 80 * odd.gain).toBeGreaterThan(80);
    expect(odd.offset + 80 * odd.gain).toBeLessThan(111);
    expect(odd.u).toBeGreaterThan(0);
    expect(odd.v).toBeLessThan(0);
  });

  it("never moves a segment further than its limits", () => {
    const fixes = colorFixes([stats(150, 60, 240, 100, 160), stats(40, 30, 60, 160, 100), stats(150, 60, 240, 100, 160)]);
    const f = fixes[1]!;
    expect(Math.abs(f.gain - 1)).toBeLessThanOrEqual(COLOR_MAX_GAIN + 1e-9);
    expect(Math.abs(f.offset)).toBeLessThanOrEqual(COLOR_MAX_OFFSET);
    expect(Math.abs(f.u)).toBeLessThanOrEqual(COLOR_MAX_CHROMA);
    expect(Math.abs(f.v)).toBeLessThanOrEqual(COLOR_MAX_CHROMA);
  });

  it("does not measure or match a flat segment, nor anything with fewer than two measured", () => {
    const fixes = colorFixes([stats(110, 40, 180), stats(20, 16, 22), stats(70, 30, 100), null]);
    expect(fixes[1]).toBeNull();
    expect(fixes[3]).toBeNull();
    expect(colorFixes([stats(110, 40, 180), null, stats(20, 16, 22)])).toEqual([null, null, null]);
  });

  it("writes the correction as one lutyuv", () => {
    expect(colorFixFilter({ gain: 1.08, offset: -3.5, u: 2, v: -1.25 }))
      .toBe("lutyuv=y='clip(val*1.08-3.5,minval,maxval)':u='clip(val+2,minval,maxval)':v='clip(val-1.25,minval,maxval)'");
  });
});
