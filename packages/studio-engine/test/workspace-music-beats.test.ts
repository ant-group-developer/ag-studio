/**
 * The beats of a background track (feedback-vps §4.7): job `music_beats` asks the farm (`studio.beats`) and keeps them
 * beside the track.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import {
  beatsKey, beatsWords, createJobRunner, createProject, createVideo, getJob, musicBeatsHandler, partStarts, queueMusicBeats, readMusicBeats, seedWorkspace,
  studioLogger, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-15T08:00:00.000Z";
// 120 BPM from 0.25 s: a beat every 0.5 s, a bar every 2 s, over a 60 s track
const BEATS = Array.from({ length: 120 }, (_, k) => Math.round((0.25 + k * 0.5) * 1000) / 1000);
const DOWNBEATS = BEATS.filter((_, k) => k % 4 === 0);

const view = (over: Partial<FarmJobView>): FarmJobView => ({
  id: "00000000-0000-4000-8000-00000000ffff", owner: "studio", type: "studio.beats", lane: "interactive", status: "queued", priority: 0,
  correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 0, max_attempts: 2, node_id: null, progress_percent: null,
  progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
} as FarmJobView);

let opened: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => { await opened?.db.close(); opened = undefined; });

async function setup() {
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
    getJob: async () => view({ status: "completed" }),
    cancelJob: async () => view({ status: "cancelled" }),
    ackJob: async () => view({ status: "completed" }),
  };
  const deps = { db: w.db, bucket: w.bucket, farm, pollMs: 1 };
  const runner = createJobRunner({
    db: w.db, logger: studioLogger({ test: "beats" }), workspacesRoot: root, dataRoot: join(w.dir, "data"),
    handlers: { music_beats: musicBeatsHandler(deps) },
  });
  const run = async () => { await runner.tick(); await runner.idle(); };
  return { ...w, project, video, track, submitted, run };
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

