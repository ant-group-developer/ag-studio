import { describe, expect, it } from "vitest";
import { durationBucket, median, parseChannelInput, parseIsoDuration, titleTerms } from "../src/youtube-research.js";

const CHANNEL = "UC" + "a".repeat(22);

describe("parseChannelInput", () => {
  it.each([
    [CHANNEL, { kind: "id", value: CHANNEL }],
    ["@AnUongVietNam", { kind: "handle", value: "@AnUongVietNam" }],
    ["https://www.youtube.com/@AnUongVietNam/videos", { kind: "handle", value: "@AnUongVietNam" }],
    [`youtube.com/channel/${CHANNEL}`, { kind: "id", value: CHANNEL }],
    ["https://www.youtube.com/user/oldname", { kind: "username", value: "oldname" }],
    ["https://www.youtube.com/c/Custom", { kind: "handle", value: "@Custom" }],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://youtu.be/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
  ])("%s", (input, expected) => {
    expect(parseChannelInput(input)).toEqual(expected);
  });

  it("rejects what is not YouTube", () => {
    expect(parseChannelInput("https://vimeo.com/123")).toBeNull();
    expect(parseChannelInput("   ")).toBeNull();
  });
});

describe("helpers", () => {
  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1M")).toBe(86460);
    expect(parseIsoDuration(undefined)).toBe(0);
    expect(parseIsoDuration("P0D")).toBe(0);
  });
  it("median, buckets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(durationBucket(30)).toBe("<1m");
    expect(durationBucket(400)).toBe("5-10m");
  });
  it("title terms skip function words and add bigrams", () => {
    expect(titleTerms("Phở bò của Hà Nội")).toEqual(["phở", "bò", "hà", "nội", "phở bò", "bò hà", "hà nội"]);
  });
});
