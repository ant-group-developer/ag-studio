import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/artifacts/checksum.js";
import { MEZZ_VERSION, mezzArgs, mezzCacheKey, scaleFilter } from "../../../src/media/render/mezzanine.js";

const BASE_KEY = {
  source_checksum: "sha256:aaaa",
  in: 0,
  out: 5,
  fit: "scale_pad" as const,
  w: 3840,
  h: 2160,
  fps: 30,
  has_audio: true,
  encoder: "cpu" as const,
  codec: "h264" as const,
};

describe("mezzCacheKey", () => {
  it("changes when `in` changes", () => {
    expect(mezzCacheKey(BASE_KEY)).not.toBe(mezzCacheKey({ ...BASE_KEY, in: 1 }));
  });
  it("changes when `fit` changes", () => {
    expect(mezzCacheKey(BASE_KEY)).not.toBe(mezzCacheKey({ ...BASE_KEY, fit: "scale_crop" }));
  });
  it("changes when `encoder` changes", () => {
    expect(mezzCacheKey(BASE_KEY)).not.toBe(mezzCacheKey({ ...BASE_KEY, encoder: "nvenc" }));
  });
  it("matches an independently computed sha256 of canonicalJson({...key, mezz_version}), and changes when mezz_version changes", () => {
    expect(MEZZ_VERSION).toBe(1);
    const expected = createHash("sha256").update(canonicalJson({ ...BASE_KEY, mezz_version: 1 })).digest("hex");
    expect(mezzCacheKey(BASE_KEY)).toBe(expected);

    const bumped = createHash("sha256").update(canonicalJson({ ...BASE_KEY, mezz_version: 2 })).digest("hex");
    expect(mezzCacheKey(BASE_KEY)).not.toBe(bumped);
  });
  it("does not change when key order changes", () => {
    const reordered = { codec: "h264" as const, encoder: "cpu" as const, has_audio: true, fps: 30, h: 2160, w: 3840, fit: "scale_pad" as const, out: 5, in: 0, source_checksum: "sha256:aaaa" };
    expect(mezzCacheKey(BASE_KEY)).toBe(mezzCacheKey(reordered));
  });
  it("changes when tail_seconds is present vs absent", () => {
    expect(mezzCacheKey(BASE_KEY)).not.toBe(mezzCacheKey({ ...BASE_KEY, tail_seconds: 0.4 }));
  });
});

describe("scaleFilter", () => {
  it("scale_pad ends in setsar=1 (pins SAR so concat/xfade never aborts on an anamorphic source)", () => {
    expect(scaleFilter("scale_pad", 3840, 2160)).toBe(
      "scale=3840:2160:force_original_aspect_ratio=decrease:flags=lanczos,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    );
  });
  it("scale_crop contains crop=3840:2160 and ends in setsar=1", () => {
    const f = scaleFilter("scale_crop", 3840, 2160);
    expect(f).toContain("crop=3840:2160");
    expect(f.endsWith(",setsar=1")).toBe(true);
  });
});

describe("mezzArgs", () => {
  const base = {
    ffmpeg: "ffmpeg",
    source: "/abs/source.mp4",
    in: 0,
    out: 5,
    fit: "scale_pad" as const,
    w: 3840,
    h: 2160,
    fps: 30,
    encoder: "cpu" as const,
    codec: "h264" as const,
    out_path: "/cache/mezz/abc.mp4",
  };

  it("has_audio: true chains aresample=48000 and has no anullsrc input", () => {
    const args = mezzArgs({ ...base, has_audio: true });
    const joined = args.join(" ");
    expect(joined).toContain("aresample=48000");
    expect(joined).not.toContain("anullsrc");
  });

  it("has_audio: false adds anullsrc input and a -t clamp", () => {
    const args = mezzArgs({ ...base, has_audio: false });
    const joined = args.join(" ");
    expect(joined).toContain("anullsrc=r=48000:cl=stereo");
    expect(args).toContain("-t");
    // -t appears twice: once for the anullsrc lavfi input duration, once at the end to clamp output duration.
    expect(args.filter((a) => a === "-t").length).toBe(2);
  });

  it("trims with -ss/-to before -i", () => {
    const args = mezzArgs({ ...base, has_audio: true });
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(ssIdx).toBeLessThan(iIdx);
  });
});
