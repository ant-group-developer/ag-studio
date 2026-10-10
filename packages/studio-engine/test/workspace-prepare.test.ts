/**
 * Preparing an ag-go video into `inputs/<asset>/` (job `prepare_asset`): the media part runs real ffmpeg on a
 * synthetic clip (skipped without ffmpeg + ffprobe; FFMPEG_PATH / FFPROBE_PATH may point at any build); the farm's
 * transcription is a fake that answers a `transcribe.json` in the bucket.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import {
  addSource, buildVideoIndex, createJob, createJobRunner, createProject, createThread, createVideo, getJob, getPrepared, inputReadme, listMessages, prepareHandler,
  savePrepared, seedWorkspace, studioLogger, transcriptMarkdown, videoIndexPath, writeVideoIndex, type PrepareDeps, type ProjectFarm,
} from "../src/index.js";
import { hasFfmpeg, makeSceneClip } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const NOW = "2026-10-10T08:00:00.000Z";
const ASSET = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";

function setup() {
  const w = world();
  w.db.run("INSERT OR IGNORE INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  const workspacesRoot = join(w.dir, "workspaces");
  const dir = seedWorkspace(workspacesRoot, project);
  return { ...w, project, workspacesRoot, ws: dir };
}

describe("video index", () => {
  it("lists a video's ag-go sources in the order picked, shots numbered for the video, not-yet-prepared ones marked", () => {
    const { db, project, ws } = setup();
    const video = createVideo(db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
    addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: "asset-b", mediaType: "video", label: "B", addedBy: "u" }, NOW);
    addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "A", addedBy: "u" }, "2026-10-10T08:01:00.000Z");
    savePrepared(db, {
      project_id: project.id, asset_id: "asset-b", status: "failed", name: "B.mp4", duration_s: null, width: null, height: null, has_audio: null, shots: null,
      transcript: 0, source_kind: null, watermarked: null, error: "ag-go không trả được video",
    }, NOW);
    const index = writeVideoIndex(db, ws, project.id, video.id);
    expect(index.sources.map((s) => [s.index, s.asset_id, s.status, s.error])).toEqual([[0, "asset-b", "failed", "ag-go không trả được video"], [1, ASSET, "missing", null]]);
    expect(JSON.parse(readFileSync(join(ws, videoIndexPath(video.id)), "utf8"))).toEqual(index);
  });

  it("README and transcript read like a person wrote them", () => {
    const md = inputReadme({
      schema_version: "studio.input-shots/v1", asset_id: ASSET, name: "Hoa Lư 03.mp4", duration_s: 72.4, width: 854, height: 480, fps: 30, has_audio: true,
      source: { kind: "preview", watermarked: false }, scene: { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20 },
      shots: [{ n: 1, in: 0, out: 4.2, frame: "frames/001.jpg" }], sheets: [{ file: "sheets/01.jpg", shots: [1] }],
    }, null, "video không có tiếng", NOW, 3_145_728);
    expect(md).toContain("# Hoa Lư 03.mp4");
    expect(md).toContain("- Dài 1:12.4 · 854×480 · 30 fps · có tiếng");
    expect(md).toContain("- Xem từ bản xem trước 854×480, 3.0 MB");
    expect(md).toContain("| 1 | 0:00.0 | 0:04.2 | 4.2 s | frames/001.jpg |");
    expect(transcriptMarkdown("A", {
      schema_version: "studio.input-transcript/v1", asset_id: ASSET, language: "vi", alignment: "word", engine: "whisperx", dropped: 1,
      segments: [{ start: 1.2, end: 4, text: " Chào mừng tới Hoa Lư ", words: [] }],
    })).toBe("# Lời thoại — A\n\nNgôn ngữ: vi · căn theo từng từ · whisperx · bỏ 1 câu nghe nhầm\n\n- [0:01.2–0:04.0] Chào mừng tới Hoa Lư\n");
  });
});

function farmView(over: Partial<FarmJobView>): FarmJobView {
  return {
    id: "00000000-0000-4000-8000-00000000f001", owner: "studio", type: "studio.transcribe", lane: "gpu", status: "queued", priority: 0,
    correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 0, max_attempts: 2, node_id: null, progress_percent: null,
    progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
  } as FarmJobView;
}

describe.skipIf(!hasFfmpeg())("prepare an ag-go video (needs ffmpeg + ffprobe)", () => {
  it("writes shots, frames, sheets, transcript and README into inputs/<asset>/, records it and tells the thread", async () => {
    const { db, bucket, project, workspacesRoot, ws, dir } = setup();
    const clip = join(mkdtempSync(join(tmpdir(), "prepare-")), "clip.mp4");
    makeSceneClip(clip, { seconds: 6, colors: ["red", "blue", "green"], cuts: [2, 4] });
    const video = createVideo(db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
    addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "Hoa Lư 03.mp4", addedBy: "u" }, NOW);
    const resolved: string[][] = [];
    let jobId = "";
    const farm: ProjectFarm = {
      submitJob: async (req) => {
        const manifest = {
          schema: "ag.studio.transcribe/v1", production_id: project.id, engine: { name: "whisperx", version: null },
          sources: [{ source_id: (req.payload as { sources: { source_id: string }[] }).sources[0]!.source_id, language: "vi", alignment: "segment",
            segments: [{ start: 0.5, end: 2, text: "Chào mừng tới Hoa Lư", words: [] }] }],
        };
        await bucket.put(`productions/${project.id}/jobs/prepare/${jobId}/out/transcribe.json`, Buffer.from(JSON.stringify(manifest)));
        return { job: farmView({}), created: true };
      },
      getJob: async () => farmView({ status: "completed" }),
      cancelJob: async () => farmView({ status: "cancelled" }),
      ackJob: async () => farmView({ status: "completed" }),
    };
    const deps: PrepareDeps = {
      db, ffmpeg: FFMPEG, ffprobe: FFPROBE,
      resolve: async (actAs, ids) => { resolved.push([actAs, ...ids]); return { items: [{ assetId: ASSET, url: "https://ag-go.test/a.mp4", sourceKind: "preview", watermarked: false }], missing: [] }; },
      download: async (_url, dest, _signal, onBytes) => { copyFileSync(clip, dest); onBytes(10, 10); },
      farm: { client: farm, bucket, pollMs: 1 },
    };
    const thread = createThread(db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW).id;
    const job = createJob(db, { projectId: project.id, videoId: video.id, threadId: thread, kind: "prepare_asset", title: "Chuẩn bị Hoa Lư 03.mp4", request: { asset_id: ASSET, name: "Hoa Lư 03.mp4" }, createdBy: "u" }, NOW);
    jobId = job.id;
    const runner = createJobRunner({ db, logger: studioLogger({ test: "prepare" }), workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: prepareHandler(deps) } });
    runner.tick();
    await runner.idle();
    expect(getJob(db, job.id)).toMatchObject({ status: "done", error: null });
    expect(resolved).toEqual([["auth0|owner", ASSET]]);
    const input = join(ws, "inputs", ASSET);
    const shots = JSON.parse(readFileSync(join(input, "shots.json"), "utf8"));
    expect(shots.shots.map((s: { n: number }) => s.n)).toEqual([1, 2, 3]);
    expect(readdirSync(join(input, "frames"))).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(readdirSync(join(input, "sheets"))).toEqual(["01.jpg"]);
    expect(readFileSync(join(input, "transcript.md"), "utf8")).toContain("- [0:00.5–0:02.0] Chào mừng tới Hoa Lư");
    expect(readFileSync(join(input, "README.md"), "utf8")).toContain("3 cảnh");
    expect(getPrepared(db, project.id, ASSET)).toMatchObject({ status: "ready", shots: 3, transcript: 1, has_audio: 1 });
    const index = buildVideoIndex(db, ws, project.id, video.id);
    expect(index.sources[0]).toMatchObject({ status: "ready", transcript: `inputs/${ASSET}/transcript.md` });
    expect(index.sources[0]!.shots.map((s) => s.shot_id)).toEqual(["s000-000", "s000-001", "s000-002"]);
    expect(existsSync(join(dir, "data", "job-runs", job.id))).toBe(false);
    expect(listMessages(db, thread).at(-1)!.text).toContain("Đã chuẩn bị **Hoa Lư 03.mp4**");
  });
});
