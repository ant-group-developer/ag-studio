import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  addSource, agentTools, callAgentTool, createProject, createThread, createVideo, latestVideoRevision, listJobs, markAgentTurnRunning,
  postUserMessage, savePrepared, saveVideoRevision, seedWorkspace, videoOwnMusic, type AgentToolContext, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";
import { saveLibraryMusic } from "../src/index.js";

const NOW = "2026-10-10T08:00:00.000Z";
const A2 = "1c8b6d45-6e2f-4e5d-8b62-4e3b2f1d8e22";

function timeline(videoId: string): TimelineV4 {
  return {
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [
      { clip_id: "C001", asset_id: "a1", section_title: "Mở đầu", in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "dissolve", seconds: 0.4 } },
      { clip_id: "C002", asset_id: "a1", section_title: null, in: 5, out: 9, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } },
    ],
    texts: [{ text_id: "T001", kind: "title", text: "Tràng An", start: 0, duration: 2, position: "top_left" }],
    narration: { voice: "none", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" }, music: null, source_audio: { muted: false },
    assets: { a1: { title: "Thuyền", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [],
  };
}

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup() {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "timeline-tools-")), project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const thread = await createThread(w.db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW);
  const { turn } = await postUserMessage(w.db, { threadId: thread.id, text: "Sửa timeline", actor: { id: "u", role: "editor" } }, NOW);
  await markAgentTurnRunning(w.db, turn!.id, NOW);
  const ctx: AgentToolContext = {
    db: w.db, claims: { msg: turn!.id, thread: thread.id, project: project.id, video: video.id, sub: "u", exp: 9e9 },
    message: turn!, thread, project, video, workspaceDir: dir, role: "editor", now: () => NOW,
  };
  return { ...w, project, video, dir, thread, ctx, tools: agentTools() };
}

const call = async (s: Awaited<ReturnType<typeof setup>>, name: string, args: unknown) => {
  const r = await callAgentTool(s.tools, s.ctx, name, args);
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = r.isError ? null : JSON.parse(r.text); } catch { /* a sentence */ }
  return { ...r, json };
};

