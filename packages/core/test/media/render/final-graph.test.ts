import { describe, expect, it } from "vitest";
import { CompositionSchema, isHarnessError, newId, type Composition } from "@harness/contracts";
import { escapeFilterPath, finalArgs, finalConcatArgs, finalConcatList, finalSliceArgs, finalSlices, type FinalGraphInput } from "../../../src/media/render/final-graph.js";
import { videoEncoderArgs } from "../../../src/media/render/encoder.js";

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
    // every body (and tail) is held to its segment's own length before anything adds the lengths up
    expect(joined).toContain("[0:v]tpad=stop_mode=clone:stop_duration=5,trim=duration=5,setpts=PTS-STARTPTS[v0b]");
    expect(joined).toContain("[1:v]tpad=stop_mode=clone:stop_duration=0.4,trim=duration=0.4,setpts=PTS-STARTPTS[v0t]");
    expect(joined).toContain("[v0b][v0t]concat=n=2:v=1:a=0[v0c]");
    expect(joined).toContain("[2:v]tpad=stop_mode=clone:stop_duration=5,trim=duration=5,setpts=PTS-STARTPTS[v1b]");
    // both xfade inputs end in `fps`: ffmpeg 7.1 drops the frame rate through concat/setpts and xfade then
    // refuses to configure (exit 234)
    expect(joined).toMatch(/settb=AVTB,setpts=PTS-STARTPTS,fps=30\[xt1l\]/);
    expect(joined).toMatch(/settb=AVTB,setpts=PTS-STARTPTS,fps=30\[xt1r\]/);
    expect(joined).toContain("concat=n=2:v=1:a=0");
    // dip_black at 1-2, s=0.4, segment 1 is 5s long: outgoing fade starts at len-s/2 = 4.8, lasts s/2 = 0.2;
    // incoming fade on segment 2 starts at 0, also lasts 0.2.
    expect(joined).toContain("fade=t=out:st=4.8:d=0.2");
    expect(joined).toContain("fade=t=in:st=0:d=0.2");
  });

  it("encodes the video as the final tier by default and lighter for a preview, the audio alike", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const encoderPart = (argv: string[]) => argv.slice(argv.indexOf("-c:v"), argv.indexOf("-c:a"));
    const final = finalArgs(baseInput({ composition, mezz })).argv;
    expect(encoderPart(final)).toEqual(videoEncoderArgs({ choice: "cpu", codec: "h264", tier: "final", fps: 30 }));
    expect(encoderPart(finalArgs(baseInput({ composition, mezz, tier: "final" })).argv)).toEqual(encoderPart(final));
    const preview = finalArgs(baseInput({ composition, mezz, tier: "preview" })).argv;
    expect(encoderPart(preview)).toEqual(videoEncoderArgs({ choice: "cpu", codec: "h264", tier: "preview", fps: 30 }));
    expect(preview.slice(preview.indexOf("-c:a"))).toEqual(final.slice(final.indexOf("-c:a")));
    expect(preview.slice(0, preview.indexOf("-c:v"))).toEqual(final.slice(0, final.indexOf("-c:v")));
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

  it("ass path with an apostrophe: single quotes inside the ffmpeg-quoted filename are closed/re-opened with a full escaped-backslash + escaped-quote pair, not a bare backslash-quote (fix round 2 -- verified against real ffmpeg 8.1)", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: null },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz, assPath: "E:\\x\\it's\\overlay.ass" }));
    const joined = argv.join(" ");
    expect(joined).toContain("ass=filename='E\\:/x/it'\\\\\\''s/overlay.ass'");
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

  it("apostrophe inside the path: close-quote, escaped-backslash, escaped-quote, reopen-quote -- verified against real ffmpeg 8.1 (fix round 2)", () => {
    // ffmpeg parses this in two passes: pass 1 (the filtergraph tokenizer) copies quoted text literally and
    // only unescapes `\X` OUTSIDE quotes; pass 2 (the filter's own key=value split) runs on that already-
    // unquoted text and has no quote markers left, so a bare `'` there (the 4-char `'\''` trick from fix
    // round 1) re-opens a quote as far as pass 2 is concerned and swallows the rest of the filter
    // (`:fontsdir=...`). The working 6-char sequence `'\\\''` survives both passes intact.
    expect(escapeFilterPath("E:\\x\\it's\\overlay.ass")).toBe("E\\:/x/it'\\\\\\''s/overlay.ass");
  });
});

