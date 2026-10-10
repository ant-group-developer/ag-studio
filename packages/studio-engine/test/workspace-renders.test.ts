/**
 * Renders of a project's video (P6): the job turns a timeline revision into a farm job under the project's keys,
 * keeps where the file landed, writes a note under videos/<id>/renders/, and a final render marks the video done.
 * The farm is a fake that answers the manifest in the memory bucket.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import {
  createJobRunner, createProject, createVideo, getJob, getVideo, queueRender, renderHandler, RENDER_KINDS, saveVideoRevision, seedWorkspace,
  studioLogger, videoRenders, type JobHandler, type JobKind, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

function timeline(videoId: string, over: Partial<TimelineV4> = {}): TimelineV4 {
  return {
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [{ clip_id: "C001", asset_id: "a1", section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } }],
    texts: [{ text_id: "T001", kind: "title", text: "Tràng An", start: 0, duration: 2, position: "top_left" }],
    narration: { voice: "none", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" }, music: null, source_audio: { muted: false },
    assets: { a1: { title: "Thuyền", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [], ...over,
  };
}

const view = (over: Partial<FarmJobView>): FarmJobView => ({
  id: "00000000-0000-4000-8000-00000000f0f0", owner: "studio", type: "studio.render_preview", lane: "gpu", status: "queued", priority: 0,
  correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 0, max_attempts: 2, node_id: null, progress_percent: null,
  progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
} as FarmJobView);

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const video = createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const submitted: { type: string; payload: Record<string, unknown>; requirements?: unknown }[] = [];
  const farm: ProjectFarm = {
    submitJob: async (req) => {
      const payload = req.payload as Record<string, unknown>;
      submitted.push({ type: req.type, payload, requirements: req.requirements });
      const stage = req.type === "studio.render_final" ? "render-final" : req.type === "studio.export_premiere" ? "premiere" : "render-preview";
      const jobId = String(req.correlation_id).split(`studio-job-${stage}-`)[1];
      const out = `productions/${project.id}/jobs/${stage}/${jobId}/out/`;
      const manifest = req.type === "studio.export_premiere"
        ? { schema: "ag.studio.premiere/v1", output: payload.output, size_bytes: 2_097_152, media: "proxy", files: [], warnings: ["1 font thay thế"] }
        : { schema: "ag.studio.render/v1", production_id: project.id, revision: 1, output: payload.output, width: 1920, height: 1080, duration_s: 64.5, size_bytes: 1000, watermarked: true, sources: [], warnings: [] };
      await w.bucket.put(`${out}${req.type === "studio.export_premiere" ? "premiere.json" : "render.json"}`, Buffer.from(JSON.stringify(manifest)));
      return { job: view({ type: req.type as never }), created: true };
    },
    getJob: async () => view({ status: "completed" }),
    cancelJob: async () => view({ status: "cancelled" }),
    ackJob: async () => view({ status: "completed" }),
  };
  const handlers = Object.fromEntries(RENDER_KINDS.map((k) => [k, renderHandler(k, { db: w.db, bucket: w.bucket, farm, voiceDir: join(w.dir, "voice"), pollMs: 1 })])) as Partial<Record<JobKind, JobHandler>>;
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "renders" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers });
  const run = async () => { runner.tick(); await runner.idle(); };
  return { ...w, project, video, dir, submitted, run };
}

describe("video renders", () => {
  it("a preview: composition uploaded under the project, preview job, result and a note to read", async () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const job = queueRender(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_preview", createdBy: "u" }, NOW);
    expect(job).toMatchObject({ title: "Render bản xem trước: Tràng An (bản 1)" });
    await s.run();
    const done = getJob(s.db, job.id)!;
    expect(done).toMatchObject({ status: "done", error: null });
    expect(s.submitted[0]).toMatchObject({ type: "studio.render_preview", payload: { production_id: s.project.id, revision: 1, composition: "stage:composition.json", output: `videos/${s.video.id}/previews/${job.id}.mp4` } });
    expect(s.bucket.objects.has(`productions/${s.project.id}/jobs/render-preview/${job.id}/in/composition.json`)).toBe(true);
    expect(s.db.get("SELECT job_type, is_final_render, stage_key FROM project_farm_jobs")).toEqual({ job_type: "studio.render_preview", is_final_render: 0, stage_key: "render-preview" });
    expect(videoRenders(s.db, s.project.id, s.video.id)[0]).toMatchObject({
      kind: "render_preview", revision: 1, key: `productions/${s.project.id}/jobs/render-preview/${job.id}/out/videos/${s.video.id}/previews/${job.id}.mp4`,
      duration_s: 64.5, watermarked: true,
    });
    const notes = readdirSync(join(s.dir, "videos", s.video.id, "renders"));
    expect(notes).toHaveLength(1);
    expect(readFileSync(join(s.dir, "videos", s.video.id, "renders", notes[0]!), "utf8")).toContain("Dài 1:05 · 1920×1080 · có watermark");
  });

  it("the final render is a final-media farm job on the chosen machine, and the video is done", async () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const node = "11111111-2222-4333-8444-555555555555";
    queueRender(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_final", request: { node_id: node }, createdBy: "u" }, NOW);
    await s.run();
    expect(s.submitted[0]).toMatchObject({ type: "studio.render_final", requirements: { node_id: node } });
    expect(s.db.get<{ f: number }>("SELECT is_final_render AS f FROM project_farm_jobs")!.f).toBe(1);
    expect(getVideo(s.db, s.video.id)!.status).toBe("done");
  });

  it("a Premiere export names the files after the videos and keeps the zip's key", async () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id), authorId: "u" });
    const job = queueRender(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "export_premiere", createdBy: "u" }, NOW);
    await s.run();
    expect(s.submitted[0]).toMatchObject({ type: "studio.export_premiere", payload: { episode_id: s.video.id, media: "proxy", name: "Tràng An", edit_style: "cut", media_names: { "asset:a1": "Thuyền" } } });
    expect(JSON.parse(getJob(s.db, job.id)!.result!)).toMatchObject({ kind: "export_premiere", size_bytes: 2_097_152, note: "1 font thay thế" });
  });

  it("a timeline with errors is not sent", async () => {
    const s = setup();
    saveVideoRevision(s.db, s.video.id, { baseRevision: 0, data: timeline(s.video.id, { assets: {} }), authorId: "u" });
    const job = queueRender(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_preview", createdBy: "u" }, NOW);
    await s.run();
    expect(getJob(s.db, job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("timeline bản 1 còn lỗi") });
    expect(s.submitted).toEqual([]);
    expect(existsSync(join(s.dir, "videos", s.video.id, "renders"))).toBe(false);
  });
});
