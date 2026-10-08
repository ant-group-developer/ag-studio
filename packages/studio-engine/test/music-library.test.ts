import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MusicTrack } from "@harness/contracts";
import { foldMood, getLibraryMusic, importLibraryMusic, listLibraryMusic, pickLibraryMusic, saveLibraryMusic } from "../src/index.js";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

function track(id: string, mood: string[], over: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1", track_id: id, display_name: id, file: `library:music/${id}.m4a`, mood, duration_seconds: 300,
    loop_ok: false, origin: "royalty_free", origin_note: "Thư viện miễn phí", checksum: `sha256:${"a".repeat(64)}`, active: true,
    created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z", ...over,
  };
}

describe("pickLibraryMusic", () => {
  const tracks = [track("calm-a", ["Calm"]), track("am-ap", ["Ấm áp", "nostalgic"]), track("short", ["upbeat"], { duration_seconds: 60 }),
    track("loop", ["upbeat"], { duration_seconds: 60, loop_ok: true }), track("off", ["sad"], { active: false })];

  it("takes the first mood some active track has, without case or marks", () => {
    expect(foldMood("  ẤM  Áp ")).toBe("am ap");
    expect(pickLibraryMusic(tracks, [null, "am ap", "calm"], { seed: "ep-1", seconds: 240 })).toMatchObject({
      track: { track_id: "am-ap" }, mood: "am ap", music: { track: "library:music/am-ap.m4a", gain_db: -18, ducking: true },
    });
    expect(pickLibraryMusic(tracks, ["sad", "CALM"], { seed: "ep-1", seconds: 240 })?.track.track_id).toBe("calm-a");
    expect(pickLibraryMusic(tracks, ["sad", "jazz", undefined, ""], { seed: "ep-1", seconds: 240 })).toBeNull();
  });

  it("prefers a track long enough for the episode or one that loops; the same episode always gets the same", () => {
    expect(pickLibraryMusic(tracks, ["upbeat"], { seed: "ep-1", seconds: 240 })?.track.track_id).toBe("loop");
    // both fit a short episode: the seed decides, and keeps deciding the same way
    const picks = new Set(Array.from({ length: 3 }, () => pickLibraryMusic(tracks, ["upbeat"], { seed: "ep-7", seconds: 30 })?.track.track_id));
    expect(picks.size).toBe(1);
  });
});

describe("the library rows", () => {
  it("are the harness music_track rows: saved, listed (active only on request), read back", () => {
    const { db } = world();
    saveLibraryMusic(db, track("calm-a", ["calm"]));
    saveLibraryMusic(db, track("off", ["sad"], { active: false }));
    expect(listLibraryMusic(db).map((t) => t.track_id)).toEqual(["calm-a", "off"]);
    expect(listLibraryMusic(db, { activeOnly: true }).map((t) => t.track_id)).toEqual(["calm-a"]);
    saveLibraryMusic(db, track("calm-a", ["calm", "morning"]));
    expect(getLibraryMusic(db, "calm-a")?.mood).toEqual(["calm", "morning"]);
    expect(getLibraryMusic(db, "nope")).toBeNull();
  });

  it.skipIf(!hasFfmpeg())("an upload is made AAC, kept by its content under library/music/, and the same file again is the same track", async () => {
    const { db, bucket } = world();
    const wav = join(mkdtempSync(join(tmpdir(), "music-in-")), "tone.wav");
    makeWav(wav, 12, { frequency: 440 });
    const d = { db, bucket, ffmpeg: FFMPEG, ffprobe: FFPROBE };
    const first = await importLibraryMusic(d, { file: wav, displayName: " Sáng sớm ", moods: ["calm", "calm", " Ấm áp "], origin: "own", originNote: "Nhóm tự làm", loopOk: true, now: "2026-10-08T01:00:00.000Z" });
    expect(first).toMatchObject({ display_name: "Sáng sớm", mood: ["calm", "Ấm áp"], loop_ok: true, origin: "own", active: true });
    expect(first.track_id).toMatch(/^m-[0-9a-f]{16}$/);
    expect(first.file).toMatch(/^library:music\/[0-9a-f]{64}\.m4a$/);
    expect(first.duration_seconds).toBeCloseTo(12, 0);
    expect(await bucket.exists(`library/${first.file.slice("library:".length)}`)).not.toBeNull();
    const again = await importLibraryMusic(d, { file: wav, displayName: "Sáng", moods: ["upbeat"], origin: "own", originNote: "x", loopOk: false, now: "2026-10-08T02:00:00.000Z" });
    expect(again).toMatchObject({ track_id: first.track_id, mood: ["upbeat"], created_at: "2026-10-08T01:00:00.000Z", updated_at: "2026-10-08T02:00:00.000Z" });
    expect(listLibraryMusic(db)).toHaveLength(1);
  }, 60_000);
});