describe("finalSlices", () => {
  const cut = { kind: "cut", seconds: 0.4, tail_available: false } as const;
  const dissolve = { kind: "dissolve", seconds: 0.5, tail_available: true } as const;
  const dip = { kind: "dip_black", seconds: 1, tail_available: false } as const;
  const episode = (kinds: Composition["segments"][number]["transition_out"][], len = 60) =>
    baseComposition({ total_seconds: kinds.length * len, segments: kinds.map((k, i) => segment(i, i * len, (i + 1) * len, k)) });

  it("one slice when every input fits in one, when there is no cap, or when the episode is too short to split", () => {
    expect(finalSlices(episode([cut, cut, cut, cut, cut, cut]), 6)).toEqual([{ orders: [0, 1, 2, 3, 4, 5], start: 0, seconds: 360, dipIn: 0 }]);
    expect(finalSlices(episode([cut, cut, cut, cut, cut, cut]), 0)).toHaveLength(1);
    expect(finalSlices(episode([cut, cut, cut], 10), 1)).toHaveLength(1);
  });

  it("ends a slice once it holds maxInputs pictures, each slice starting where the ones before it end", () => {
    const slices = finalSlices(episode([cut, cut, cut, cut, cut, cut]), 2);
    expect(slices.map((s) => s.orders)).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(slices.map((s) => [s.start, s.seconds])).toEqual([[0, 120], [120, 120], [240, 120]]);
  });

  it("counts a dissolve's tail as an input, and never splits a dissolve: its tail plays over the next segment", () => {
    const c = episode([cut, dissolve, cut, dissolve, cut, cut]);
    const slices = finalSlices(c, 3);
    expect(slices.map((s) => s.orders)).toEqual([[0, 1, 2], [3, 4], [5]]);
    for (const s of slices.slice(0, -1)) expect(c.segments[s.orders[s.orders.length - 1]!]!.transition_out.kind).toBe("cut");
  });

  it("all dissolves: nowhere to split, one slice", () => {
    expect(finalSlices(episode([dissolve, dissolve, dissolve, cut]), 1)).toHaveLength(1);
  });

  it("a split at a dip_black: the next slice fades in from black over the second half", () => {
    const slices = finalSlices(episode([cut, dip, cut, cut]), 2);
    expect(slices.map((s) => [s.orders, s.dipIn])).toEqual([[[0, 1], 0], [[2, 3], 1]]);
  });

  it("no slice shorter than minSeconds: a short one runs on, and the last one takes what is left", () => {
    expect(finalSlices(episode([cut, cut, cut, cut, cut], 20), 1).map((s) => s.orders)).toEqual([[0, 1], [2, 3, 4]]);
  });

  it("start is the sum of the segment lengths before it, the time the picture shows there", () => {
    const c = baseComposition({ total_seconds: 100, segments: [segment(0, 0, 33.3), segment(1, 33.3, 66.7), segment(2, 66.7, 100)] });
    expect(finalSlices(c, 1, 10).map((s) => s.start)).toEqual([0, 33.3, 66.7]);
  });
});