describe("timeline tools", () => {
  it("timeline_get reads the clips where they play in the video, and the problems", async () => {
    const s = await setup();
    expect(await call(s, "timeline_get", {})).toMatchObject({ isError: true, text: expect.stringContaining("chưa có timeline") });
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u", label: "fit" });
    const r = await call(s, "timeline_get", { view: "clips" });
    expect(r.json).toMatchObject({ revision: 1, label: "fit", view: "clips", approx_seconds: 7.6, clips_total: 2 });
    expect(r.json.clips.map((c: { clip_id: string; at: number; asset: string }) => [c.clip_id, c.at, c.asset])).toEqual([["C001", 0, "Thuyền"], ["C002", 3.6, "Thuyền"]]);
    expect((await call(s, "timeline_get", { view: "full" })).json).toMatchObject({ view: "full", texts: [{ text_id: "T001" }], clips: [{ clip_id: "C001" }, { clip_id: "C002" }] });
  });

  it("timeline_get answers an overview by default, and clips or texts a stretch at a time", async () => {
    const s = await setup();
    const clip = (n: number, section: string | null) => ({
      clip_id: `C${String(n).padStart(3, "0")}`, asset_id: "a1", section_title: section, in: 0, out: 2, shot_id: null, line_id: null, transition_out: { kind: "cut" as const, seconds: 0 },
    });
    const clips = Array.from({ length: 150 }, (_, i) => clip(i + 1, i === 0 ? "Mở đầu" : i === 100 ? "Kết" : null));
    const texts = Array.from({ length: 10 }, (_, i) => ({ text_id: `T${String(i + 1).padStart(3, "0")}`, kind: "callout" as const, text: `chữ ${i}`, start: i * 30, duration: 3, position: "bottom_left" as const }));
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: { ...timeline(s.video.id), clips, texts }, authorId: "u" });

    const o = (await call(s, "timeline_get", {})).json;
    expect(o).toMatchObject({ view: "overview", approx_seconds: 300, counts: { clips: 150, videos: 1, texts: 10, narration_lines: 0, muted_clips: 0, dissolves: 0 }, source_muted: false, music: null });
    expect(o.sections).toEqual([
      { title: "Mở đầu", clips: "C001–C100", at: 0, end: 200, count: 100 },
      { title: "Kết", clips: "C101–C150", at: 200, end: 300, count: 50 },
    ]);
    expect(o.clips).toBeUndefined();
    expect(o.texts).toBeUndefined();

    const part = (await call(s, "timeline_get", { view: "clips", from_s: 61, to_s: 66 })).json;
    expect(part.clips.map((c: { clip_id: string }) => c.clip_id)).toEqual(["C031", "C032", "C033"]);
    const first = (await call(s, "timeline_get", { view: "clips" })).json;
    expect(first).toMatchObject({ truncated: true, next_from_s: 240, left: 30 });
    expect(first.clips).toHaveLength(120);
    expect((await call(s, "timeline_get", { view: "texts", from_s: 100, to_s: 200 })).json.texts.map((x: { text_id: string }) => x.text_id)).toEqual(["T005", "T006", "T007"]);
    expect(await call(s, "timeline_get", { view: "clips", from_s: 10, to_s: 5 })).toMatchObject({ isError: true });
  });

  it("timeline_get pages texts by where they play, whatever order they were added in", async () => {
    const s = await setup();
    // T121 was added last but plays first (addText appends; updateText moves a text)
    const texts = Array.from({ length: 130 }, (_, i) => ({
      text_id: `T${String(i + 1).padStart(3, "0")}`, kind: "callout" as const, text: `chữ ${i}`, start: i === 120 ? 5 : 100 + i, duration: 2, position: "bottom_left" as const,
    }));
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: { ...timeline(s.video.id), texts }, authorId: "u" });
    const seen = new Set<string>();
    let from: number | undefined;
    for (let page = 0; page < 5; page++) {
      const r = (await call(s, "timeline_get", { view: "texts", ...(from !== undefined ? { from_s: from } : {}) })).json;
      for (const x of r.texts as { text_id: string }[]) seen.add(x.text_id);
      if (r.next_from_s === undefined) break;
      expect(r.next_from_s).toBeGreaterThan(from ?? -1);
      from = r.next_from_s;
    }
    expect(seen.size).toBe(130);
  });

  it("timeline_apply_ops saves a new revision on the one read, refuses a stale base and an asset the video does not have", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const ok = await call(s, "timeline_apply_ops", { base_revision: 1, ops: [{ op: "trimClip", clip_id: "C002", in: 5, out: 7 }, { op: "setClipMuted", clip_id: "C001", muted: true }] });
    expect(ok.json).toMatchObject({ revision: 2, saved: `videos/${s.video.id}/timeline.json` });
    const rev = (await latestVideoRevision(s.db, s.video.id))!;
    expect(rev).toMatchObject({ revision: 2, label: "agent" });
    expect(rev.data.clips[1]).toMatchObject({ in: 5, out: 7 });
    expect(JSON.parse(readFileSync(join(s.dir, "videos", s.video.id, "timeline.json"), "utf8")).revision).toBe(2);
    expect(await call(s, "timeline_apply_ops", { base_revision: 1, ops: [{ op: "removeText", text_id: "T001" }] })).toMatchObject({ isError: true, text: expect.stringContaining("bản mới hơn (2)") });
    expect((await call(s, "timeline_apply_ops", { base_revision: 2, ops: [{ op: "addClip", asset_id: A2, index: 0 }] })).isError).toBe(true);
    // a prepared source of the video may be added
    await addSource(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "ag_go_asset", ref: A2, mediaType: "video", label: "Hang.mp4", addedBy: "u" }, NOW);
    mkdirSync(join(s.dir, "inputs", A2), { recursive: true });
    writeFileSync(join(s.dir, "inputs", A2, "shots.json"), JSON.stringify({ name: "Hang.mp4", width: 1920, height: 1080, shots: [{ n: 1, in: 0, out: 6, frame: "frames/001.jpg" }] }));
    await savePrepared(s.db, { project_id: s.project.id, asset_id: A2, status: "ready", name: "Hang.mp4", duration_s: 6, width: 1920, height: 1080, has_audio: true, shots: 1, transcript: false, source_kind: "preview", watermarked: false, error: null }, NOW);
    expect((await call(s, "timeline_apply_ops", { base_revision: 2, ops: [{ op: "addClip", asset_id: A2, index: 0 }] })).json).toMatchObject({ revision: 3 });
    expect((await latestVideoRevision(s.db, s.video.id))!.data.assets[A2]).toMatchObject({ title: "Hang.mp4", orientation: "landscape" });
  });

  it("feedback-vps §4.4: setMusic keeps its gain and ducking as the video's music, so the next fit plays it the same", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const track = `library:studio/projects/${s.project.id}/music/abc.m4a`;
    await s.db.run("UPDATE projects SET music = ? WHERE id = ?", [JSON.stringify({ track, gain_db: -18, ducking: true, sha256: "abc", duration_s: 120 }), s.project.id]);
    const r = await call(s, "timeline_apply_ops", { base_revision: 1, ops: [{ op: "setMusic", music: { track, gain_db: -30, ducking: false } }] });
    expect(r.json).toMatchObject({ revision: 2, video_music: expect.stringContaining("-30 dB") });
    expect(await videoOwnMusic(s.db, s.video.id)).toEqual({ track, gain_db: -30, ducking: false, sha256: "abc", duration_s: 120 });
    // the same level again changes nothing; another level updates the video's own music
    expect((await call(s, "timeline_apply_ops", { base_revision: 2, ops: [{ op: "setMusic", music: { track, gain_db: -30, ducking: false } }] })).json.video_music).toBeUndefined();
    await call(s, "timeline_apply_ops", { base_revision: 3, ops: [{ op: "setMusic", music: { track, gain_db: -24, ducking: true } }] });
    expect(await videoOwnMusic(s.db, s.video.id)).toMatchObject({ track, gain_db: -24, ducking: true });
  });

  it("feedback-vps §4.5: music_list names the video's and project's music, the project's audio files and the library", async () => {
    const s = await setup();
    mkdirSync(join(s.dir, "context", "audio", "nhac"), { recursive: true });
    writeFileSync(join(s.dir, "context", "audio", "nhac", "Biển sáng.mp3"), "x".repeat(2048));
    await saveLibraryMusic(s.db, {
      schema_version: "harness.music-track/v1", track_id: "calm-a", display_name: "Calm A", file: "library:music/calm-a.m4a", mood: ["calm"], duration_seconds: 300,
      loop_ok: true, origin: "royalty_free", origin_note: "x", checksum: `sha256:${"a".repeat(64)}`, active: true, created_at: NOW, updated_at: NOW,
    });
    const r = await call(s, "music_list", {});
    expect(r.json).toMatchObject({
      video_music: expect.stringContaining("nhạc của dự án"), project_music: expect.stringContaining("chưa chọn"),
      project_files: [{ path: "context/audio/nhac/Biển sáng.mp3", name: "Biển sáng.mp3" }],
      library: [{ name: "Calm A", track: "library:music/calm-a.m4a" }],
      note: expect.stringContaining("ffmpeg"),
    });
    expect((await call(s, "music_list", { mood: "sad" })).json.library).toEqual([]);
  });

  it("feedback-vps §4.5: music_set gives the video a library track and its timeline plays it; files need this server's ffmpeg", async () => {
    const s = await setup();
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: { ...timeline(s.video.id), music: { track: "library:music/old.m4a", gain_db: -18, ducking: true, envelope: [{ at: 0, gain_db: -30 }] } }, authorId: "u" });
    await saveLibraryMusic(s.db, {
      schema_version: "harness.music-track/v1", track_id: "calm-a", display_name: "Calm A", file: "library:music/calm-a.m4a", mood: ["calm"], duration_seconds: 300,
      loop_ok: true, origin: "royalty_free", origin_note: "x", checksum: `sha256:${"a".repeat(64)}`, active: true, created_at: NOW, updated_at: NOW,
    });
    const r = await call(s, "music_set", { files: ["library:music/calm-a.m4a"], gain_db: -26, ducking: false });
    expect(r.json).toMatchObject({ scope: "video", music: expect.stringContaining("Calm A"), timeline_revision: 2 });
    expect((await latestVideoRevision(s.db, s.video.id))!.data.music).toEqual({ track: "library:music/calm-a.m4a", gain_db: -26, ducking: false, envelope: [{ at: 0, gain_db: -30 }] });
    expect(await call(s, "music_set", { files: ["context/audio/none.mp3"] })).toMatchObject({ isError: true, text: expect.stringContaining("ffmpeg") });
    expect(await call(s, "music_set", { files: ["library:music/nope.m4a"] })).toMatchObject({ isError: true });
  });

  it("feedback-vps §4.7: the music set is analysed for its beats in the background, and music_list tells its tempo", async () => {
    const s = await setup();
    s.ctx.bucket = s.bucket;
    await saveLibraryMusic(s.db, {
      schema_version: "harness.music-track/v1", track_id: "calm-a", display_name: "Calm A", file: "library:music/calm-a.m4a", mood: ["calm"], duration_seconds: 300,
      loop_ok: true, origin: "royalty_free", origin_note: "x", checksum: `sha256:${"a".repeat(64)}`, active: true, created_at: NOW, updated_at: NOW,
    });
    await call(s, "music_set", { files: ["library:music/calm-a.m4a"] });
    const jobs = (await listJobs(s.db, s.project.id)).filter((j) => j.kind === "music_beats");
    expect(jobs.map((j) => [j.request, j.thread_id, j.continue_agent])).toEqual([[{ track: "library:music/calm-a.m4a", sha256: "a".repeat(64), parts: [] }, s.thread.id, false]]);
    expect((await call(s, "music_list", {})).json.video_music_beats).toBe("đang phân tích nhịp (job music_beats)");
    await s.bucket.put("library/music/calm-a.m4a.beats.json", Buffer.from(JSON.stringify({
      schema_version: "studio.music-beats/v1", track: "library:music/calm-a.m4a", sha256: "a".repeat(64), duration_s: 300, bpm: 96, beats_per_bar: 4,
      beats: [0.3, 0.925], downbeats: [0.3], sections: [{ start: 0, end: 300, bpm: 96 }], engine: "librosa:0.11.0", analysed_at: NOW,
    })));
    expect((await call(s, "music_list", {})).json.video_music_beats).toBe("≈ 96 BPM, 4 phách một ô nhịp (ô nhịp 2,5 s)");
  });

  it.skipIf(!hasFfmpeg())("feedback-vps §4.5: music_set joins the project's audio files into the project's music", async () => {
    const s = await setup();
    const ctx = { ...s.ctx, audio: { db: s.db, bucket: s.bucket, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" } };
    mkdirSync(join(s.dir, "context", "audio"), { recursive: true });
    makeWav(join(s.dir, "context", "audio", "a.wav"), 8, { frequency: 330 });
    makeWav(join(s.dir, "context", "audio", "b.wav"), 8, { frequency: 440 });
    const outside = await callAgentTool(s.tools, ctx, "music_set", { files: ["CLAUDE.md"], scope: "project" });
    expect(outside).toMatchObject({ isError: true, text: expect.stringContaining("không phải file audio") });
    const r = await callAgentTool(s.tools, ctx, "music_set", { files: ["context/audio/a.wav", "context/audio/b.wav"], crossfade_s: 2, scope: "project" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ scope: "project", music: expect.stringContaining("2 bài ghép, chuyển mờ 2 s") });
  });

  it("render_preview and timeline_from_edit_plan queue jobs for the thread (the agent goes on when they end)", async () => {
    const s = await setup();
    expect((await call(s, "render_preview", {})).isError).toBe(true);
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    expect((await call(s, "render_preview", {})).json).toMatchObject({ status: "queued" });
    expect((await call(s, "timeline_from_edit_plan", { wait_s: 0 })).json).toMatchObject({ status: "queued" });
    expect((await listJobs(s.db, s.project.id)).map((j) => [j.kind, j.thread_id, j.continue_agent])).toEqual([["fit", s.thread.id, true], ["render_preview", s.thread.id, true]]);
  });
});

