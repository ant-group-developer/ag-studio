import { describe, expect, it } from "vitest";
import { CompositionSchema, newId, type Composition } from "@harness/contracts";
import { audioGraph, type AudioGraphInput, type LoudnormMeasured } from "../../../src/media/render/audio-graph.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function segment(order: number, start: number, end: number): Composition["segments"][number] {
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
    transition_out: { kind: "cut", seconds: 0.4, tail_available: false },
  };
}

function baseComposition(overrides: Partial<Composition> = {}): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 30, codec: "h264" },
    voice: "tts",
    language: "en",
    total_seconds: 10,
    request_id: newId("content_request"),
    brand: null,
    segments: [segment(0, 0, 5), segment(1, 5, 10)],
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

function musicFixture(overrides: Partial<NonNullable<Composition["music"]>> = {}): NonNullable<Composition["music"]> {
  return {
    track_id: "calm-01",
    path: "/kho/music/calm-01/track.mp3",
    loop: false,
    fade_in: 1,
    fade_out: 3,
    cues: [{ start: 0, end: 10, gain_db: -18 }],
    duck: { windows: [], gain_db: -12, attack_ms: 150, release_ms: 600 },
    ...overrides,
  };
}

function run(p: Partial<AudioGraphInput> & { composition: Composition }): { filter: string; out: string } {
  return audioGraph({
    mezzIndex: () => 0,
    narrationIndex: () => 0,
    musicIndex: null,
    loudnorm: null,
    ...p,
  });
}

describe("audioGraph", () => {
  it("voice: tts, 2 narration lines + music -> adelay, sidechaincompress (pinned), amix=inputs=2, music chain (pinned), voice padded to total_seconds", () => {
    const composition = baseComposition({
      voice: "tts",
      total_seconds: 15,
      narration: [
        { line_id: "L001", wav: "/abs/voice/L001.wav", start: 0.3, end: 2 },
        { line_id: "L002", wav: "/abs/voice/L002.wav", start: 6, end: 9 },
      ],
      music: musicFixture(),
    });
    const narrationIdx = new Map([["L001", 3], ["L002", 4]]);
    const { filter, out } = run({
      composition,
      narrationIndex: (line_id) => narrationIdx.get(line_id)!,
      musicIndex: 5,
    });
    expect(out).toBe("[aout]");
    expect(filter).toContain("adelay=300|300");
    expect(filter).toContain("amix=inputs=2");
    // `amix ... duration=longest` ends at the last narration line (9s), well short of total_seconds (15) --
    // without padding the music fade-out (anchored at total-fade_out) never plays and the episode tail goes
    // silent once the final amix clamps to `duration=first` (fix round 1, Critical 2).
    expect(filter).toContain("apad,atrim=0:15[voice]");
    expect(filter).toContain("[voice]asplit=2[voice_mix][voice_sc]");
    expect(filter).toContain("sidechaincompress=threshold=0.031:ratio=6:attack=150:release=600:makeup=1");
    expect(filter).toContain("[5:a]atrim=0:15,afade=t=in:d=1,afade=t=out:st=12:d=3,volume=-18dB[music]");
  });

  it("voice: original -> concat=n=3:v=0:a=1 with afade edges, voice padded to total_seconds", () => {
    const composition = baseComposition({
      voice: "original",
      segments: [segment(0, 0, 5), segment(1, 5, 10), segment(2, 10, 15)],
      total_seconds: 15,
    });
    const mezzIdx = new Map([[0, 0], [1, 1], [2, 2]]);
    const { filter } = run({ composition, mezzIndex: (order) => mezzIdx.get(order)! });
    expect(filter).toContain("concat=n=3:v=0:a=1");
    expect(filter).toContain("afade");
    expect(filter).toContain("apad,atrim=0:15[voice]");
  });

  it("voice: none, no music -> volume=-12dB, anull[mix], voice padded to total_seconds", () => {
    const composition = baseComposition({ voice: "none", total_seconds: 15 });
    const mezzIdx = new Map([[0, 0], [1, 1]]);
    const { filter } = run({ composition, mezzIndex: (order) => mezzIdx.get(order)! });
    expect(filter).toContain("apad,atrim=0:15[voice_padded]");
    expect(filter).toContain("[voice_padded]volume=-12dB[voice]");
    expect(filter).toContain("[voice]anull[mix]");
  });

  it("loudnorm measured -> exact loudnorm parameter list, linear=true", () => {
    const composition = baseComposition({ voice: "tts", narration: [] });
    const measured: LoudnormMeasured = { input_i: -23.1, input_tp: -3.2, input_lra: 7.4, input_thresh: -33.1, target_offset: 0.5 };
    const { filter } = run({ composition, loudnorm: measured });
    expect(filter).toContain(
      "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-23.1:measured_TP=-3.2:measured_LRA=7.4:measured_thresh=-33.1:offset=0.5:linear=true:print_format=json[aout]",
    );
  });

  it("voice: tts, 0 narration lines -> anullsrc", () => {
    const composition = baseComposition({ voice: "tts", narration: [] });
    const { filter } = run({ composition });
    expect(filter).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("music.loop: true -> aloop=loop=-1:size=2e9", () => {
    const composition = baseComposition({
      voice: "none",
      music: musicFixture({ loop: true }),
    });
    const mezzIdx = new Map([[0, 0], [1, 1]]);
    const { filter } = run({ composition, mezzIndex: (order) => mezzIdx.get(order)!, musicIndex: 5 });
    expect(filter).toContain("aloop=loop=-1:size=2e9,atrim=0:10");
  });
});
