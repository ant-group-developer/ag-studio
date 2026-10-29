/**
 * Someone's media library (plan 2026-10-29 P1): files a person uploads stay on the bucket under them and serve any
 * project and any number of its videos; the project's look covers every video that has none of its own.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineV4 } from "@harness/contracts";
import {
  addMediaItem, addMediaToProject, createProject, createVideo, deleteMediaItem, getJob, getPrepared, importProjectMusic, latestVideoRevision, listMediaItems,
  listSources, mediaAt, mediaKindOf, mediaPrefix, newMediaKey, pickedLook, prepareHandler, projectAudioFiles, projectLookView, queuePrepare, referenceFile,
  referenceMedia, removeSource, renameMediaItem, saveVideoRevision, savePrepared, seedWorkspace, setFootageVideos, setProjectLook, setVideoOwnLook,
  studioLogger, sweepMediaLibrary, videoLookLines, videoLookView, type JobContext, type StudioBucket, type StudioDb,
} from "../src/index.js";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";
import { world } from "./helpers.js";

const NOW = "2026-10-29T08:00:00.000Z";
const OWNER = "auth0|owner";
const OTHER = "auth0|other";

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup() {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Hoa Lư", description: "", language: "vi", aspect: "16:9" }, OWNER, NOW);
  const v1 = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: OWNER }, NOW);
  const v2 = await createVideo(w.db, project.id, { title: "Hang Múa", createdBy: OWNER }, NOW);
  const root = join(w.dir, "workspaces");
  const ws = seedWorkspace(root, project);
  return { ...w, project, v1, v2, root, ws };
}

/** A file the browser put on the bucket and the item it became. */
async function upload(db: StudioDb, bucket: StudioBucket & { put(k: string, b: Buffer): Promise<void> }, name: string, body = Buffer.from("data"), owner = OWNER) {
  const { key } = newMediaKey(owner, name);
  await bucket.put(key, body);
  return addMediaItem(db, bucket, { ownerId: owner, key, name }, NOW);
}

function ctxFor(ws: string): JobContext {
  return {
    signal: new AbortController().signal, stopRequested: async () => null, checkpoint: async () => undefined,
    report: async () => undefined, setUnits: async () => undefined, workspaceDir: ws, tempDir: mkdtempSync(join(tmpdir(), "media-job-")),
    logger: studioLogger({ test: "media" }), now: () => NOW,
  };
}

