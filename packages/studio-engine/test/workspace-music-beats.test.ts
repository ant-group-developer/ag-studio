/**
 * The beats of a background track (feedback-vps §4.7): job `music_beats` asks the farm (`studio.beats`) and keeps them
 * beside the track; the fit cuts a shot with `snap` on them, finding them itself when the job has not.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import { layoutTimeline, studioSourceId } from "@harness/core";
import {
  addSource, beatsKey, beatsWords, createJobRunner, createProject, createVideo, fitHandler, getJob, latestVideoRevision, musicBeatsHandler, partStarts, queueFit,
  queueMusicBeats, readMusicBeats, savePrepared, seedWorkspace, studioLogger, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-15T08:00:00.000Z";
const ASSET = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const SRC = studioSourceId(ASSET);
// 120 BPM from 0.2 s (on the 30 fps frame grid): a beat every 0.5 s, a bar every 2 s, over a 60 s track
const BEATS = Array.from({ length: 120 }, (_, k) => Math.round((0.2 + k * 0.5) * 1000) / 1000);
const DOWNBEATS = BEATS.filter((_, k) => k % 4 === 0);

const view = (over: Partial<FarmJobView>): FarmJobView => ({
  id: "00000000-0000-4000-8000-00000000ffff", owner: "studio", type: "studio.beats", lane: "interactive", status: "queued", priority: 0,
  correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 0, max_attempts: 2, node_id: null, progress_percent: null,
  progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
} as FarmJobView);

let opened: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => { await opened?.db.close(); opened = undefined; });

async function setup(o: { farmIdle?: boolean } = {}) {
  const w = opened = await world();
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Intro", createdBy: "u" }, NOW);
  const track = `library:studio/projects/${project.id}/music/abc.m4a`;
  const submitted: { type: string; payload: Record<string, unknown>; requirements?: unknown }[] = [];
  const farm: ProjectFarm = {
    submitJob: async (req) => {
      submitted.push({ type: String(req.type), payload: req.payload as Record<string, unknown>, requirements: req.requirements });
      const [, stage, jobId] = String(req.correlation_id).match(/^studio-job-(\w+)-(.+)$/)!;
      await w.bucket.put(`productions/${project.id}/jobs/${stage}/${jobId}/out/beats.json`, Buffer.from(JSON.stringify({
        schema: "ag.studio.beats/v1", production_id: project.id, engine: { name: "librosa:0.11.0", version: null },
        tracks: [{ track_id: "music", duration_s: 60, bpm: 120, beats_per_bar: 4, beats: BEATS, downbeats: DOWNBEATS, sections: [{ start: 0, end: 60, bpm: 120 }] }],
      })));
      return { job: view({}), created: true };
    },
    getJob: async () => view({ status: o.farmIdle ? "queued" : "completed" }),
    cancelJob: async () => view({ status: "cancelled" }),
    ackJob: async () => view({ status: "completed" }),
  };
  const deps = { db: w.db, bucket: w.bucket, farm, pollMs: 1 };
  const runner = createJobRunner({
    db: w.db, logger: studioLogger({ test: "beats" }), workspacesRoot: root, dataRoot: join(w.dir, "data"),
    handlers: { music_beats: musicBeatsHandler(deps), fit: fitHandler({ ...deps, voiceDir: join(w.dir, "voice"), queueTimeoutMs: 3_600_000, beatsQueueTimeoutMs: 30 }) },
  });
  const run = async () => { await runner.tick(); await runner.idle(); };
  return { ...w, project, video, dir, track, submitted, run };
}

describe("music beats", () => {
  it("joined songs: each one after the first starts where the one before fades into it", () => {
    expect(partStarts({ parts: [{ filename: "a.mp3", duration_s: 100 }, { filename: "b.mp3", duration_s: 80 }, { filename: "c.mp3", duration_s: 60 }], crossfade_s: 2 })).toEqual([98, 176]);
    expect(partStarts({})).toEqual([]);
    expect(beatsKey("library:music/calm.m4a")).toBe("library/music/calm.m4a.beats.json");
  });

  it("are found on the farm once, kept beside the track, and not asked for again", async () => {
    const s = await setup();
    expect(await queueMusicBeats({ db: s.db, bucket: s.bucket }, { projectId: s.project.id, createdBy: "u" }, NOW)).toBeNull();
    await s.db.run("UPDATE projects SET music = ? WHERE id = ?", [JSON.stringify({
      track: s.track, gain_db: -18, ducking: true, sha256: "abc", duration_s: 60,
      parts: [{ filename: "a.mp3", duration_s: 32 }, { filename: "b.mp3", duration_s: 30 }], crossfade_s: 2,
    }), s.project.id]);
    const job = (await queueMusicBeats({ db: s.db, bucket: s.bucket }, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW))!;
    expect(job.request).toEqual({ track: s.track, sha256: "abc", parts: [30] });
    // one at a time per track
    expect(await queueMusicBeats({ db: s.db, bucket: s.bucket }, { projectId: s.project.id, createdBy: "u" }, NOW)).toBeNull();
    await s.run();
    expect(await getJob(s.db, job.id)).toMatchObject({ status: "done", result: { bpm: 120, beats: 120, beats_per_bar: 4 } });
    expect(s.submitted).toEqual([{
      type: "studio.beats", requirements: { python: true },
      payload: { production_id: s.project.id, tracks: [{ track_id: "music", audio: s.track, parts: [30] }], beats_per_bar: 4 },
    }]);
    const b = (await readMusicBeats(s.bucket, s.track, "abc"))!;
    expect(b).toMatchObject({ schema_version: "studio.music-beats/v1", track: s.track, sha256: "abc", bpm: 120, engine: "librosa:0.11.0" });
    expect(s.bucket.objects.has(`library/studio/projects/${s.project.id}/music/abc.m4a.beats.json`)).toBe(true);
    expect(beatsWords(b)).toBe("≈ 120 BPM, 4 phách một ô nhịp (ô nhịp 2 s)");
    // known now: nothing to queue; beats of another content under that name are not its own
    expect(await queueMusicBeats({ db: s.db, bucket: s.bucket }, { projectId: s.project.id, createdBy: "u" }, NOW)).toBeNull();
    expect(await readMusicBeats(s.bucket, s.track, "other")).toBeNull();
  });
});

describe("fit with snap", () => {
  async function planned(s: Awaited<ReturnType<typeof setup>>) {
    await addSource(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "Phố.mp4", addedBy: "u" }, NOW);
    const input = join(s.dir, "inputs", ASSET);
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "shots.json"), JSON.stringify({
      schema_version: "studio.input-shots/v1", asset_id: ASSET, name: "Phố.mp4", duration_s: 40, width: 1920, height: 1080, fps: 30, has_audio: true,
      source: { kind: "preview", watermarked: false }, scene: {}, shots: [1, 2, 3, 4].map((n) => ({ n, in: (n - 1) * 10, out: n * 10, frame: `frames/00${n}.jpg` })), sheets: [],
    }));
    await savePrepared(s.db, { project_id: s.project.id, asset_id: ASSET, status: "ready", name: "Phố.mp4", duration_s: 40, width: 1920, height: 1080, has_audio: true, shots: 4, transcript: false, source_kind: "preview", watermarked: false, error: null }, NOW);
    const vdir = join(s.dir, "videos", s.video.id);
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, "survey.json"), JSON.stringify({
      schema_version: "harness.survey-index/v2",
      shots: [0, 1, 2, 3].map((i) => ({ source_id: SRC, shot_id: `s000-00${i}`, in: i * 10, out: (i + 1) * 10, score: 4, tags: [], usable: true, note: "đẹp", speech: "none" })),
    }));
    writeFileSync(join(vdir, "edit-plan.json"), JSON.stringify({
      schema_version: "studio.edit-plan/v1", episode_id: "x", narration: "none", language: "vi", target_seconds: 30,
      shots: [
        { order: 1, shot_id: "s000-000", source_id: SRC, in: 0, out: 7.1, line_id: null, transition: "cut", section_title: "Mở", note: "", snap: "bar" },
        { order: 2, shot_id: "s000-001", source_id: SRC, in: 10, out: 15.6, line_id: null, transition: "cut", section_title: null, note: "", snap: "bar" },
        { order: 3, shot_id: "s000-002", source_id: SRC, in: 20, out: 23.3, line_id: null, transition: "cut", section_title: null, note: "" },
        { order: 4, shot_id: "s000-003", source_id: SRC, in: 30, out: 39.4, line_id: null, transition: "cut", section_title: null, note: "", snap: "beat" },
      ],
      lines: [], texts: [{ text_id: "T001", kind: "title", text: "Phố cổ", at_order: 2, offset_s: 0.5, duration: 2, position: "top_left" }], music_mood: null,
    }));
    await s.db.run("UPDATE projects SET music = ? WHERE id = ?", [JSON.stringify({ track: s.track, gain_db: -18, ducking: false, sha256: "abc", duration_s: 60 }), s.project.id]);
  }

  it("moves the cut out of each shot with snap onto the nearest bar or beat, finding the beats on the farm when none are kept", async () => {
    const s = await setup();
    await planned(s);
    const job = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    const done = (await getJob(s.db, job.id))!;
    expect(done).toMatchObject({ status: "done", error: null });
    // the beats were not kept yet: the fit asked the farm itself, and kept them
    expect(s.submitted.map((x) => x.type)).toEqual(["studio.beats"]);
    expect(await readMusicBeats(s.bucket, s.track)).not.toBeNull();
    const t = (await latestVideoRevision(s.db, s.video.id))!.data;
    const laid = layoutTimeline(t);
    const cuts = laid.clips.map((c) => c.end);
    // 7.1 → bar 6.2; then 6.2 + 5.6 = 11.8 → bar 12.2; 3.3 s stays (15.5); 15.5 + 9.4 = 24.9 → beat 24.7
    expect(cuts).toEqual([6.2, 12.2, 15.5, 24.7]);
    expect(DOWNBEATS).toContain(cuts[0]);
    expect(DOWNBEATS).toContain(cuts[1]);
    expect(BEATS).toContain(cuts[3]);
    // the text anchored on shot 2 moved with it
    expect(t.texts[0]).toMatchObject({ text_id: "T001", start: 6.7 });
    expect(done.result).toMatchObject({ snap: { moved: [
      { clip_id: "C001", kind: "bar", from: 7.1, to: 6.2 }, { clip_id: "C002", kind: "bar", from: 11.8, to: 12.2 }, { clip_id: "C004", kind: "beat", from: 24.9, to: 24.7 },
    ], not_moved: [], music: "nhạc ≈ 120 BPM, 4 phách một ô nhịp (ô nhịp 2 s)" } });
    // built again: the kept beats are read, the farm is not asked again
    await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect(s.submitted).toHaveLength(1);
    expect(layoutTimeline((await latestVideoRevision(s.db, s.video.id))!.data).clips.map((c) => c.end)).toEqual(cuts);
  });

  it("no farm machine to find the beats: the fit waits a little, not the hours a render may, and keeps the cuts", async () => {
    const s = await setup({ farmIdle: true });
    await planned(s);
    const job = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    const done = (await getJob(s.db, job.id))!;
    expect(done.status).toBe("done");
    expect(layoutTimeline((await latestVideoRevision(s.db, s.video.id))!.data).clips.map((c) => c.end)).toEqual([7.1, 12.7, 16, 25.4]);
    expect(done.result).toMatchObject({ snap: { moved: [], music: expect.stringContaining("chưa có nhịp của nhạc") } });
  });

  it("without music the cuts stay where the plan put them, and the job says why", async () => {
    const s = await setup();
    await planned(s);
    await s.db.run("UPDATE projects SET music = NULL WHERE id = ?", [s.project.id]);
    const vdir = join(s.dir, "videos", s.video.id);
    const plan = JSON.parse((await import("node:fs")).readFileSync(join(vdir, "edit-plan.json"), "utf8"));
    writeFileSync(join(vdir, "edit-plan.json"), JSON.stringify({ ...plan, music: null }));
    const job = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    const done = (await getJob(s.db, job.id))!;
    expect(done.status).toBe("done");
    expect(layoutTimeline((await latestVideoRevision(s.db, s.video.id))!.data).clips.map((c) => c.end)).toEqual([7.1, 12.7, 16, 25.4]);
    expect(done.result).toMatchObject({ snap: { moved: [], music: "kế hoạch có snap nhưng video không có nhạc nên điểm cắt giữ nguyên" } });
    expect(s.submitted).toEqual([]);
  });
});
