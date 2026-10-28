/**
 * Footage from someone's computer (feedback 2026-10-27 item 3): the file on the bucket, added to a video as an
 * `upload_asset` source and prepared into `inputs/<id>/` like an ag-go video — a video by the farm's `scan.prep` and
 * `studio.transcribe` (a fake farm here), a photo made into a clip with ffmpeg.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobOutputPrefix } from "@harness/executors";
import {
  addUploadedFootage, buildVideoIndex, createJob, createProject, createVideo, footageAt, footageMedia, getJob, getPrepared, JobStopped, newFootageKey,
  prepareHandler, queuePrepare, renderUsageEvents, seedWorkspace, sourceItems, studioLogger, sweepProjectAudio, type JobContext, type JobRecord,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { world } from "./helpers.js";

const NOW = "2026-10-28T08:00:00.000Z";

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });

async function setup() {
  const w = await world();
  opened.push(w);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?) ON CONFLICT DO NOTHING", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const ws = seedWorkspace(join(w.dir, "workspaces"), project);
  return { ...w, project, video, ws };
}

function fakeCtx(ws: string): JobContext {
  return {
    signal: new AbortController().signal, stopRequested: async () => null, checkpoint: async () => undefined,
    report: async () => undefined, setUnits: async () => undefined, workspaceDir: ws, tempDir: mkdtempSync(join(tmpdir(), "footage-job-")),
    logger: studioLogger({ test: "footage" }), now: () => NOW,
  };
}

/**
 * The farm: `scan.prep` answers two shots, their frames and sheet and a sound track; `studio.transcribe` one sentence.
 * `refuse` answers `scan.prep` as a farm that does not let Studio send it.
 */
function farm(bucket: Awaited<ReturnType<typeof world>>["bucket"], opts: { refuse?: boolean } = {}) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  return {
    sent,
    async submitJob(req: { type: string; payload: unknown; correlation_id: string }) {
      if (opts.refuse && req.type === "scan.prep") throw new Error("403 job type scan.prep not allowed for owner studio");
      const p = req.payload as Record<string, unknown>;
      sent.push({ type: req.type, payload: p });
      const [, stage, attempt] = /^studio-job-(.+)-([^-]+-[^-]+-[^-]+-[^-]+-[^-]+)$/.exec(req.correlation_id)!;
      const prod = req.type === "scan.prep" ? projectOf : String(p.production_id);
      const out = jobOutputPrefix(prod, stage!, attempt!);
      if (req.type === "scan.prep") {
        for (const f of ["frames/001.jpg", "frames/002.jpg", "sheets/01.jpg", "audio.wav"]) bucket.objects.set(`${out}${f}`, Buffer.from(f));
        bucket.objects.set(`${out}prep.json`, Buffer.from(JSON.stringify({
          schema: "ag.scan.prep/v1", asset_id: p.asset_id, media: { duration_s: 9.5, width: 3840, height: 2160, fps: 29.97, has_audio: true },
          scene: { threshold: 0.3, min_shot_s: 1, max_shot_s: 20 },
          shots: [{ n: 1, in: 0, out: 4, frame: "frames/001.jpg" }, { n: 2, in: 4, out: 9.5, frame: "frames/002.jpg" }],
          sheets: [{ file: "sheets/01.jpg", shots: [1, 2] }], audio: "audio.wav",
        })));
      } else {
        const sources = (p.sources as { source_id: string }[]).map((s) => ({
          source_id: s.source_id, language: "vi", alignment: "word",
          segments: [{ start: 0.5, end: 3, text: "Thuyền đi qua hang", words: [{ word: "Thuyền", start: 0.5, end: 1, score: 0.9 }, { word: "đi", start: 1, end: 1.3, score: 0.9 }] }],
        }));
        bucket.objects.set(`${out}transcribe.json`, Buffer.from(JSON.stringify({ schema: "ag.studio.transcribe/v1", production_id: prod, engine: { name: "whisperx", version: null }, sources })));
      }
      return { job: { id: `farm-${sent.length}`, status: "completed" } };
    },
    async getJob(id: string) { return { id, status: "completed", progress_percent: 100, node_id: null, error: null }; },
    async ackJob() { return {}; },
    async cancelJob() { return {}; },
  };
}
let projectOf = "";

async function uploaded(s: Awaited<ReturnType<typeof setup>>, name: string, body: Buffer) {
  const { key } = newFootageKey(s.project.id, name);
  await s.bucket.put(key, body);
  return addUploadedFootage(s.db, s.bucket, { projectId: s.project.id, videoId: s.video.id, key, name, addedBy: "u" }, NOW);
}

