/**
 * vitest unit tests for helpers that will live in ProductionForm.tsx:
 * – mmssToSeconds / secondsToMmss round-trip
 * – YouTube quota estimate formula
 * – YouTube channel link / handle / id validation
 *
 * The helpers are re-declared inline so this file tests the SPEC, not an import.
 * When ProductionForm exports them, change the top import to:
 *   import { mmssToSeconds, secondsToMmss, isValidYoutubeChannel, calcYoutubeQuota }
 *     from "../production/ProductionForm";
 */
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline reference implementations (matching the spec)
// ---------------------------------------------------------------------------

/** Convert "mm:ss" → total seconds.  Returns NaN for malformed input. */
function mmssToSeconds(v: string): number {
  const m = v.match(/^(\d+):(\d{2})$/);
  if (!m) return NaN;
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

/** Convert a non-negative integer seconds value → "mm:ss". */
function secondsToMmss(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** YouTube quota estimate per the spec: N = channels*3 + keywords*201 */
function calcYoutubeQuota(channels: string[], keywords: string[]): number {
  return channels.length * 3 + keywords.length * 201;
}

const YT_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;

/** Returns true when the string looks like a valid YouTube channel ref. */
function isValidYoutubeChannel(v: string): boolean {
  if (!v.trim()) return false;
  // youtube.com / youtu.be URLs
  if (/youtube\.com|youtu\.be/.test(v)) return true;
  // @handle  (e.g. @MrBeast)
  if (/^@[A-Za-z0-9._-]{1,}$/.test(v)) return true;
  // UC… channel id
  if (YT_CHANNEL_RE.test(v)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// mmssToSeconds / secondsToMmss
// ---------------------------------------------------------------------------
describe("mmssToSeconds", () => {
  it("converts '0:00' → 0", () => expect(mmssToSeconds("0:00")).toBe(0));
  it("converts '1:30' → 90", () => expect(mmssToSeconds("1:30")).toBe(90));
  it("converts '10:05' → 605", () => expect(mmssToSeconds("10:05")).toBe(605));
  it("converts '60:00' → 3600", () => expect(mmssToSeconds("60:00")).toBe(3600));
  it("returns NaN for '1:5' (single-digit seconds)", () => expect(mmssToSeconds("1:5")).toBeNaN());
  it("returns NaN for 'abc'", () => expect(mmssToSeconds("abc")).toBeNaN());
  it("returns NaN for empty string", () => expect(mmssToSeconds("")).toBeNaN());
});

describe("secondsToMmss", () => {
  it("converts 0 → '0:00'", () => expect(secondsToMmss(0)).toBe("0:00"));
  it("converts 90 → '1:30'", () => expect(secondsToMmss(90)).toBe("1:30"));
  it("converts 605 → '10:05'", () => expect(secondsToMmss(605)).toBe("10:05"));
  it("round-trips: mmssToSeconds(secondsToMmss(300)) === 300", () =>
    expect(mmssToSeconds(secondsToMmss(300))).toBe(300));
  it("round-trips: secondsToMmss(mmssToSeconds('7:45')) === '7:45'", () =>
    expect(secondsToMmss(mmssToSeconds("7:45"))).toBe("7:45"));
});

// ---------------------------------------------------------------------------
// YouTube quota estimate
// ---------------------------------------------------------------------------
describe("calcYoutubeQuota", () => {
  it("zero channels, zero keywords → 0", () =>
    expect(calcYoutubeQuota([], [])).toBe(0));

  it("1 channel, 0 keywords → 3", () =>
    expect(calcYoutubeQuota(["https://youtube.com/c/test"], [])).toBe(3));

  it("0 channels, 1 keyword → 201", () =>
    expect(calcYoutubeQuota([], ["cooking"])).toBe(201));

  it("3 channels, 10 keywords → 3*3 + 10*201 = 2019 (under 5000 threshold)", () =>
    expect(calcYoutubeQuota(new Array(3).fill("c"), new Array(10).fill("k"))).toBe(2019));

  it("1 channel + 25 keywords → 3 + 25*201 = 5028 (over 5000 threshold)", () => {
    const quota = calcYoutubeQuota(["c"], new Array(25).fill("k"));
    expect(quota).toBe(5028);
    expect(quota).toBeGreaterThan(5000);
  });

  it("threshold boundary: 24 keywords, 1 channel → 3 + 4824 = 4827 (under)", () =>
    expect(calcYoutubeQuota(["c"], new Array(24).fill("k"))).toBe(4827));
});

// ---------------------------------------------------------------------------
// YouTube channel validation
// ---------------------------------------------------------------------------
describe("isValidYoutubeChannel", () => {
  // Valid cases
  it("accepts https://youtube.com/c/SomeChannel", () =>
    expect(isValidYoutubeChannel("https://youtube.com/c/SomeChannel")).toBe(true));

  it("accepts https://www.youtube.com/channel/UCxxxxxx", () =>
    expect(isValidYoutubeChannel("https://www.youtube.com/channel/UCxxxxxx")).toBe(true));

  it("accepts https://youtu.be/dQw4w9WgXcQ (video link is a youtube.com/youtu.be link)", () =>
    expect(isValidYoutubeChannel("https://youtu.be/dQw4w9WgXcQ")).toBe(true));

  it("accepts @handle", () =>
    expect(isValidYoutubeChannel("@MrBeast")).toBe(true));

  it("accepts @handle with dots", () =>
    expect(isValidYoutubeChannel("@some.channel")).toBe(true));

  it("accepts UC channel id (24 chars starting with UC)", () => {
    // 22 alphanumeric chars after "UC"
    const ucId = "UC" + "a".repeat(22);
    expect(isValidYoutubeChannel(ucId)).toBe(true);
  });

  // Invalid cases
  it("rejects plain word 'cooking'", () =>
    expect(isValidYoutubeChannel("cooking")).toBe(false));

  it("rejects http://vimeo.com/channel", () =>
    expect(isValidYoutubeChannel("http://vimeo.com/channel")).toBe(false));

  it("rejects empty string", () =>
    expect(isValidYoutubeChannel("")).toBe(false));

  it("rejects UC id that is too short", () =>
    expect(isValidYoutubeChannel("UC" + "a".repeat(10))).toBe(false));

  it("rejects UC id that is too long", () =>
    expect(isValidYoutubeChannel("UC" + "a".repeat(25))).toBe(false));

  it("rejects plain URL with no youtube domain", () =>
    expect(isValidYoutubeChannel("https://example.com/channel")).toBe(false));
});
