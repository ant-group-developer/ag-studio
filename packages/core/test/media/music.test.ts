import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BrandProfile, MusicTrack, Timeline } from "@harness/contracts";
import { buildMusicPlan, duckWindows, selectTrack } from "../../src/media/music.js";

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function brandFixture(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: "harness.brand/v1",
    channel_id: "ch1",
    revision: 1,
    fonts: { regular: "brands/ch1/fonts/Inter-Regular.ttf", bold: "brands/ch1/fonts/Inter-Bold.ttf", origin: "own", origin_note: "in-house" },
    colors: { primary: "#112233", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
    safe_margin_px: 120,
    text: {
      title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
      callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
      lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
    },
    subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
    transition: { kind: "cut", seconds: 0.4 },
    source_fit: "scale_pad",
    music: { tracks: [], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
    checksums: {},
    ...overrides,
  };
}

function trackFixture(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1",
    track_id: "track-a",
    display_name: "Track A",
    file: "music/track-a/track.mp3",
    mood: ["calm"],
    duration_seconds: 120,
    loop_ok: false,
    origin: "own",
    origin_note: "in-house",
    checksum: `sha256:${"a".repeat(64)}`,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function hashIndex(request_id: string, n: number): number {
  return createHash("sha256").update(request_id).digest().readUInt32BE(0) % n;
}

describe("selectTrack", () => {
  const calm = trackFixture({ track_id: "calm-01", mood: ["calm", "quiet"] });
  const upbeat = trackFixture({ track_id: "upbeat-01", mood: ["upbeat"] });
  const neutral = trackFixture({ track_id: "neutral-01", mood: ["neutral"] });
  const tracks = [calm, upbeat, neutral];

  it("filters to tracks whose mood matches (case-insensitive) and picks one by hash(request_id)", () => {
    const { track, warnings } = selectTrack({ tracks, mood: "CALM", request_id: "req_1" });
    expect(track?.track_id).toBe("calm-01");
    expect(warnings).toEqual([]);
  });

  it("keeps the full candidate set and warns when the mood matches nothing", () => {
    const { track, warnings } = selectTrack({ tracks, mood: "epic", request_id: "req_1" });
    expect(track).not.toBeNull();
    expect(warnings).toEqual(["music_mood_unmatched:epic"]);
    const expectedIndex = hashIndex("req_1", tracks.length);
    expect(track).toBe(tracks[expectedIndex]);
  });

  it("picks the same track for the same request_id (stable) across calls", () => {
    const a = selectTrack({ tracks, mood: undefined, request_id: "req_stable" });
    const b = selectTrack({ tracks, mood: undefined, request_id: "req_stable" });
    expect(a.track?.track_id).toBe(b.track?.track_id);
  });

  it("can pick a different track for a different request_id", () => {
    // Two request ids whose hash % 3 differ -- picked by brute search over literal ids to keep the test
    // independent of any particular hash implementation detail beyond "deterministic function of request_id".
    let idA = "";
    let idB = "";
    for (let i = 0; i < 50 && (!idA || !idB); i++) {
      const id = `req_${i}`;
      const idx = hashIndex(id, tracks.length);
      if (!idA) idA = id;
      else if (idx !== hashIndex(idA, tracks.length) && !idB) idB = id;
    }
    const a = selectTrack({ tracks, mood: undefined, request_id: idA });
    const b = selectTrack({ tracks, mood: undefined, request_id: idB });
    expect(a.track?.track_id).not.toBe(b.track?.track_id);
  });

  it("returns no_candidates when the candidate list is empty", () => {
    const { track, reason, warnings } = selectTrack({ tracks: [], mood: "calm", request_id: "req_1" });
    expect(track).toBeNull();
    expect(reason).toBe("no_candidates");
    expect(warnings).toEqual([]);
  });
});

describe("buildMusicPlan", () => {
  const timeline: Timeline = { schema_version: "harness.timeline/v1", voice: "none", language: "en", total_seconds: 30, video: [], narration: [], speech: [] };

  it("loops a track shorter than the episode when loop_ok is true", () => {
    const track = trackFixture({ duration_seconds: 10, loop_ok: true });
    const { music, warnings } = buildMusicPlan({ track, path: "music/track-a/track.mp3", brand: brandFixture(), timeline });
    expect(music.loop).toBe(true);
    expect(music.cues).toEqual([{ start: 0, end: 30, gain_db: -18 }]);
    expect(warnings).toEqual([]);
  });

  it("plays once and warns music_ends_early for a shorter track with loop_ok false", () => {
    const track = trackFixture({ duration_seconds: 10, loop_ok: false });
    const { music, warnings } = buildMusicPlan({ track, path: "music/track-a/track.mp3", brand: brandFixture(), timeline });
    expect(music.loop).toBe(false);
    expect(music.cues).toEqual([{ start: 0, end: 10, gain_db: -18 }]);
    expect(warnings).toEqual(["music_ends_early"]);
  });

  it("plays once without warning when the track already covers the whole episode", () => {
    const track = trackFixture({ duration_seconds: 40, loop_ok: false });
    const { music, warnings } = buildMusicPlan({ track, path: "music/track-a/track.mp3", brand: brandFixture(), timeline });
    expect(music.loop).toBe(false);
    expect(music.cues).toEqual([{ start: 0, end: 30, gain_db: -18 }]);
    expect(warnings).toEqual([]);
  });

  it("sets fade_in/fade_out and duck settings from the brand", () => {
    const track = trackFixture({ duration_seconds: 40 });
    const brand = brandFixture({ music: { tracks: [], gain_db: -20, duck_db: -10, duck_attack_ms: 100, duck_release_ms: 500 } });
    const { music } = buildMusicPlan({ track, path: "p", brand, timeline });
    expect(music.fade_in).toBe(1);
    expect(music.fade_out).toBe(3);
    expect(music.duck).toEqual({ windows: [], gain_db: -10, attack_ms: 100, release_ms: 500 });
  });
});

describe("duckWindows", () => {
  it("returns no windows for voice: none", () => {
    const timeline: Timeline = { schema_version: "harness.timeline/v1", voice: "none", language: "en", total_seconds: 10, video: [], narration: [], speech: [] };
    expect(duckWindows(timeline)).toEqual([]);
  });

  it("merges two narration lines separated by less than 0.5s into one window", () => {
    const timeline: Timeline = {
      schema_version: "harness.timeline/v1",
      voice: "tts",
      language: "en",
      total_seconds: 10,
      video: [],
      narration: [
        { line_id: "L001", wav: "L001.wav", start: 0, end: 2, words: [] },
        { line_id: "L002", wav: "L002.wav", start: 2.3, end: 4, words: [] }, // gap 0.3s < 0.5s
      ],
      speech: [],
    };
    expect(duckWindows(timeline)).toEqual([{ start: 0, end: 4 }]);
  });

  it("keeps two speech windows separate when the gap is at least 0.5s", () => {
    const timeline: Timeline = {
      schema_version: "harness.timeline/v1",
      voice: "original",
      language: "en",
      total_seconds: 10,
      video: [],
      narration: [],
      speech: [
        { source_id: SRC_A, start: 0, end: 2, text: "a", words: [] },
        { source_id: SRC_A, start: 3, end: 4, text: "b", words: [] }, // gap 1s
      ],
    };
    expect(duckWindows(timeline)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
  });
});
