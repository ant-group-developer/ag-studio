import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, type MediaProbe, type MediaProber } from "@harness/contracts";
import { activeTracks, addMusicTrack, LibraryFs, retireMusicTrack } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { hasFfmpeg, makeWav } from "../../../../tests/media.js";

function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

/** Minimal MediaProber that shells ffprobe directly -- core must not import the ffprobe adapter (see
 * `watch.test.ts`'s `RealDurationProber`), so the test constructs its own tiny one instead. */
class RealAudioProber implements MediaProber {
  async probe(path: string): Promise<MediaProbe | null> {
    const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" });
    if (r.status !== 0) return null;
    let parsed: { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string; channels?: number; sample_rate?: string }[] };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return null;
    }
    const duration = Number(parsed.format?.duration);
    const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
    return {
      media: null,
      duration_seconds: Number.isFinite(duration) ? duration : null,
      mime_type: null,
      container: null,
      video: null,
      audio: audioStream ? { codec: audioStream.codec_name, channels: audioStream.channels ?? 1, sample_rate: Number(audioStream.sample_rate ?? 0) } : null,
    };
  }
}

/** Always reports "no audio stream" regardless of the file -- used for the reject-non-audio-file test without
 * needing to actually produce a silent video file. */
class NoAudioProber implements MediaProber {
  async probe(): Promise<MediaProbe | null> {
    return { media: null, duration_seconds: 10, mime_type: null, container: null, video: null, audio: null };
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function world() {
  const root = tempRoot("library-music-kho-");
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, clock } = openTempStore();
  return { root, fs, store, clock, d: { fs, store, clock, prober: new RealAudioProber() } };
}

function makeClip(seconds: number, ext = "wav"): string {
  const dir = tempRoot("library-music-src-");
  const path = join(dir, `track.src.${ext}`);
  makeWav(path, seconds);
  return path;
}

describe.skipIf(!hasFfmpeg())("addMusicTrack", () => {
  it("adds a track from a wav sine, duration ~8s, checksum matches, mirrored in the store", async () => {
    const { d, fs } = world();
    const clip = makeClip(8);

    const track = await addMusicTrack(d, {
      track_id: "calm-01", display_name: "Calm piano 01", file_path: clip,
      mood: ["calm", "neutral"], origin: "royalty_free", origin_note: "Pixabay licence, 2026-09-20",
    });

    expect(track.track_id).toBe("calm-01");
    expect(track.duration_seconds).toBeGreaterThan(7);
    expect(track.duration_seconds).toBeLessThan(9);
    expect(track.file).toBe("track.wav");
    expect(track.active).toBe(true);
    expect(track.loop_ok).toBe(false);

    const onDisk = join(fs.paths.trackDir("calm-01"), "track.wav");
    const { sha256File } = await import("../../src/index.js");
    const checksum = await sha256File(onDisk);
    expect(checksum.checksum).toBe(track.checksum);

    expect(d.store.getMusicTrack("calm-01")).toEqual(track);
  });

  it("rejects a source with no audio stream, without touching the kho", async () => {
    const { fs, store, clock } = world();
    const d = { fs, store, clock, prober: new NoAudioProber() };
    const clip = makeClip(8);

    let caught: unknown;
    try {
      await addMusicTrack(d, { track_id: "silent-01", display_name: "Silent", file_path: clip, mood: ["calm"], origin: "own", origin_note: "n/a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listTrackIds()).toEqual([]);
  });

  it("rejects a clip <= 5 seconds long", async () => {
    const { d, fs } = world();
    const clip = makeClip(3);

    let caught: unknown;
    try {
      await addMusicTrack(d, { track_id: "short-01", display_name: "Too short", file_path: clip, mood: ["calm"], origin: "own", origin_note: "n/a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listTrackIds()).toEqual([]);
  });

  it("rejects re-adding an existing track_id (tracks are immutable), without touching the kho again", async () => {
    const { d, fs } = world();
    await addMusicTrack(d, { track_id: "calm-01", display_name: "Calm piano 01", file_path: makeClip(8), mood: ["calm"], origin: "own", origin_note: "n/a" });

    let caught: unknown;
    try {
      await addMusicTrack(d, { track_id: "calm-01", display_name: "Replacement", file_path: makeClip(8), mood: ["calm"], origin: "own", origin_note: "n/a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listTrackIds()).toEqual(["calm-01"]);
    expect(d.store.getMusicTrack("calm-01")?.display_name).toBe("Calm piano 01");
  });
});

describe.skipIf(!hasFfmpeg())("retireMusicTrack", () => {
  it("moves active -> retired, keeps the file, and is idempotent", async () => {
    const { d, fs } = world();
    const track = await addMusicTrack(d, { track_id: "calm-01", display_name: "Calm piano 01", file_path: makeClip(8), mood: ["calm"], origin: "own", origin_note: "n/a" });

    const retired = retireMusicTrack(d, track.track_id);
    expect(retired.active).toBe(false);
    expect(d.store.getMusicTrack(track.track_id)?.active).toBe(false);
    expect(fs.listTrackIds()).toEqual(["calm-01"]); // file/dir kept

    const again = retireMusicTrack(d, track.track_id);
    expect(again).toEqual(retired);
  });

  it("throws NOT_FOUND for a track_id that was never added", () => {
    const { d } = world();
    let caught: unknown;
    try {
      retireMusicTrack(d, "never-added");
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "NOT_FOUND")).toBe(true);
  });
});

describe("activeTracks", () => {
  it("keeps ids order, filters to active only, drops ids with no mirrored track", () => {
    const { store, clock } = openTempStore();
    const now = clock.now();
    const mk = (id: string, active: boolean) => ({
      schema_version: "harness.music-track/v1" as const, track_id: id, display_name: id, file: "track.wav",
      mood: ["calm"], duration_seconds: 10, loop_ok: false, origin: "own" as const, origin_note: "n/a",
      checksum: `sha256:${"a".repeat(64)}`, active, created_at: now, updated_at: now,
    });
    store.upsertMusicTrack(mk("t1", true));
    store.upsertMusicTrack(mk("t2", false));
    store.upsertMusicTrack(mk("t3", true));

    expect(activeTracks(store, ["t3", "t2", "t1", "no-such-id"]).map((t) => t.track_id)).toEqual(["t3", "t1"]);
  });
});