async function prepareJob(s: Awaited<ReturnType<typeof setup>>, assetId: string): Promise<JobRecord> {
  const q = await queuePrepare(s.db, { projectId: s.project.id, assetIds: [assetId], createdBy: "u" }, NOW);
  return (await getJob(s.db, (q[assetId] as { job_id: string }).job_id))!;
}

describe("footage uploaded from a computer", () => {
  it("knows a video from a photo by its extension, and only takes keys of the project's own footage", () => {
    expect(footageMedia("Hang Múa.MOV")).toBe("video");
    expect(footageMedia("đỉnh.jpeg")).toBe("image");
    expect(footageMedia("note.pdf")).toBeNull();
    const { assetId, key } = newFootageKey("p1", "A.MP4");
    expect(key).toBe(`library/studio/projects/p1/footage/${assetId}.mp4`);
    expect(footageAt("p1", key)).toEqual({ assetId, media: "video" });
    expect(footageAt("p2", key)).toBeNull();
    expect(footageAt("p1", "library/studio/projects/p1/footage/../music/x.mp4")).toBeNull();
    expect(footageAt("p1", "uploads/p1/0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11")).toBeNull();
  });

  it("adds the file the browser put on the bucket to the video; one that is not there, or not a footage key, is refused", async () => {
    const s = await setup();
    const src = await uploaded(s, "Hang Múa.mov", Buffer.from("movie"));
    expect(src).toMatchObject({ kind: "upload_asset", media_type: "video", label: "Hang Múa.mov", video_id: s.video.id });
    expect(src.meta).toMatchObject({ bytes: 5 });
    const missing = newFootageKey(s.project.id, "x.mp4").key;
    await expect(addUploadedFootage(s.db, s.bucket, { projectId: s.project.id, videoId: s.video.id, key: missing, name: "x.mp4", addedBy: "u" }))
      .rejects.toMatchObject({ details: { code: "upload_missing" } });
    await expect(addUploadedFootage(s.db, s.bucket, { projectId: s.project.id, videoId: s.video.id, key: `uploads/${s.project.id}/x`, name: "x.mp4", addedBy: "u" }))
      .rejects.toMatchObject({ details: { code: "upload_key" } });
    // it counts as footage of the video, not prepared yet
    const items = await sourceItems(s.db, s.project.id, { videoId: s.video.id });
    expect(items.find((i) => i.ref === src.ref)?.asset).toEqual({ state: "not_prepared" });
  });

  it("prepares a video on the farm: scan.prep reads it from the bucket, studio.transcribe reads its sound; the same files as an ag-go video", async () => {
    const s = await setup();
    projectOf = s.project.id;
    const src = await uploaded(s, "Hang Múa.mov", Buffer.from("movie"));
    const f = farm(s.bucket);
    const job = await prepareJob(s, src.ref);
    const out = await prepareHandler({ db: s.db, download: async () => undefined, uploads: { bucket: s.bucket, farm: f as never, pollMs: 1 } })(job, fakeCtx(s.ws));
    expect(f.sent.map((x) => x.type)).toEqual(["scan.prep", "studio.transcribe"]);
    expect(f.sent[0]!.payload).toEqual({ asset_id: src.ref, source: `library:studio/projects/${s.project.id}/footage/${src.ref}.mov` });
    expect(f.sent[1]!.payload).toMatchObject({ sources: [{ source_id: src.ref, audio: `stage:audio/${src.ref}.wav` }] });
    // the sound went up as the transcription's input
    expect(s.bucket.objects.has(`productions/${s.project.id}/jobs/transcribe/${job.id}/in/audio/${src.ref}.wav`)).toBe(true);

    const dir = join(s.ws, "inputs", src.ref);
    const shots = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8"));
    expect(shots).toMatchObject({ asset_id: src.ref, name: "Hang Múa.mov", duration_s: 9.5, width: 3840, has_audio: true, source: { kind: "upload", watermarked: false } });
    expect(shots.shots).toHaveLength(2);
    for (const file of ["frames/001.jpg", "frames/002.jpg", "sheets/01.jpg", "transcript.md", "README.md"]) expect(existsSync(join(dir, file))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")).segments[0].text).toBe("Thuyền đi qua hang");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Video tải từ máy");
    expect(await getPrepared(s.db, s.project.id, src.ref)).toMatchObject({ status: "ready", shots: 2, transcript: true, source_kind: "upload" });
    expect((await buildVideoIndex(s.db, s.ws, s.project.id, s.video.id)).sources).toMatchObject([{ asset_id: src.ref, status: "ready", name: "Hang Múa.mov" }]);
    expect(out.message).toContain("2 cảnh");
  });

  it("says what to change when the farm does not let Studio send scan.prep, and records the failure", async () => {
    const s = await setup();
    projectOf = s.project.id;
    const src = await uploaded(s, "A.mp4", Buffer.from("movie"));
    const job = await prepareJob(s, src.ref);
    await expect(prepareHandler({ db: s.db, download: async () => undefined, uploads: { bucket: s.bucket, farm: farm(s.bucket, { refuse: true }) as never, pollMs: 1 } })(job, fakeCtx(s.ws)))
      .rejects.toThrow(/scan\.prep vào loại việc của chủ job studio/);
    expect(await getPrepared(s.db, s.project.id, src.ref)).toMatchObject({ status: "failed" });
  });

  it.skipIf(!hasFfmpeg())("makes a photo into a short clip pushing in, kept beside it and rendered instead of it", async () => {
    const s = await setup();
    const photo = join(mkdtempSync(join(tmpdir(), "photo-")), "p.jpg");
    spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1200x900", "-frames:v", "1", photo]);
    const src = await uploaded(s, "đỉnh Múa.jpg", readFileSync(photo));
    expect(src.media_type).toBe("image");
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    const job = await prepareJob(s, src.ref);
    await prepareHandler({ db: s.db, download: async () => undefined, uploads: { bucket: s.bucket, farm: null, ffmpeg, ffprobe } })(job, fakeCtx(s.ws));
    const clipKey = `library/studio/projects/${s.project.id}/footage/${src.ref}.mp4`;
    expect(s.bucket.objects.get(clipKey)?.length).toBeGreaterThan(1000);
    const row = await s.db.get<{ meta: Record<string, unknown> }>("SELECT meta FROM project_sources WHERE id = ?", [src.id]);
    expect(row?.meta.clip_key).toBe(clipKey);
    const shots = JSON.parse(readFileSync(join(s.ws, "inputs", src.ref, "shots.json"), "utf8"));
    expect(shots).toMatchObject({ has_audio: false, width: 1920, height: 1440, source: { kind: "upload_image" } });
    expect(shots.duration_s).toBeCloseTo(6, 1);
    expect(shots.shots).toEqual([{ n: 1, in: 0, out: shots.duration_s, frame: "frames/001.jpg" }]);
    expect(existsSync(join(s.ws, "inputs", src.ref, "sheets", "01.jpg"))).toBe(true);
  }, 60_000);

  it("is not ag-go's: no usage event for it in a final render", async () => {
    const s = await setup();
    const src = await uploaded(s, "A.mp4", Buffer.from("movie"));
    const events = await renderUsageEvents(s.db, { id: "j1", project_id: s.project.id, created_by: "u" }, "render_final", s.video.id, [src.ref, "ag-go-asset-1"], NOW);
    expect(events.map((e) => e.assetId)).toEqual(["ag-go-asset-1"]);
  });

  it("is kept on the bucket while a source holds it, the photo's clip too; an upload never finished goes after the grace days", async () => {
    const s = await setup();
    const src = await uploaded(s, "A.mp4", Buffer.from("movie"));
    const kept = (src.meta as { key: string }).key;
    const clip = `library/studio/projects/${s.project.id}/footage/${src.ref}-clip.mp4`;
    await s.db.run("UPDATE project_sources SET meta = ? WHERE id = ?", [JSON.stringify({ ...src.meta, clip_key: clip }), src.id]);
    const orphan = newFootageKey(s.project.id, "never-finished.mov").key;
    for (const k of [clip, orphan]) await s.bucket.put(k, Buffer.from("x"));
    const old = new Date(Date.parse(NOW) - 30 * 86_400_000);
    for (const k of [kept, clip, orphan]) s.bucket.modified.set(k, old);
    expect(await sweepProjectAudio(s.db, s.bucket, new Date(Date.parse(NOW) - 7 * 86_400_000))).toBe(1);
    expect([...s.bucket.objects.keys()].sort()).toEqual([kept, clip].sort());
  });

  it("stops as a person asks, without marking the footage failed", async () => {
    const s = await setup();
    projectOf = s.project.id;
    const src = await uploaded(s, "A.mp4", Buffer.from("movie"));
    const job = await createJob(s.db, { projectId: s.project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: src.ref }, createdBy: "u" }, NOW);
    const ctx = { ...fakeCtx(s.ws), stopRequested: async () => "cancelled" as const, checkpoint: async () => { throw new JobStopped("cancelled"); } };
    await expect(prepareHandler({ db: s.db, download: async () => undefined, uploads: { bucket: s.bucket, farm: farm(s.bucket) as never, pollMs: 1 } })((await getJob(s.db, job.id))!, ctx))
      .rejects.toBeInstanceOf(JobStopped);
    expect(await getPrepared(s.db, s.project.id, src.ref)).toBeUndefined();
  });
});
