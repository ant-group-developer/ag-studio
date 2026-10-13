import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearProjectAudio, createProject, declineProjectNarration, importProjectAudio, importProjectMusic, projectAudio, projectAudioSummary, projectLibraryTrack, projectMusic,
  projectNarrationVoice, saveLibraryMusic, setProjectLibraryMusic,
} from "../src/index.js";
import { ffprobeDuration, hasFfmpeg, makeWav } from "../../../tests/media.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  return { ...w, project };
}

describe("project audio", () => {
  it("starts with nothing chosen; declining narration makes lines subtitles", () => {
    const s = setup();
    expect(projectAudio(s.db, s.project.id)).toEqual({ voice: null, music: null });
    expect(projectAudioSummary(s.db, s.project.id).voice).toContain("chưa chọn");
    declineProjectNarration(s.db, s.project.id, "u");
    expect(projectNarrationVoice(s.db, s.project.id)).toEqual({ kind: "none" });
    expect(projectAudioSummary(s.db, s.project.id).voice).toBe("không lời dẫn (lời thành phụ đề)");
    clearProjectAudio(s.db, s.project.id, "voice");
    expect(projectAudio(s.db, s.project.id).voice).toBeNull();
  });

  it("a music library track becomes the project's music as is (no copy, no schema change)", () => {
    const s = setup();
    const track = {
      schema_version: "harness.music-track/v1" as const, track_id: "m-sang", display_name: "Sáng sớm", file: "library:music/abc.m4a", mood: ["calm"],
      duration_seconds: 120, loop_ok: false, origin: "licensed" as const, origin_note: "x", checksum: `sha256:${"b".repeat(64)}`, active: true,
      created_at: NOW, updated_at: NOW,
    };
    saveLibraryMusic(s.db, track);
    setProjectLibraryMusic(s.db, s.project.id, track);
    expect(projectMusic(s.db, s.project.id)).toEqual({ track: "library:music/abc.m4a", gain_db: -18, ducking: true });
    expect(projectLibraryTrack(s.db, s.project.id)?.track_id).toBe("m-sang");
    expect(projectAudioSummary(s.db, s.project.id).music).toBe('bài "Sáng sớm" trong kho nhạc (120 s), -18 dB, nhỏ lại khi có lời');
    expect(() => setProjectLibraryMusic(s.db, s.project.id, { ...track, active: false })).toThrow(/gỡ/);
  });
});

describe.skipIf(!hasFfmpeg())("project audio import (needs ffmpeg + ffprobe)", () => {
  it("a voice sample and music are normalised, kept by content under the project, and used", async () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), "project-audio-"));
    const wav = join(dir, "giong.wav");
    makeWav(wav, 6, { frequency: 220 });
    const voice = await importProjectAudio({ db: s.db, bucket: s.bucket, ffmpeg: FFMPEG, ffprobe: FFPROBE }, {
      projectId: s.project.id, kind: "voice", file: wav, source: { kind: "upload", filename: "giong.wav" }, userId: "u", origin: "own", referenceText: "Xin chào",
    });
    expect(voice).toMatchObject({ mode: "clone", origin: "own", reference_text: "Xin chào", reference: expect.stringMatching(new RegExp(`^library:studio/projects/${s.project.id}/voice/[0-9a-f]{64}\\.wav$`)) });
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith(`library/studio/projects/${s.project.id}/voice/`))).toBe(true);
    expect(projectNarrationVoice(s.db, s.project.id)).toMatchObject({ kind: "clone", voice: { reference_text: "Xin chào", speed: 1 } });
    const music = join(dir, "nhac.wav");
    makeWav(music, 8, { frequency: 440 });
    await importProjectAudio({ db: s.db, bucket: s.bucket, ffmpeg: FFMPEG, ffprobe: FFPROBE }, {
      projectId: s.project.id, kind: "music", file: music, source: { kind: "upload", filename: "nhac.wav" }, userId: "u",
    });
    expect(projectMusic(s.db, s.project.id)).toMatchObject({ track: expect.stringMatching(/^library:studio\/projects\/.+\/music\/[0-9a-f]{64}\.m4a$/), gain_db: -18, ducking: true });
    expect(projectAudioSummary(s.db, s.project.id).voice).toBe("giọng mẫu 6 s (giọng của người dùng)");
  });

  it("several files join in order into one track: end to end, or each fading into the next", async () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), "project-music-"));
    const files = [["mot.wav", 6, 220], ["hai.wav", 7, 330], ["ba.wav", 8, 440]].map(([name, seconds, frequency]) => {
      const path = join(dir, name as string);
      makeWav(path, seconds as number, { frequency: frequency as number });
      return { path, filename: name as string };
    });
    const d = { db: s.db, bucket: s.bucket, ffmpeg: FFMPEG, ffprobe: FFPROBE };
    const faded = await importProjectMusic(d, { projectId: s.project.id, files, crossfadeS: 2 });
    expect(faded).toMatchObject({
      track: expect.stringMatching(/^library:studio\/projects\/.+\/music\/[0-9a-f]{64}\.m4a$/), crossfade_s: 2,
      parts: [{ filename: "mot.wav", duration_s: expect.closeTo(6, 0) }, { filename: "hai.wav" }, { filename: "ba.wav" }],
    });
    expect(faded.duration_s).toBeCloseTo(21 - 4, 0);
    expect(faded).not.toHaveProperty("source");
    const key = faded.track.replace(/^library:/, "library/");
    const out = join(dir, "out.m4a");
    await s.bucket.getFile(key, out);
    expect(ffprobeDuration(out)).toBeCloseTo(17, 0);
    expect(projectMusic(s.db, s.project.id)?.track).toBe(faded.track);
    expect(projectAudioSummary(s.db, s.project.id).music).toBe("nhạc riêng của dự án (3 bài ghép, chuyển mờ 2 s; 17 s), -18 dB, nhỏ lại khi có lời");

    const butt = await importProjectMusic(d, { projectId: s.project.id, files: files.slice(0, 2), crossfadeS: 0 });
    expect(butt.duration_s).toBeCloseTo(13, 0);
    expect(projectAudioSummary(s.db, s.project.id).music).toContain("2 bài ghép, nối thẳng");

    // a fade as long as half the shortest file, a file under 5 s (named), no file
    await expect(importProjectMusic(d, { projectId: s.project.id, files, crossfadeS: 3 })).rejects.toThrow(/nửa bài ngắn nhất/);
    const short = join(dir, "ngan.wav");
    makeWav(short, 2);
    await expect(importProjectMusic(d, { projectId: s.project.id, files: [...files, { path: short, filename: "ngan.wav" }] })).rejects.toThrow(/^ngan\.wav: file ngắn hơn 5 giây/);
    await expect(importProjectMusic(d, { projectId: s.project.id, files: [] })).rejects.toThrow(/ít nhất một file/);
    expect(projectMusic(s.db, s.project.id)?.track).toBe(butt.track);
  });
});
