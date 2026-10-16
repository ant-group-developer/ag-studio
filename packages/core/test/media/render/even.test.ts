import { describe, expect, it } from "vitest";
import { ebur128Args, EVEN_MAX_DB, evenGains, parseEbur128Integrated } from "../../../src/media/render/even.js";

const summary = (i: string) => [
  "[Parsed_ebur128_0 @ 0x1] t: 2.9 TARGET:-23 LUFS    M: -20.1 S: -20.3     I: -20.4 LUFS       LRA:   0.0 LU",
  "[Parsed_ebur128_0 @ 0x1] Summary:",
  "",
  "  Integrated loudness:",
  `    I:         ${i} LUFS`,
  "    Threshold: -30.4 LUFS",
].join("\n");

describe("even source sound", () => {
  it("reads the summary's integrated loudness, not a running line's; silence and no summary are null", () => {
    expect(parseEbur128Integrated(summary("-18.7"))).toBe(-18.7);
    expect(parseEbur128Integrated(summary("-70.0"))).toBeNull();
    expect(parseEbur128Integrated("t: 1 I: -20.4 LUFS")).toBeNull();
    expect(ebur128Args("ffmpeg", "a.mp4")).toEqual(["ffmpeg", "-hide_banner", "-nostats", "-i", "a.mp4", "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"]);
  });

  it("brings every measured segment to their median, at most ±12 dB, and leaves silent ones alone", () => {
    expect(evenGains([-20, -30, -26])).toEqual([-6, 4, 0]);
    expect(evenGains([-20, null, -50])).toEqual([-12, 0, 12]);
    expect(evenGains([-20, -30])).toEqual([-5, 5]);
    expect(evenGains([null, null])).toEqual([0, 0]);
    expect(EVEN_MAX_DB).toBe(12);
  });
});
