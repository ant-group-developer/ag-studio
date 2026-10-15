/**
 * A video's timeline from its edit plan (job `fit`, P6): prepared inputs (written here as the prepare job would), the
 * agent's survey.json and edit-plan.json, the narration read on a fake farm into the voice store, the fitted timeline
 * saved as a revision and written to videos/<id>/timeline.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import { studioSourceId } from "@harness/core";
import {
  addSource, createJobRunner, createProject, createVideo, declineProjectNarration, fitHandler, getJob, latestVideoRevision, queueFit, savePrepared,
  seedWorkspace, studioLogger, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const ASSET = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const SRC = studioSourceId(ASSET);

const view = (over: Partial<FarmJobView>): FarmJobView => ({
  id: "00000000-0000-4000-8000-00000000ffff", owner: "studio", type: "studio.tts", lane: "gpu", status: "queued", priority: 0,
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
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  // a prepared input: 3 shots of 10 s
  await addSource(w.db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "Thuyền.mp4", addedBy: "u" }, NOW);
  const input = join(dir, "inputs", ASSET);
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "shots.json"), JSON.stringify({
    schema_version: "studio.input-shots/v1", asset_id: ASSET, name: "Thuyền.mp4", duration_s: 30, width: 1920, height: 1080, fps: 30, has_audio: true,
    source: { kind: "preview", watermarked: false }, scene: {}, shots: [1, 2, 3].map((n) => ({ n, in: (n - 1) * 10, out: n * 10, frame: `frames/00${n}.jpg` })), sheets: [],
  }));
  await savePrepared(w.db, { project_id: project.id, asset_id: ASSET, status: "ready", name: "Thuyền.mp4", duration_s: 30, width: 1920, height: 1080, has_audio: true, shots: 3, transcript: false, source_kind: "preview", watermarked: false, error: null }, NOW);
  // the agent's survey and edit plan
  const vdir = join(dir, "videos", video.id);
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "survey.json"), JSON.stringify({
    schema_version: "harness.survey-index/v2",
    shots: [0, 1, 2].map((i) => ({ source_id: SRC, shot_id: `s000-00${i}`, in: i * 10, out: (i + 1) * 10, score: 4, tags: [], usable: true, note: "đẹp", speech: "none" })),
  }));
  const plan = (narration: string) => ({
    schema_version: "studio.edit-plan/v1", episode_id: "x", narration, language: "vi", target_seconds: 20,
    shots: [
      { order: 1, shot_id: "s000-000", source_id: SRC, in: 0, out: 8, line_id: narration === "tts" ? "L001" : null, transition: "cut", section_title: "Mở đầu", note: "" },
      { order: 2, shot_id: "s000-002", source_id: SRC, in: 20, out: 30, line_id: null, transition: "dissolve", section_title: null, note: "", source_audio: "mute" },
    ],
    lines: narration === "tts" ? [{ line_id: "L001", text: "Chào mừng tới Tràng An." }] : [],
    texts: [{ text_id: "T001", kind: "title", text: "Tràng An", at_order: 1, offset_s: 0, duration: 3, position: "top_left" }],
    music_mood: null,
  });
  const writePlan = (narration: string) => writeFileSync(join(vdir, "edit-plan.json"), JSON.stringify(plan(narration)));
  const submitted: unknown[] = [];
  const farm: ProjectFarm = {
    submitJob: async (req) => {
      submitted.push(req.payload);
      const jobId = String(req.correlation_id).split("studio-job-tts-")[1];
      const out = `productions/${project.id}/jobs/tts/${jobId}/out/`;
      await w.bucket.put(`${out}tts.json`, Buffer.from(JSON.stringify({
        schema: "ag.studio.tts/v1", production_id: project.id, language: "vi", engine: { name: "fake", version: null },
        lines: [{ line_id: "L001", output: "tts/L001.wav", duration_s: 3.2, words: [{ word: "Chào", start: 0, end: 0.4 }] }],
      })));
      await w.bucket.put(`${out}tts/L001.wav`, Buffer.from("RIFF-fake"));
      return { job: view({}), created: true };
    },
    getJob: async () => view({ status: "completed" }),
    cancelJob: async () => view({ status: "cancelled" }),
    ackJob: async () => view({ status: "completed" }),
  };
  const voiceDir = join(w.dir, "voice");
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "fit" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { fit: fitHandler({ db: w.db, bucket: w.bucket, farm, voiceDir, pollMs: 1 }) } });
  const run = async () => { await runner.tick(); await runner.idle(); };
  return { ...w, project, video, dir, vdir, writePlan, submitted, voiceDir, run };
}

const setVoice = (s: Awaited<ReturnType<typeof setup>>) => s.db.run("UPDATE projects SET voice = ? WHERE id = ?", [JSON.stringify({
  mode: "clone", reference: `library:studio/projects/${s.project.id}/voice/abc.wav`, reference_text: "Xin chào", speed: 1, origin: "own",
  source: { kind: "upload", filename: "v.wav" }, sha256: "abc", duration_s: 6, confirmed_by: "u", confirmed_at: NOW,
}), s.project.id]);

describe("timeline from the edit plan", () => {
  it("reads the narration on the farm in the project's voice, fits the picture to it, saves a revision and its snapshot", async () => {
    const s = await setup();
    await setVoice(s);
    s.writePlan("tts");
    const job = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect(await getJob(s.db, job.id)).toMatchObject({ status: "done", error: null });
    expect(s.submitted[0]).toMatchObject({ production_id: s.project.id, language: "vi", voice: { reference: `library:studio/projects/${s.project.id}/voice/abc.wav` }, lines: [{ line_id: "L001", text: "Chào mừng tới Tràng An." }] });
    const rev = (await latestVideoRevision(s.db, s.video.id))!;
    expect(rev).toMatchObject({ revision: 1, label: "fit" });
    expect(rev.data).toMatchObject({ production_id: s.project.id, episode_id: s.video.id, canvas: { width: 1920, height: 1080 }, narration: { voice: "tts" } });
    expect(rev.data.clips[0]).toMatchObject({ asset_id: ASSET, line_id: "L001", section_title: "Mở đầu" });
    expect(rev.data.clips.some((c) => c.muted)).toBe(true);
    const snap = JSON.parse(readFileSync(join(s.vdir, "timeline.json"), "utf8"));
    expect(snap).toMatchObject({ revision: 1, label: "fit", timeline: { episode_id: s.video.id } });
    expect((await getJob(s.db, job.id))!.result).toMatchObject({ revision: 1, clips: rev.data.clips.length });
    // the same lines again are not read again
    await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect(s.submitted).toHaveLength(1);
    expect((await latestVideoRevision(s.db, s.video.id))!.revision).toBe(2);
  });

  it("two fits of a video at once both land, one revision on top of the other", async () => {
    const s = await setup();
    s.writePlan("none");
    const a = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    const b = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect([(await getJob(s.db, a.id))!.status, (await getJob(s.db, b.id))!.status]).toEqual(["done", "done"]);
    expect([((await getJob(s.db, a.id))!.result as { revision: number }).revision, ((await getJob(s.db, b.id))!.result as { revision: number }).revision].sort()).toEqual([1, 2]);
    expect((await latestVideoRevision(s.db, s.video.id))!.revision).toBe(2);
  });

  it("narration declined: the lines become subtitles, nothing is read", async () => {
    const s = await setup();
    await declineProjectNarration(s.db, s.project.id, "u");
    s.writePlan("tts");
    await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect(s.submitted).toEqual([]);
    expect((await latestVideoRevision(s.db, s.video.id))!.data.narration.voice).toBe("none");
  });

  it("says what is missing: no plan, a shot not in the video's sources", async () => {
    const s = await setup();
    const a = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect((await getJob(s.db, a.id))!.error).toContain("chưa có videos/");
    s.writePlan("none");
    const plan = JSON.parse(readFileSync(join(s.vdir, "edit-plan.json"), "utf8"));
    plan.shots[0].shot_id = "s000-009";
    writeFileSync(join(s.vdir, "edit-plan.json"), JSON.stringify(plan));
    const b = await queueFit(s.db, { projectId: s.project.id, videoId: s.video.id, createdBy: "u" }, NOW);
    await s.run();
    expect((await getJob(s.db, b.id))!.error).toContain("#1 s000-009");
    expect(existsSync(join(s.vdir, "timeline.json"))).toBe(false);
  });
});