describe("media library: items", () => {
  it("names a file's kind by its extension and keeps each owner's uploads under a folder of theirs", () => {
    expect(mediaKindOf("Hang Múa.MOV")).toBe("video");
    expect(mediaKindOf("đỉnh.jpeg")).toBe("image");
    expect(mediaKindOf("nhạc.M4A")).toBe("audio");
    expect(mediaKindOf("kịch bản.pdf")).toBeNull();
    expect(mediaPrefix(OWNER)).toMatch(/^library\/studio\/users\/auth0_owner-[0-9a-f]{10}\/media\/$/);
    expect(mediaPrefix("auth0_owner")).not.toBe(mediaPrefix(OWNER));
    const { mediaId, key, kind } = newMediaKey(OWNER, "A.MP4");
    expect(kind).toBe("video");
    expect(key).toBe(`${mediaPrefix(OWNER)}${mediaId}.mp4`);
    expect(mediaAt(OWNER, key)).toEqual({ mediaId, kind: "video" });
    expect(mediaAt(OTHER, key)).toBeNull();
    expect(mediaAt(OWNER, `${mediaPrefix(OWNER)}../x.mp4`)).toBeNull();
    expect(() => newMediaKey(OWNER, "a.docx")).toThrow(/Chưa nhận loại file/);
  });

  it("takes the file the browser put; the same key again is the same item; a missing, foreign or too large one is refused", async () => {
    const s = await setup();
    const item = await upload(s.db, s.bucket, "Hang Múa.mov", Buffer.from("movie"));
    expect(item).toMatchObject({ owner_id: OWNER, kind: "video", name: "Hang Múa.mov", bytes: 5, deleted_at: null });
    expect(await addMediaItem(s.db, s.bucket, { ownerId: OWNER, key: item.key, name: "x" }, NOW)).toMatchObject({ id: item.id, name: "Hang Múa.mov" });
    await expect(addMediaItem(s.db, s.bucket, { ownerId: OTHER, key: item.key, name: "x" })).rejects.toMatchObject({ details: { code: "upload_key" } });
    await expect(addMediaItem(s.db, s.bucket, { ownerId: OWNER, key: newMediaKey(OWNER, "y.mp4").key, name: "y" })).rejects.toMatchObject({ details: { code: "upload_missing" } });
    const big = newMediaKey(OWNER, "big.jpg").key;
    await s.bucket.put(big, Buffer.alloc(51 * 1024 * 1024));
    await expect(addMediaItem(s.db, s.bucket, { ownerId: OWNER, key: big, name: "big.jpg" })).rejects.toMatchObject({ details: { code: "file_too_large" } });
    expect(s.bucket.objects.has(big)).toBe(false);
  });

  it("lists the owner's items newest first, by kind and name, with the projects using them; renames", async () => {
    const s = await setup();
    const a = await upload(s.db, s.bucket, "sao băng.mp3");
    const b = await upload(s.db, s.bucket, "DJI_0112.mp4");
    await upload(s.db, s.bucket, "riêng.mp4", Buffer.from("x"), OTHER);
    await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [b.id], use: "footage", videoIds: [s.v1.id] });
    const all = await listMediaItems(s.db, OWNER);
    expect(all.total).toBe(2);
    expect(all.bytes).toBe(8);
    expect(all.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.items.find((i) => i.id === b.id)?.usedIn).toEqual([{ projectId: s.project.id, name: "Hoa Lư" }]);
    expect((await listMediaItems(s.db, OWNER, { kind: "audio" })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await listMediaItems(s.db, OWNER, { q: "dji" })).items.map((i) => i.id)).toEqual([b.id]);
    expect((await listMediaItems(s.db, OWNER, { q: "100%" })).items).toEqual([]);
    expect((await renameMediaItem(s.db, OWNER, a.id, "  Sao băng lofi.mp3 ")).name).toBe("Sao băng lofi.mp3");
    await expect(renameMediaItem(s.db, OTHER, a.id, "x")).rejects.toMatchObject({ details: { code: "media_not_found" } });
  });
});

