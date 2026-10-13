import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  clearVideoMusic, createVideo, importVideoMusic, latestVideoRevision, musicForVideo, saveVideoRevision, setVideoLibraryMusic, videoLibraryTrack,
  videoMusicSummary, videoMusicToTimeline, videoOwnMusic,
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

describe("a video's own music", () => {
  const timeline = (videoId: string): TimelineV4 => ({
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [{ clip_id: "C001", asset_id: "a1", section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } }],
    texts: [], narration: { voice: "none", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" },
    music: { track: "library:music/mood.m4a", gain_db: -18, ducking: true }, source_audio: { muted: false },
    assets: { a1: { title: "Phố", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [],
  });
  const track = (id: string) => ({
    schema_version: "harness.music-track/v1" as const, track_id: id, display_name: id, file: `library:music/${id}.m4a`, mood: ["calm"],
    duration_seconds: 90, loop_ok: true, origin: "own" as const, origin_note: "x", checksum: `sha256:${"c".repeat(64)}`, active: true,
    created_at: NOW, updated_at: NOW,
  });

  it("overrides the project's; cleared, the video takes the project's again; nothing chosen, Studio picks by mood", () => {
    const s = setup();
    const v = createVideo(s.db, s.project.id, { title: "Tập 1", createdBy: "u" }, NOW);
    expect(musicForVideo(s.db, s.project.id, v.id)).toBeNull();
    expect(videoMusicSummary(s.db, s.project.id, v.id)).toMatch(/^nhạc của dự án: chưa chọn/);
    saveLibraryMusic(s.db, track("du-an"));
    saveLibraryMusic(s.db, track("rieng"));
    setProjectLibraryMusic(s.db, s.project.id, track("du-an"));
    expect(musicForVideo(s.db, s.project.id, v.id)).toEqual({ music: { track: "library:music/du-an.m4a", gain_db: -18, ducking: true }, from: "project" });
    setVideoLibraryMusic(s.db, v.id, track("rieng"), { gainDb: -20 });
    expect(musicForVideo(s.db, s.project.id, v.id)).toEqual({ music: { track: "library:music/rieng.m4a", gain_db: -20, ducking: true }, from: "video" });
    expect(videoLibraryTrack(s.db, v.id)?.track_id).toBe("rieng");
    expect(videoMusicSummary(s.db, s.project.id, v.id)).toBe('nhạc riêng của video: bài "rieng" trong kho nhạc, -20 dB, nhỏ lại khi có lời');
    expect(projectMusic(s.db, s.project.id)?.track).toBe("library:music/du-an.m4a");
    clearVideoMusic(s.db, v.id);
    expect(videoOwnMusic(s.db, v.id)).toBeNull();
    expect(musicForVideo(s.db, s.project.id, v.id)?.from).toBe("project");
  });

  it("the latest timeline takes the video's music as a new revision; nothing is written without a timeline or a change", () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), "video-music-"));
    const v = createVideo(s.db, s.project.id, { title: "Tập 1", createdBy: "u" }, NOW);
    const follow = () => videoMusicToTimeline(s.db, { workspaceDir: dir, projectId: s.project.id, videoId: v.id, authorId: "u" });
    saveLibraryMusic(s.db, track("rieng"));
    setVideoLibraryMusic(s.db, v.id, track("rieng"));
    expect(follow()).toBeNull();
    saveVideoRevision(s.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: "agent", label: "fit" });
    expect(follow()).toBe(2);
    expect(latestVideoRevision(s.db, v.id)).toMatchObject({ revision: 2, label: "music", data: { music: { track: "library:music/rieng.m4a" }, clips: [{ clip_id: "C001" }] } });
    expect(follow()).toBeNull();
    // back to nothing chosen anywhere: the timeline keeps what it has (Studio's pick by mood)
    clearVideoMusic(s.db, v.id);
    expect(follow()).toBeNull();
    expect(latestVideoRevision(s.db, v.id)?.revision).toBe(2);
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

    // a video's own, joined the same way and kept under the project
    const v = createVideo(s.db, s.project.id, { title: "Tập 1", createdBy: "u" }, NOW);
    const own = await importVideoMusic(d, { videoId: v.id, files: files.slice(1), crossfadeS: 1 });
    expect(own).toMatchObject({ track: expect.stringContaining(`library:studio/projects/${s.project.id}/music/`), crossfade_s: 1, parts: [{ filename: "hai.wav" }, { filename: "ba.wav" }] });
    expect(videoOwnMusic(s.db, v.id)?.track).toBe(own.track);
    expect(projectMusic(s.db, s.project.id)?.track).toBe(butt.track);
    expect(videoMusicSummary(s.db, s.project.id, v.id)).toBe("nhạc riêng của video (2 bài ghép, chuyển mờ 1 s; 14 s), -18 dB, nhỏ lại khi có lời");
  });
});
