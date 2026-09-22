import { describe, expect, it } from "vitest";
import { parseLoudnorm } from "../../../src/media/render/loudnorm.js";

/** Two real `loudnorm` print_format=json blocks as ffmpeg 8.1 emits them (measurement pass first, final
 * encode second): the parser must take the LAST one, because the render pass appends its own block to a
 * stderr buffer that may still carry the measurement one. */
const TWO_BLOCKS = `
ffmpeg version 8.1 Copyright (c) 2000-2025 the FFmpeg developers
[Parsed_loudnorm_6 @ 0000023bd4e0b2c0]
{
\t"input_i" : "-31.02",
\t"input_tp" : "-14.61",
\t"input_lra" : "9.70",
\t"input_thresh" : "-41.86",
\t"output_i" : "-23.15",
\t"output_tp" : "-6.72",
\t"output_lra" : "9.60",
\t"output_thresh" : "-33.40",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.11"
}
frame=  100 fps=0.0 q=-1.0 Lsize=    1234kB time=00:00:04.00 bitrate=2526.1kbits/s
[Parsed_loudnorm_6 @ 0000023bd4e0b400]
{
\t"input_i" : "-23.47",
\t"input_tp" : "-4.61",
\t"input_lra" : "6.70",
\t"input_thresh" : "-33.86",
\t"output_i" : "-14.03",
\t"output_tp" : "-1.49",
\t"output_lra" : "6.60",
\t"output_thresh" : "-24.40",
\t"normalization_type" : "linear",
\t"target_offset" : "0.03"
}
`;

const SILENT_BLOCK = `
[Parsed_loudnorm_2 @ 0000023bd4e0b2c0]
{
\t"input_i" : "-inf",
\t"input_tp" : "-inf",
\t"input_lra" : "0.00",
\t"input_thresh" : "-inf",
\t"output_i" : "-inf",
\t"output_tp" : "-inf",
\t"output_lra" : "0.00",
\t"output_thresh" : "-inf",
\t"normalization_type" : "linear",
\t"target_offset" : "0.00"
}
`;

describe("parseLoudnorm", () => {
  it("takes the LAST json block after [Parsed_loudnorm and reads measured + output values", () => {
    const parsed = parseLoudnorm(TWO_BLOCKS);
    expect(parsed).not.toBeNull();
    expect(parsed!.measured).toEqual({ input_i: -23.47, input_tp: -4.61, input_lra: 6.7, input_thresh: -33.86, target_offset: 0.03 });
    expect(parsed!.output).toEqual({ output_i: -14.03, output_tp: -1.49, output_lra: 6.6, normalization_type: "linear" });
  });

  // Task 11 (real 4K run): the second pass asks for `linear=true` but ffmpeg answers `dynamic` when the mix
  // crest factor is too large for the -14 LUFS / -1 dBTP pair. That single word is the only evidence of the
  // fallback anywhere, so the parser has to carry it out of the block.
  it("carries normalization_type out of the block so a linear -> dynamic fallback is visible", () => {
    expect(parseLoudnorm(TWO_BLOCKS.slice(0, TWO_BLOCKS.indexOf("frame=")))!.output.normalization_type).toBe("dynamic");
  });

  it("leaves normalization_type null when the block does not carry it (older/newer ffmpeg)", () => {
    const noType = SILENT_BLOCK.replace('\t"normalization_type" : "linear",\n', "");
    expect(parseLoudnorm(noType)!.output.normalization_type).toBeNull();
  });

  it('maps "-inf" (a fully silent mix) to -99 instead of -Infinity', () => {
    const parsed = parseLoudnorm(SILENT_BLOCK);
    expect(parsed).not.toBeNull();
    expect(parsed!.measured.input_i).toBe(-99);
    expect(parsed!.measured.input_tp).toBe(-99);
    expect(parsed!.measured.input_thresh).toBe(-99);
    expect(parsed!.output.output_i).toBe(-99);
    expect(parsed!.output.output_tp).toBe(-99);
    expect(parsed!.measured.input_lra).toBe(0);
  });

  it("returns null when stderr has no loudnorm json at all", () => {
    expect(parseLoudnorm("ffmpeg version 8.1\nframe=  100 fps=0.0\n")).toBeNull();
  });

  it("returns null when the loudnorm marker is there but the json is truncated", () => {
    expect(parseLoudnorm('[Parsed_loudnorm_1 @ 0x1]\n{\n\t"input_i" : "-23.47",\n')).toBeNull();
  });

  it("returns null when a required field is missing from the block", () => {
    expect(parseLoudnorm('[Parsed_loudnorm_1 @ 0x1]\n{\n\t"input_i" : "-23.47"\n}\n')).toBeNull();
  });
});
