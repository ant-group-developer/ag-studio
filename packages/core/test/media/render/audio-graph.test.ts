import { describe, expect, it } from "vitest";
import { CompositionSchema, newId, type Composition } from "@harness/contracts";
import { audioGraph, envelopeDbExpr, peakLimit, sourceDuckExprs, sourceDuckPoints, type AudioGraphInput, type LoudnormMeasured } from "../../../src/media/render/audio-graph.js";

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
      // A track that covers the whole 15 s episode, which is what `buildMusicPlan` writes whenever the track
      // is long enough or loops (`cues[0].end === total_seconds`). The fixture's default 10 s cue would now
      // be the `music_ends_early` case and would fade at 7 s, not 12 -- covered by its own test below.
      music: musicFixture({ cues: [{ start: 0, end: 15, gain_db: -18 }] }),
    });
    const narrationIdx = new Map([["L001", 3], ["L002", 4]]);
    const { filter, out } = run({
      composition,
      narrationIndex: (line_id) => narrationIdx.get(line_id)!,
      musicIndex: 5,
    });
    expect(out).toBe("[aout]");
    expect(filter).toContain("[3:a]afade=t=in:d=0.01,adelay=300|300[n_0]");
    expect(filter).toContain("amix=inputs=2");
    // `amix ... duration=longest` ends at the last narration line (9s), well short of total_seconds (15) --
    // without padding the music fade-out (anchored at total-fade_out) never plays and the episode tail goes
    // silent once the final amix clamps to `duration=first` (fix round 1, Critical 2).
    expect(filter).toContain("[voice_mixed]apad,atrim=0:15[narration]");
    // the footage's own sound plays at its level between lines and dips under each (it was dropped: a voice muted the videos)
    expect(filter).toContain(`[s_0][s_1]concat=n=2:v=0:a=1[voice_concat];[voice_concat]apad,atrim=0:15,asetpts=PTS-STARTPTS,volume=volume='pow(10,(${sourceDuckExprs(composition.narration)[0]})/20)':eval=frame[source_d]`);
    expect(filter).toContain("[narration]asplit=2[narration_mix][voice_key];[narration_mix][source_d]amix=inputs=2:normalize=0:duration=first[voice]");
    // the music ducks under the narration alone, not under the street sound
    expect(filter).toContain("[music][voice_key]sidechaincompress=threshold=0.031:ratio=6:attack=150:release=600:makeup=1[music_d];[voice][music_d]amix");
    expect(filter).toContain("[5:a]atrim=0:15,afade=t=in:d=1,afade=t=out:st=12:d=3,volume=-18dB[music]");
  });

  it("voice: tts over silent footage -> the narration alone, as before", () => {
    const silent = (o: number, s: number, e: number) => ({ ...segment(o, s, e), has_audio: false });
    const composition = baseComposition({
      voice: "tts", total_seconds: 15, segments: [silent(0, 0, 5), silent(1, 5, 10)],
      narration: [{ line_id: "L001", wav: "/abs/voice/L001.wav", start: 0.3, end: 2 }],
      music: musicFixture({ cues: [{ start: 0, end: 15, gain_db: -18 }] }),
    });
    const { filter } = run({ composition, narrationIndex: () => 3, musicIndex: 5 });
    expect(filter).toContain("[voice_mixed]apad,atrim=0:15[voice]");
    expect(filter).not.toContain("concat");
    expect(filter).toContain("[voice]asplit=2[voice_mix][voice_sc]");
  });

  it("voice: tts over the footage with no ducking music -> the unused key is sunk", () => {
    const composition = baseComposition({ voice: "tts", total_seconds: 10, narration: [{ line_id: "L001", wav: "/abs/voice/L001.wav", start: 0, end: 2 }] });
    expect(run({ composition, narrationIndex: () => 3 }).filter).toContain("[voice_key]anullsink;[voice]anull[mix]");
    const music = musicFixture({ cues: [{ start: 0, end: 10, gain_db: -18 }] });
    const off = run({ composition: { ...composition, music: { ...music, duck: { ...music.duck, enabled: false } } }, narrationIndex: () => 3, musicIndex: 5 }).filter;
    expect(off).toContain("[voice_key]anullsink;[voice][music]amix");
    expect(off).not.toContain("[music][voice_key]sidechaincompress");
  });

  it("duck.enabled: false -> the music is mixed at its own gain, no sidechaincompress", () => {
    const segments = [segment(0, 0, 5), segment(1, 5, 10)];
    const music = musicFixture({ cues: [{ start: 0, end: 10, gain_db: -30 }] });
    const off = run({ composition: baseComposition({ voice: "original", segments, music: { ...music, duck: { ...music.duck, enabled: false } } }), musicIndex: 2 });
    expect(off.filter).not.toContain("sidechaincompress");
    expect(off.filter).not.toContain("asplit");
    expect(off.filter).toContain("volume=-30dB[music]");
    expect(off.filter).toContain("[voice][music]amix=inputs=2:normalize=0:duration=first[mix]");
    // absent (every composition written before the key) still ducks
    const on = run({ composition: baseComposition({ voice: "original", segments, music }), musicIndex: 2 });
    expect(on.filter).toContain("sidechaincompress");
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
    // a segment whose source ran short is padded with silence to its length, so the next one does not slide early
    expect(filter).toMatch(/atrim=0:5,apad=whole_dur=5,afade=t=in:d=0.02/);
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

  it("peakLimit: a ceiling only when the linear gain would push the peak past -1 dBTP", () => {
    // -24 LUFS needs +10 dB: a -2 dBTP peak would land at +8, so it is held at -24 + 13 - 1 = -12 dBFS
    expect(peakLimit({ input_i: -24, input_tp: -2, input_lra: 9, input_thresh: -34, target_offset: 0.3 })).toBe(0.251);
    expect(peakLimit({ input_i: -24, input_tp: -13, input_lra: 9, input_thresh: -34, target_offset: 0.3 })).toBeNull();
    // never under alimiter's own floor
    expect(peakLimit({ input_i: -60, input_tp: -20, input_lra: 9, input_thresh: -70, target_offset: 0 })).toBe(0.063);
  });

  it("limit -> alimiter between the mix and loudnorm, on both passes", () => {
    const composition = baseComposition({ voice: "tts", narration: [] });
    const measured: LoudnormMeasured = { input_i: -24.5, input_tp: -11.9, input_lra: 9, input_thresh: -34.5, target_offset: 0.3 };
    expect(run({ composition, limit: 0.251 }).filter).toContain("[mix]alimiter=limit=0.251:attack=5:release=50:level=false[limited];[limited]loudnorm=I=-14:TP=-1:LRA=11:print_format=json[aout]");
    expect(run({ composition, limit: 0.251, loudnorm: measured }).filter).toContain("[limited]loudnorm=I=-14:TP=-1:LRA=11:measured_I=-24.5:measured_TP=-11.9:");
    expect(run({ composition, loudnorm: measured }).filter).not.toContain("alimiter");
  });

  it("feedback-vps §4.3: a segment's gain and its even-level correction add up in one volume on its own sound", () => {
    const composition = baseComposition({ voice: "original", segments: [{ ...segment(0, 0, 5), gain_db: 6 }, segment(1, 5, 10)] });
    const plain = run({ composition }).filter;
    expect(plain).toContain("apad=whole_dur=5,volume=6dB,afade=t=in");
    expect(plain.match(/volume=[-\d.]+dB,afade/g)).toHaveLength(1);
    const evened = run({ composition, evenGainDb: new Map([[0, -2.5], [1, 4]]) }).filter;
    expect(evened).toContain("apad=whole_dur=5,volume=3.5dB,afade");
    expect(evened).toContain("apad=whole_dur=5,volume=4dB,afade");
    // a tts episode keeps the footage's sound, at its own gain, under the bed's
    expect(run({ composition: { ...composition, voice: "tts" } }).filter).toContain("apad=whole_dur=5,volume=6dB,afade=t=in");
  });

  it("feedback-vps §4.3: a music volume line is a per-frame volume of t, linear between points", () => {
    expect(envelopeDbExpr([{ at: 4, gain_db: -10 }, { at: 0, gain_db: -30 }])).toBe("if(lt(t,0),-30,if(lt(t,4),-30+(20)*(t-0)/4,-10))");
    expect(envelopeDbExpr([{ at: 2, gain_db: -20 }])).toBe("if(lt(t,2),-20,-20)");
    const composition = baseComposition({ voice: "none", music: musicFixture({ envelope: [{ at: 0, gain_db: -30 }, { at: 4, gain_db: -10 }] }) });
    const { filter } = run({ composition, musicIndex: 2 });
    expect(filter).toContain("asetpts=PTS-STARTPTS,volume=volume='pow(10,(if(lt(t,0),-30,if(lt(t,4),-30+(20)*(t-0)/4,-10)))/20)':eval=frame[music]");
    expect(filter).not.toContain("volume=-18dB[music]");
  });

  it("voice: tts, 0 narration lines -> anullsrc", () => {
    const composition = baseComposition({ voice: "tts", narration: [] });
    const { filter } = run({ composition });
    expect(filter).toContain("anullsrc=r=48000:cl=stereo");
  });

  // Review fix wave, m2: a short non-looping track (`buildMusicPlan`'s `music_ends_early` case) must fade at
  // its OWN end, not at the episode's -- anchoring at `total_seconds - fade_out` would leave the track
  // cutting off hard at 6 s and the fade playing over silence from 7 s to 10 s.
  it("a short non-looping track fades out at cues[0].end, not at total_seconds", () => {
    const composition = baseComposition({
      voice: "none",
      music: musicFixture({ loop: false, cues: [{ start: 0, end: 6, gain_db: -18 }] }),
    });
    const mezzIdx = new Map([[0, 0], [1, 1]]);
    const { filter } = run({ composition, mezzIndex: (order) => mezzIdx.get(order)!, musicIndex: 5 });
    expect(filter).toContain("afade=t=out:st=3:d=3");
    expect(filter).not.toContain("afade=t=out:st=7:d=3");
  });

  it("a track that covers the whole episode still fades out at total_seconds - fade_out", () => {
    const composition = baseComposition({ voice: "none", music: musicFixture() });
    const mezzIdx = new Map([[0, 0], [1, 1]]);
    const { filter } = run({ composition, mezzIndex: (order) => mezzIdx.get(order)!, musicIndex: 5 });
    expect(filter).toContain("afade=t=out:st=7:d=3");
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

describe("sourceDuckPoints", () => {
  it("0 dB between lines, -12 dB under each from its first word, lines too close for a rise merged into one dip", () => {
    expect(sourceDuckPoints([])).toEqual([]);
    expect(sourceDuckPoints([{ start: 6, end: 9 }, { start: 0.3, end: 2 }, { start: 2.4, end: 3 }])).toEqual([
      { at: 0.25, gain_db: 0 }, { at: 0.3, gain_db: -12 }, { at: 3, gain_db: -12 }, { at: 3.5, gain_db: 0 },
      { at: 5.95, gain_db: 0 }, { at: 6, gain_db: -12 }, { at: 9, gain_db: -12 }, { at: 9.5, gain_db: 0 },
    ]);
    // the render's line: flat sums, a term per dip (nested ifs stop parsing near a hundred points)
    expect(sourceDuckExprs([])).toEqual([]);
    expect(sourceDuckExprs([{ start: 6, end: 9 }, { start: 0.3, end: 2 }, { start: 2.4, end: 3 }]))
      .toEqual(["-12*clip((t-0.25)/0.05,0,1)*clip((3.5-t)/0.5,0,1)+-12*clip((t-5.95)/0.05,0,1)*clip((9.5-t)/0.5,0,1)"]);
    // ffmpeg fails on a sum of 100 dips: 40 per volume filter
    const many = sourceDuckExprs(Array.from({ length: 150 }, (_, k) => ({ start: 1 + 4 * k, end: 3 + 4 * k })));
    expect(many.map((e) => e.split("+-12*").length)).toEqual([40, 40, 40, 30]);
  });
});