describe("media library: in a project", () => {
  it("puts footage into several videos at once; the same again is the source already there; its file stays the item's", async () => {
    const s = await setup();
    const item = await upload(s.db, s.bucket, "IMG_4021.mov");
    const added = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id, s.v2.id] });
    expect(added.map((x) => x.video_id).sort()).toEqual([s.v1.id, s.v2.id].sort());
    for (const x of added) expect(x).toMatchObject({ kind: "upload_asset", ref: item.id, media_id: item.id, media_type: "video", meta: { key: item.key, bytes: 4 } });
    const again = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id] });
    expect(again[0]!.id).toBe(added.find((x) => x.video_id === s.v1.id)!.id);
    expect(await listSources(s.db, s.project.id)).toHaveLength(2);
  });

  it("refuses someone else's item, audio as footage, a picture as audio, a video of another project", async () => {
    const s = await setup();
    const song = await upload(s.db, s.bucket, "a.mp3");
    const theirs = await upload(s.db, s.bucket, "b.mp4", Buffer.from("x"), OTHER);
    const photo = await upload(s.db, s.bucket, "c.jpg");
    await expect(addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [theirs.id], use: "footage" })).rejects.toMatchObject({ details: { code: "media_not_found" } });
    await expect(addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [song.id], use: "footage" })).rejects.toMatchObject({ details: { code: "wrong_use" } });
    await expect(addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [photo.id], use: "audio" })).rejects.toMatchObject({ details: { code: "wrong_use" } });
    await expect(addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [photo.id], use: "reference" })).rejects.toMatchObject({ details: { code: "not_video" } });
    const other = await createProject(s.db, "team-1", { name: "Khác", description: "", language: "vi", aspect: "16:9" }, OWNER, NOW);
    const foreign = await createVideo(s.db, other.id, { title: "x", createdBy: OWNER }, NOW);
    await expect(addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [photo.id], use: "footage", videoIds: [foreign.id] })).rejects.toMatchObject({ details: { code: "other_project" } });
  });

  it("names audio and reference videos like workspace files, never taken twice, with no file on the disk", async () => {
    const s = await setup();
    mkdirSync(join(s.ws, "context", "audio"), { recursive: true });
    writeFileSync(join(s.ws, "context", "audio", "nhạc.mp3"), "on disk");
    const a = await upload(s.db, s.bucket, "nhạc.mp3", Buffer.from("song"));
    const b = await upload(s.db, s.bucket, "nhạc.mp3", Buffer.from("song2"));
    const [first] = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [a.id], use: "audio", workspaceDir: s.ws });
    const [second] = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [b.id], use: "audio", workspaceDir: s.ws });
    expect([first!.ref, second!.ref]).toEqual(["context/audio/nhạc (2).mp3", "context/audio/nhạc (3).mp3"]);
    expect(first).toMatchObject({ kind: "upload", media_type: "audio", video_id: null, media_id: a.id, meta: { key: a.key, bytes: 4 } });
    expect(existsSync(join(s.ws, "context", "audio", "nhạc (2).mp3"))).toBe(false);
    expect((await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [a.id], use: "audio" }))[0]!.id).toBe(first!.id);

    const files = await projectAudioFiles(s.db, s.ws, s.project.id);
    expect(files.find((f) => f.path === first!.ref)).toMatchObject({ name: "nhạc.mp3", bytes: 4, key: a.key, sourceId: first!.id });
    expect(files.find((f) => f.path === "context/audio/nhạc.mp3")).toMatchObject({ key: null, sourceId: null });

    const clip = await upload(s.db, s.bucket, "mẫu.mp4", Buffer.from("reference"));
    const [ref] = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [clip.id], use: "reference" });
    expect(ref).toMatchObject({ ref: "context/references/mẫu.mp4", media_type: "video", meta: { key: clip.key, reference: true } });
    const onBucket = await referenceMedia(s.db, s.project.id);
    expect(referenceFile(s.ws, "context/references/mẫu.mp4", onBucket)).toEqual({ path: "context/references/mẫu.mp4", abs: null, key: clip.key, bytes: 9 });
    expect(() => referenceFile(s.ws, "context/references/khác.mp4", onBucket)).toThrow(/không có file này/);
  });

  it("sets exactly the videos a footage is in: adds the missing, removes the rest", async () => {
    const s = await setup();
    const v3 = await createVideo(s.db, s.project.id, { title: "Bích Động", createdBy: OWNER }, NOW);
    const item = await upload(s.db, s.bucket, "a.mp4");
    await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id, s.v2.id] });
    expect((await setFootageVideos(s.db, { projectId: s.project.id, assetId: item.id, videoIds: [s.v2.id, v3.id], by: OWNER })).sort()).toEqual([s.v2.id, v3.id].sort());
    const rows = await listSources(s.db, s.project.id);
    expect(rows.map((r) => r.video_id).sort()).toEqual([s.v2.id, v3.id].sort());
    expect(rows.every((r) => r.media_id === item.id && (r.meta as { key: string }).key === item.key)).toBe(true);
    await expect(setFootageVideos(s.db, { projectId: s.project.id, assetId: "nope", videoIds: [], by: OWNER })).rejects.toMatchObject({ details: { code: "source_not_found" } });
  });

  it("copies footage another project prepared instead of preparing it again", async () => {
    const s = await setup();
    const item = await upload(s.db, s.bucket, "DJI_0087.mp4");
    // project A prepared it already
    const a = await createProject(s.db, "team-1", { name: "Đà Lạt", description: "", language: "vi", aspect: "16:9" }, OWNER, NOW);
    const wsA = seedWorkspace(s.root, a);
    mkdirSync(join(wsA, "inputs", item.id, "frames"), { recursive: true });
    writeFileSync(join(wsA, "inputs", item.id, "shots.json"), JSON.stringify({ asset_id: item.id, shots: [{ n: 1 }, { n: 2 }, { n: 3 }] }));
    writeFileSync(join(wsA, "inputs", item.id, "frames", "001.jpg"), "jpg");
    await savePrepared(s.db, {
      project_id: a.id, asset_id: item.id, status: "ready", name: "DJI_0087.mp4", duration_s: 12, width: 1920, height: 1080, has_audio: true, shots: 3,
      transcript: false, source_kind: "upload", watermarked: false, error: null,
    }, NOW);

    await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id] });
    const q = await queuePrepare(s.db, { projectId: s.project.id, assetIds: [item.id], createdBy: OWNER }, NOW);
    const job = (await getJob(s.db, (q[item.id] as { job_id: string }).job_id))!;
    // no farm and no bucket: only a copy can do it
    const out = await prepareHandler({ db: s.db, download: async () => undefined })(job, ctxFor(s.ws));
    expect(out.message).toContain("không phải chuẩn bị lại");
    expect(readFileSync(join(s.ws, "inputs", item.id, "frames", "001.jpg"), "utf8")).toBe("jpg");
    expect(await getPrepared(s.db, s.project.id, item.id)).toMatchObject({ status: "ready", shots: 3, duration_s: 12, source_kind: "upload" });
  });
});

