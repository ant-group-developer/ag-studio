import { describe, expect, it } from "vitest";
import { resolveEncoder, videoEncoderArgs, type EncoderChoice } from "../../../src/media/render/encoder.js";

describe("videoEncoderArgs", () => {
  const CHOICES: EncoderChoice[] = ["nvenc", "cpu"];
  const CODECS: ("h264" | "hevc")[] = ["h264", "hevc"];
  const TIERS: ("mezz" | "final")[] = ["mezz", "final"];

  for (const choice of CHOICES) {
    for (const codec of CODECS) {
      for (const tier of TIERS) {
        it(`${choice} ${codec} ${tier}`, () => {
          const args = videoEncoderArgs({ choice, codec, tier, fps: 30 });
          expect(args).toContain("-pix_fmt");
          expect(args).toContain("yuv420p");
          expect(args).toContain("-r");
          expect(args).toContain("30");
          expect(args).toContain("-g");
          expect(args).toContain(String(tier === "mezz" ? 30 : 60));

          if (choice === "nvenc") {
            expect(args).toContain(codec === "hevc" ? "hevc_nvenc" : "h264_nvenc");
            if (tier === "mezz") {
              expect(args).toEqual(["-c:v", codec === "hevc" ? "hevc_nvenc" : "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "18", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", "30", "-g", "30"]);
            } else {
              const profile = codec === "hevc" ? "main" : "high";
              const base = ["-c:v", codec === "hevc" ? "hevc_nvenc" : "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-maxrate", "60M", "-bufsize", "120M", "-profile:v", profile];
              const tag = codec === "hevc" ? ["-tag:v", "hvc1"] : [];
              expect(args).toEqual([...base, ...tag, "-pix_fmt", "yuv420p", "-r", "30", "-g", "60"]);
            }
          } else {
            expect(args).toContain(codec === "hevc" ? "libx265" : "libx264");
            if (tier === "mezz") {
              expect(args).toEqual(["-c:v", codec === "hevc" ? "libx265" : "libx264", "-preset", "veryfast", "-crf", codec === "hevc" ? "18" : "16", "-pix_fmt", "yuv420p", "-r", "30", "-g", "30"]);
            } else {
              const profile = codec === "hevc" ? [] : ["-profile:v", "high"];
              expect(args).toEqual(["-c:v", codec === "hevc" ? "libx265" : "libx264", "-preset", "slow", "-crf", codec === "hevc" ? "20" : "18", ...profile, "-pix_fmt", "yuv420p", "-r", "30", "-g", "60"]);
            }
          }
        });
      }
    }
  }
});

describe("resolveEncoder", () => {
  it("auto picks nvenc when available", () => {
    expect(resolveEncoder("auto", true)).toBe("nvenc");
  });
  it("auto falls back to cpu when unavailable", () => {
    expect(resolveEncoder("auto", false)).toBe("cpu");
  });
  it("nvenc requested but unavailable falls back to cpu", () => {
    expect(resolveEncoder("nvenc", false)).toBe("cpu");
  });
  it("nvenc requested and available stays nvenc", () => {
    expect(resolveEncoder("nvenc", true)).toBe("nvenc");
  });
  it("cpu always stays cpu", () => {
    expect(resolveEncoder("cpu", true)).toBe("cpu");
    expect(resolveEncoder("cpu", false)).toBe("cpu");
  });
});
