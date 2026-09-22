import { describe, expect, it } from "vitest";
import { CompositionSchema, isHarnessError, newId, type Composition } from "@harness/contracts";
import { escapeFilterPath, finalArgs, type FinalGraphInput } from "../../../src/media/render/final-graph.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function segment(
  order: number,
  start: number,
  end: number,
  transition_out: Composition["segments"][number]["transition_out"] = { kind: "cut", seconds: 0.4, tail_available: false },
): Composition["segments"][number] {
  return {
    order,
    source_id: SRC_A,
    source_path: "/abs/source-a.mp4",
    in: start,
    out: end,
    start,
    end,
    fit: "scale_pad",
    has_audio: true,
    transition_out,
  };
}

function baseComposition(overrides: Partial<Composition> = {}): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 30, codec: "h264" },
    voice: "none",
    language: "en",
    total_seconds: 15,
    request_id: newId("content_request"),
    brand: null,
    segments: [segment(0, 0, 5), segment(1, 5, 10), segment(2, 10, 15)],
    text_events: [],
    captions: { mode: "none", cues: [] },
    music: null,
    logo: null,
    narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
    ...overrides,
  });
}

function baseInput(overrides: Partial<FinalGraphInput> & { composition: Composition; mezz: FinalGraphInput["mezz"] }): FinalGraphInput {
  return {
    ffmpeg: "ffmpeg",
    assPath: null,
    fontsDir: null,
    encoder: "cpu",
    loudnorm: null,
    out_path: "/out/full-episode.mp4",
    measureOnly: false,
    ...overrides,
  };
}

describe("finalArgs", () => {
  it("dissolve 0-1 then dip_black 1-2: xfade offset, body+tail concat, and both dip_black fades", () => {
    const composition = baseComposition({
      segments: [
        segment(0, 0, 5, { kind: "dissolve", seconds: 0.4, tail_available: true }),
        segment(1, 5, 10, { kind: "dip_black", seconds: 0.4, tail_available: false }),
        segment(2, 10, 15, { kind: "cut", seconds: 0.4, tail_available: false }),
      ],
    });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: "/cache/mezz/b0-tail.mp4" },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
      { order: 2, body: "/cache/mezz/b2.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz }));
    const joined = argv.join(" ");
    expect(joined).toContain("xfade=transition=fade:duration=0.4:offset=5");
    expect(joined).toContain("concat=n=2:v=1:a=0");
    // dip_black at 1-2, s=0.4, segment 1 is 5s long: outgoing fade starts at len-s/2 = 4.8, lasts s/2 = 0.2;
    // incoming fade on segment 2 starts at 0, also lasts 0.2.
    expect(joined).toContain("fade=t=out:st=4.8:d=0.2");
    expect(joined).toContain("fade=t=in:st=0:d=0.2");
  });

  it("ass + Windows fontsDir escapes the way escapeFilterPath does", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz, assPath: "E:\\x\\overlay.ass", fontsDir: "E:\\x\\fonts" }));
    const joined = argv.join(" ");
    expect(joined).toContain("ass=filename='E\\:/x/overlay.ass':fontsdir='E\\:/x/fonts'");
  });

  it("ass path with an apostrophe: single quotes inside the ffmpeg-quoted filename are closed/re-opened, not backslash-escaped", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz, assPath: "E:\\x\\it's\\overlay.ass" }));
    const joined = argv.join(" ");
    expect(joined).toContain("ass=filename='E\\:/x/it'\\''s/overlay.ass'");
  });

  it("empty segments[] throws CONFIG_INVALID instead of emitting [undefined]", () => {
    const composition = baseComposition({ segments: [] });
    try {
      finalArgs(baseInput({ composition, mezz: [] }));
      expect.fail("expected finalArgs to throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("logo present adds an overlay= filter", () => {
    const composition = baseComposition({
      segments: [segment(0, 0, 5), segment(1, 5, 10)],
      logo: { path: "/kho/brands/ch1/logo.png", corner: "right", opacity: 0.8, height_px: 140 },
    });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv, inputs } = finalArgs(baseInput({ composition, mezz }));
    expect(argv.join(" ")).toContain("overlay=");
    expect(inputs.find((i) => i.kind === "logo")?.path).toBe("/kho/brands/ch1/logo.png");
  });

  it("measureOnly: no [vout] map, has -f null -, no video encoder args", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz, measureOnly: true }));
    expect(argv).not.toContain("[vout]");
    expect(argv.join(" ")).not.toContain("-map [vout]");
    const tail = argv.slice(-3);
    expect(tail).toEqual(["-f", "null", "-"]);
    expect(argv).not.toContain("-c:v");
    expect(argv).toContain("-vn");
  });

  it("inputs are indexed in order: body, tail, narration, music, logo", () => {
    const composition = baseComposition({
      voice: "tts",
      segments: [segment(0, 0, 5, { kind: "dissolve", seconds: 0.4, tail_available: true }), segment(1, 5, 15)],
      total_seconds: 15,
      narration: [{ line_id: "L001", wav: "/abs/voice/L001.wav", start: 0, end: 15 }],
      music: {
        track_id: "calm-01",
        path: "/kho/music/calm-01/track.mp3",
        loop: false,
        fade_in: 1,
        fade_out: 3,
        cues: [{ start: 0, end: 15, gain_db: -18 }],
        duck: { windows: [], gain_db: -12, attack_ms: 150, release_ms: 600 },
      },
      logo: { path: "/kho/brands/ch1/logo.png", corner: "right", opacity: 0.8, height_px: 140 },
    });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: "/cache/mezz/b0-tail.mp4" },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { inputs } = finalArgs(baseInput({ composition, mezz }));
    expect(inputs.map((i) => [i.kind, i.index])).toEqual([
      ["body", 0],
      ["tail", 1],
      ["body", 2],
      ["narration", 3],
      ["music", 4],
      ["logo", 5],
    ]);
  });
});

describe("escapeFilterPath", () => {
  it("Windows path: backslashes become slashes, colon escaped", () => {
    expect(escapeFilterPath("E:\\x\\overlay.ass")).toBe("E\\:/x/overlay.ass");
  });

  it("apostrophe inside the path: close-quote/backslash-quote/reopen-quote, not a backslash escape", () => {
    // Inside ffmpeg's filtergraph single-quoted strings, `\` is not an escape character -- `\'` would close
    // the quote early and turn the rest of the path into unparsed filter syntax (fix round 1, Important 3).
    expect(escapeFilterPath("E:\\x\\it's\\overlay.ass")).toBe("E\\:/x/it'\\''s/overlay.ass");
  });
});