describe("studio steps of a video", () => {
  it("timeline and preview follow the revisions and renders", async () => {
    const { claimJob, finishJob, queueRender } = await import("../src/index.js");
    const s = await setup();
    const step = async (key: string) => (await call(s, "playbook_status", {})).json.video.find((x: { key: string }) => x.key === key);
    expect(await step("timeline")).toMatchObject({ status: "missing", detail: "chưa có timeline" });
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    expect(await step("timeline")).toMatchObject({ status: "done", detail: "bản 1, 2 clip" });
    expect(await step("preview")).toMatchObject({ status: "missing", detail: "chưa render bản xem trước" });
    const j = await queueRender(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_preview", createdBy: "u" }, NOW);
    expect(await step("preview")).toMatchObject({ status: "running" });
    await claimJob(s.db, ["render_preview"], NOW);
    await finishJob(s.db, j.id, { status: "done", result: { kind: "render_preview", revision: 1 } }, NOW);
    expect(await step("preview")).toMatchObject({ status: "done", detail: "timeline bản 1" });
    await saveVideoRevision(s.db, s.video.id, { baseRevision: 1, data: timeline(s.video.id), authorId: "u" });
    expect(await step("preview")).toMatchObject({ status: "missing", detail: "bản đã render là của timeline bản 1, timeline đang ở bản 2" });
  });
});