describe("finalArgs streams", () => {
  const withEverything = () =>
    baseComposition({
      voice: "tts",
      total_seconds: 15,
      segments: [segment(0, 0, 5, { kind: "dissolve", seconds: 0.4, tail_available: true }), segment(1, 5, 15)],
      narration: [{ line_id: "L001", wav: "/abs/voice/L001.wav", start: 0, end: 15 }],
      music: {
        track_id: "calm-01", path: "/kho/music/calm-01/track.mp3", loop: false, fade_in: 1, fade_out: 3,
        cues: [{ start: 0, end: 15, gain_db: -18 }], duck: { windows: [], gain_db: -12, attack_ms: 150, release_ms: 600 },
      },
      logo: { path: "/kho/brands/ch1/logo.png", corner: "right", opacity: 0.8, height_px: 140 },
    });
  const mezz = [
    { order: 0, body: "/cache/mezz/b0.mp4", tail: "/cache/mezz/b0-tail.mp4" },
    { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
  ];

  it('"video": the picture only, from bodies, tails and the logo; no sound, no audio graph', () => {
    const { argv, inputs } = finalArgs(baseInput({ composition: withEverything(), mezz, streams: "video", out_path: "/tmp/slice-0.mp4" }));
    expect(inputs.map((i) => i.kind)).toEqual(["body", "tail", "body", "logo"]);
    const joined = argv.join(" ");
    expect(joined).not.toContain("loudnorm");
    expect(joined).toContain("-map [vout]");
    expect(argv).toContain("-an");
    expect(argv).not.toContain("-c:a");
    expect(argv.slice(argv.indexOf("-c:v"), argv.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
    expect(argv[argv.length - 1]).toBe("/tmp/slice-0.mp4");
  });

  it('"audio": the sound only, from bodies, narration and music, encoded as the one-pass render encodes it', () => {
    const both = finalArgs(baseInput({ composition: withEverything(), mezz })).argv;
    const { argv, inputs } = finalArgs(baseInput({ composition: withEverything(), mezz, streams: "audio", out_path: "/tmp/sound.m4a" }));
    expect(inputs.map((i) => i.kind)).toEqual(["body", "body", "narration", "music"]);
    expect(argv).toContain("-vn");
    expect(argv).not.toContain("-c:v");
    expect(argv.join(" ")).toContain("loudnorm=I=-14");
    expect(argv.slice(argv.indexOf("-c:a"), -1)).toEqual(both.slice(both.indexOf("-c:a"), both.indexOf("-movflags")));
    expect(argv[argv.length - 1]).toBe("/tmp/sound.m4a");
  });

  it("a slice's subtitles run on the episode's clock: shifted by its start before ass, back to 0 after", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const m = [{ order: 0, body: "/b0.mp4", tail: null }, { order: 1, body: "/b1.mp4", tail: null }];
    const joined = finalArgs(baseInput({ composition, mezz: m, streams: "video", assPath: "/x/o.ass", sliceStart: 120.5 })).argv.join(" ");
    expect(joined).toContain("setpts=PTS+120.5/TB,ass=filename='/x/o.ass',setpts=PTS-STARTPTS[vass]");
  });

  it("dipInSeconds fades the first segment in from black", () => {
    const composition = baseComposition({ segments: [segment(0, 0, 5), segment(1, 5, 10)] });
    const m = [{ order: 0, body: "/b0.mp4", tail: null }, { order: 1, body: "/b1.mp4", tail: null }];
    const joined = finalArgs(baseInput({ composition, mezz: m, streams: "video", dipInSeconds: 1 })).argv.join(" ");
    expect(joined).toContain("[v0b]fade=t=in:st=0:d=0.5[v0fi]");
  });
});

describe("finalArgs decodeThreads", () => {
  it("caps the decoder threads of every mezzanine input, and of nothing else", () => {
    const composition = baseComposition({
      segments: [segment(0, 0, 5, { kind: "dissolve", seconds: 0.4, tail_available: true }), segment(1, 5, 10)],
      logo: { path: "/kho/brands/ch1/logo.png", corner: "right", opacity: 0.8, height_px: 140 },
    });
    const mezz = [
      { order: 0, body: "/cache/mezz/b0.mp4", tail: "/cache/mezz/b0-tail.mp4" },
      { order: 1, body: "/cache/mezz/b1.mp4", tail: null },
    ];
    const { argv } = finalArgs(baseInput({ composition, mezz, decodeThreads: 8 }));
    const before = (path: string) => argv.slice(argv.indexOf(path) - 3, argv.indexOf(path) - 1);
    for (const m of ["/cache/mezz/b0.mp4", "/cache/mezz/b0-tail.mp4", "/cache/mezz/b1.mp4"]) expect(before(m)).toEqual(["-threads", "8"]);
    expect(before("/kho/brands/ch1/logo.png")).not.toEqual(["-threads", "8"]);
    expect(finalArgs(baseInput({ composition, mezz })).argv).not.toContain("-threads");
  });
});

describe("finalSliceArgs, finalConcatArgs", () => {
  it("a slice renders its own segments rebased to 0, with the slice's start and dip carried over", () => {
    const composition = baseComposition({
      total_seconds: 180,
      segments: [segment(0, 0, 60), segment(1, 60, 120, { kind: "dip_black", seconds: 1, tail_available: false }), segment(2, 120, 180)],
    });
    const mezz = [0, 1, 2].map((order) => ({ order, body: `/b${order}.mp4`, tail: null }));
    const slices = finalSlices(composition, 1, 30);
    expect(slices).toHaveLength(3);
    const { argv, inputs } = finalSliceArgs(baseInput({ composition, mezz, assPath: "/o.ass" }), slices[2]!, "/tmp/slice-2.mp4");
    expect(inputs.map((i) => i.path)).toEqual(["/b2.mp4"]);
    const joined = argv.join(" ");
    expect(joined).toContain("[0:v]tpad=stop_mode=clone:stop_duration=60,trim=duration=60,setpts=PTS-STARTPTS[v0b]");
    expect(joined).toContain("fade=t=in:st=0:d=0.5");
    expect(joined).toContain("setpts=PTS+120/TB,ass=");
    expect(argv).toContain("-an");
    expect(argv[argv.length - 1]).toBe("/tmp/slice-2.mp4");
  });

  it("the slices are joined by stream copy, with the sound muxed in and the file made streamable", () => {
    expect(finalConcatArgs({ ffmpeg: "ffmpeg", list: "slices.txt", audio: "sound.m4a", codec: "h264", out_path: "/out/e.mp4" })).toEqual([
      "ffmpeg", "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", "slices.txt", "-i", "sound.m4a",
      "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", "/out/e.mp4",
    ]);
    expect(finalConcatArgs({ ffmpeg: "ffmpeg", list: "l.txt", audio: "s.m4a", codec: "hevc", out_path: "e.mp4" })).toContain("hvc1");
    expect(finalConcatList(["slice-0.mp4", "it's.mp4"])).toBe("file 'slice-0.mp4'\nfile 'it'\\''s.mp4'\n");
  });
});
