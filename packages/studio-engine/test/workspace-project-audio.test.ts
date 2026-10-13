import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearProjectAudio, createProject, declineProjectNarration, importProjectAudio, projectAudio, projectAudioSummary, projectLibraryTrack, projectMusic,
  projectNarrationVoice, saveLibraryMusic, setProjectLibraryMusic,
} from "../src/index.js";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";
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
});