describe("media library: deleting", () => {
  it("refuses an item a project uses, saying where; once removed there it goes, its file after the grace days", async () => {
    const s = await setup();
    const item = await upload(s.db, s.bucket, "a.mp4");
    const kept = await upload(s.db, s.bucket, "b.mp3");
    const [src] = await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id] });
    await expect(deleteMediaItem(s.db, OWNER, item.id)).rejects.toMatchObject({ code: "conflict", details: { code: "media_in_use", projects: [{ projectId: s.project.id, name: "Hoa Lư" }] } });
    await removeSource(s.db, src!.id, OWNER);
    await deleteMediaItem(s.db, OWNER, item.id, NOW);
    expect((await listMediaItems(s.db, OWNER)).items.map((i) => i.id)).toEqual([kept.id]);

    const orphan = newMediaKey(OWNER, "never-finished.mov").key;
    await s.bucket.put(orphan, Buffer.from("x"));
    const old = new Date(Date.parse(NOW) - 30 * 86_400_000);
    for (const k of [item.key, kept.key, orphan]) s.bucket.modified.set(k, old);
    // within the grace days the deleted item's file stays (it could be a mistake); the orphan goes
    expect(await sweepMediaLibrary(s.db, s.bucket, new Date(Date.parse(NOW) - 86_400_000))).toBe(1);
    expect(s.bucket.objects.has(item.key)).toBe(true);
    expect(await sweepMediaLibrary(s.db, s.bucket, new Date(Date.parse(NOW) + 86_400_000))).toBe(1);
    expect([...s.bucket.objects.keys()]).toEqual([kept.key]);
    expect(await s.db.get("SELECT id FROM media_items WHERE id = ?", [item.id])).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg())("media library: audio from the bucket (needs ffmpeg + ffprobe)", () => {
  it("music made of a library file brought down from the bucket", async () => {
    const s = await setup();
    const wav = join(mkdtempSync(join(tmpdir(), "media-audio-")), "nhac.wav");
    makeWav(wav, 6, { frequency: 330 });
    const item = await upload(s.db, s.bucket, "nhạc.wav", readFileSync(wav));
    const d = { db: s.db, bucket: s.bucket, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" };
    const music = await importProjectMusic(d, { projectId: s.project.id, files: [{ key: item.key, filename: "nhạc.wav" }] });
    expect(music).toMatchObject({ track: expect.stringMatching(/^library:studio\/projects\/.+\/music\/[0-9a-f]{64}\.m4a$/), source: { kind: "upload", filename: "nhạc.wav" } });
    expect(music.duration_s).toBeCloseTo(6, 0);
    await expect(importProjectMusic(d, { projectId: s.project.id, files: [{ key: `${item.key}.gone`, filename: "mất.wav" }] })).rejects.toThrow(/không còn file mất\.wav/);
  }, 60_000);

  it("a photo's clip is kept beside the library item, for every project", async () => {
    const s = await setup();
    const photo = join(mkdtempSync(join(tmpdir(), "media-photo-")), "p.jpg");
    spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x600", "-frames:v", "1", photo]);
    const item = await upload(s.db, s.bucket, "cổng.jpg", readFileSync(photo));
    await addMediaToProject(s.db, { projectId: s.project.id, ownerId: OWNER, mediaIds: [item.id], use: "footage", videoIds: [s.v1.id, s.v2.id] });
    const q = await queuePrepare(s.db, { projectId: s.project.id, assetIds: [item.id], createdBy: OWNER }, NOW);
    const job = (await getJob(s.db, (q[item.id] as { job_id: string }).job_id))!;
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    await prepareHandler({ db: s.db, download: async () => undefined, uploads: { bucket: s.bucket, farm: null, ffmpeg, ffprobe } })(job, ctxFor(s.ws));
    const clipKey = item.key.replace(/\.jpg$/, ".clip.mp4");
    expect(s.bucket.objects.get(clipKey)?.length).toBeGreaterThan(1000);
    expect(await s.db.get("SELECT clip_key FROM media_items WHERE id = ?", [item.id])).toEqual({ clip_key: clipKey });
    for (const r of await listSources(s.db, s.project.id)) expect((r.meta as { clip_key: string }).clip_key).toBe(clipKey);
    // another project adding it later starts with the clip
    const b = await createProject(s.db, "team-1", { name: "B", description: "", language: "vi", aspect: "16:9" }, OWNER, NOW);
    const [src] = await addMediaToProject(s.db, { projectId: b.id, ownerId: OWNER, mediaIds: [item.id], use: "footage" });
    expect((src!.meta as { clip_key: string }).clip_key).toBe(clipKey);
  }, 60_000);
});

describe("the project's look", () => {
  const timeline = (videoId: string): TimelineV4 => ({
    schema_version: "studio.timeline/v4", production_id: "p", episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30,
    language: "vi", edit_style: "cut",
    clips: [{ clip_id: "C001", asset_id: "a1", section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } }],
    texts: [], narration: { voice: "none", lead_seconds: 0.3, lines: [] }, captions: { mode: "none" },
    music: null, source_audio: { muted: false },
    assets: { a1: { title: "Phố", summary_vi: "…", duration_s: 10, orientation: "landscape" } }, alternates: [],
  });
  const warm = { text_look: null, look: "warm" as const, color_match: true };

  it("covers every video without its own pick, below the video's and above the plan's", async () => {
    const s = await setup();
    await setProjectLook(s.db, { workspaceDir: s.ws, projectId: s.project.id, look: warm, authorId: OWNER, now: NOW });
    await setVideoOwnLook(s.db, s.v2.id, { text_look: null, look: "vivid", color_match: null }, NOW);
    expect((await videoLookView(s.db, s.ws, s.v1.id)).effective).toMatchObject({ look: "warm", color_match: true, from: { look: "project", color_match: "project" } });
    expect((await videoLookView(s.db, s.ws, s.v2.id)).effective).toMatchObject({ look: "vivid", color_match: true, from: { look: "video", color_match: "project" } });
    expect(await pickedLook(s.db, s.v2.id)).toEqual({ text_look: null, look: "vivid", color_match: true });
    expect((await projectLookView(s.db, s.ws, s.project.id)).videos.map((v) => [v.title, v.ownLook])).toEqual([["Hang Múa", true], ["Tràng An", false]]);
    const lines = videoLookLines(null, warm);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Phong cách chung của dự án");
  });

  it("applied to all videos: their own picks go, and every latest timeline draws it", async () => {
    const s = await setup();
    for (const v of [s.v1, s.v2]) await saveVideoRevision(s.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: OWNER, label: "fit" });
    await setVideoOwnLook(s.db, s.v2.id, { text_look: null, look: "vivid", color_match: null }, NOW);
    const r = await setProjectLook(s.db, { workspaceDir: s.ws, projectId: s.project.id, look: warm, everyVideo: true, authorId: OWNER, now: NOW });
    expect(r.cleared).toEqual([s.v2.id]);
    expect(r.revisions.map((x) => x.videoId).sort()).toEqual([s.v1.id, s.v2.id].sort());
    for (const v of [s.v1, s.v2]) expect((await latestVideoRevision(s.db, v.id))!.data).toMatchObject({ look: "warm", color_match: true });
    expect((await videoLookView(s.db, s.ws, s.v2.id)).own).toEqual({ text_look: null, look: null, color_match: null });
  });
});
