/**
 * Watching reference videos (job `style_watch`, after a reference_download card or `style_from_files`): the fake
 * yt-dlp "downloads" a 10 s clip of 2 s scenes with ffmpeg; the job measures it, keeps contact sheets under
 * research/style-<date>-<n>/ and deletes the video — but never an uploaded one. Needs ffmpeg + ffprobe
 * (FFMPEG_PATH / FFPROBE_PATH) for the measuring.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJob, createJobRunner, createProject, getJob, noteYoutubeBlocked, seedWorkspace, studioLogger, styleWatchHandler, youtubeBlock, ytDlp,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const ROOT = resolve(__dirname, "..", "..", "..");
const NOW = "2026-10-10T08:00:00.000Z";

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });
const open = async () => { const w = await world(); opened.push(w); return w; };

async function setup(extraArgv: string[] | null = []) {
  const w = await open();
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const ytdlp = extraArgv ? ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs"), ...extraArgv], ffmpeg: FFMPEG }) : null;
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "style" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { style_watch: styleWatchHandler({ db: w.db, ytdlp, ffmpeg: FFMPEG, ffprobe: FFPROBE }) } });
  const run = async (videoIds: string[], files?: string[]) => {
    const job = await createJob(w.db, { projectId: project.id, kind: "style_watch", title: "Học phong cách", request: { video_ids: videoIds, ...(files ? { files } : {}), purpose: "nhịp dựng" }, createdBy: "u" });
    await runner.tick();
    await runner.idle();
    return (await getJob(w.db, job.id))!;
  };
  const folder = () => join(dir, "research", `style-${new Date().toISOString().slice(0, 10)}-1`);
  /** A 10 s clip of 2 s scenes uploaded to the project (made by the fake yt-dlp with ffmpeg). */
  const upload = async (name: string) => {
    const tmp = join(w.dir, "made");
    mkdirSync(tmp, { recursive: true });
    const made = await ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")], ffmpeg: FFMPEG }).download("U_17EqTHUIo", tmp);
    mkdirSync(join(dir, "context", "references"), { recursive: true });
    writeFileSync(join(dir, "context", "references", name), readFileSync(made));
    return `context/references/${name}`;
  };
  return { ...w, project, dir, run, folder, upload };
}

describe("reference videos YouTube will not give (no ffmpeg needed)", () => {
  it("YouTube blocking the server: stops at once, says so plainly with the code, never tries the other videos", async () => {
    const s = await setup(["--fake-blocked"]);
    const job = await s.run(["U_17EqTHUIo", "U_17EqTHUIp", "U_17EqTHUIq"]);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/^YouTube đang chặn tải từ máy chủ Studio \(đòi đăng nhập để xác nhận không phải bot\)/);
    expect(job.error).not.toMatch(/cookies|github/);
    expect((job.result)).toEqual({ error_code: "youtube_blocked" });
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.youtube_blocked).toBe(true);
    expect(watch.videos.map((v: { code: string; skipped: boolean }) => [v.code, v.skipped])).toEqual([["youtube_blocked", true], ["youtube_blocked", true], ["youtube_blocked", true]]);
    expect(readFileSync(join(s.folder(), "README.md"), "utf8")).toContain("lỗi `youtube_blocked`");
    // Studio remembers it: the agent, the cards and the Queue are told
    expect(await youtubeBlock(s.db, new Date().toISOString())).toMatchObject({ where: "studio" });
  });

  it("a worker without yt-dlp (or with reference downloads off) says so for YouTube videos", async () => {
    const s = await setup(null);
    const job = await s.run(["U_17EqTHUIo"]);
    expect(job.status).toBe("failed");
    expect((job.result)).toEqual({ error_code: "no_ytdlp" });
  });

  it("each video that cannot be had says why in a word; nothing watched is a failure naming each", async () => {
    const s = await setup();
    const job = await s.run(["ERRgone0000", "PRIVate0000", "AGEcheck000", "LONGvideo00"]);
    expect(job.status).toBe("failed");
    expect((job.result)).toEqual({ error_code: "reference_failed" });
    expect(job.error).toContain("PRIVate0000: video riêng tư");
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { code: string }) => v.code)).toEqual(["unavailable", "private", "age_restricted", "too_long"]);
    expect(watch.videos.every((v: { skipped: boolean }) => !v.skipped)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg())("style from reference videos (needs ffmpeg + ffprobe)", () => {
  it("measures each video, keeps contact sheets and a README, never the video", async () => {
    const w = await open();
    await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
    const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const root = join(w.dir, "workspaces");
    const dir = seedWorkspace(root, project, NOW);
    const ytdlp = ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")], ffmpeg: FFMPEG });
    const job = await createJob(w.db, { projectId: project.id, kind: "style_watch", title: "Học phong cách", request: { video_ids: ["U_17EqTHUIo", "ERRxxxxxxxx"], purpose: "nhịp dựng" }, createdBy: "u" });
    const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "style" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { style_watch: styleWatchHandler({ db: w.db, ytdlp, ffmpeg: FFMPEG, ffprobe: FFPROBE }) } });
    await noteYoutubeBlocked(w.db, new Date().toISOString());
    await runner.tick();
    await runner.idle();
    expect(await getJob(w.db, job.id)).toMatchObject({ status: "done", error: null });
    expect(await youtubeBlock(w.db, new Date().toISOString())).toBeNull(); // a download went through: not blocked any more
    const day = new Date().toISOString().slice(0, 10);
    const folder = join(dir, "research", `style-${day}-1`);
    const files = readdirSync(folder);
    expect(files).toContain("README.md");
    expect(files.some((f) => /^R1-sheet-01\.jpg$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith(".mp4"))).toBe(false);
    const watch = JSON.parse(readFileSync(join(folder, "watch.json"), "utf8"));
    expect(watch.videos[0]).toMatchObject({ video_id: "U_17EqTHUIo", title: "Fake video U_17EqTHUIo", error: null });
    expect(watch.videos[0].measured.cuts_per_minute).toBeGreaterThan(10);
    expect(watch.videos[1].error).toBeTruthy();
    expect(watch.videos[1]).toMatchObject({ code: "unavailable", error: "không còn trên YouTube (đã xoá, bị gỡ hoặc không tồn tại)" });
    expect(readFileSync(join(folder, "README.md"), "utf8")).toContain("| R2 |");
  }, 120_000);

  it("a bot check halfway: what was watched is kept, the videos after it are not tried", async () => {
    const s = await setup();
    const job = await s.run(["U_17EqTHUIo", "BOTblocked1", "U_17EqTHUIp"]);
    expect(job.status).toBe("done");
    expect((job.result)).toMatchObject({ watched: 1, failed: 2, youtube_blocked: true });
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { code: string | null; skipped: boolean }) => [v.code, v.skipped])).toEqual([[null, false], ["youtube_blocked", false], ["youtube_blocked", true]]);
    expect(readdirSync(s.folder()).some((f) => f.startsWith("R3-"))).toBe(false);
    expect(await youtubeBlock(s.db, new Date().toISOString())).not.toBeNull();
  }, 120_000);

  it("uploaded videos are measured the same way and left untouched; files that are not uploaded videos say why", async () => {
    const s = await setup(null);
    const path = await s.upload("Kênh mẫu.mp4");
    const before = statSync(join(s.dir, path));
    writeFileSync(join(s.dir, "context", "notes.md"), "# x");
    const job = await s.run([], [path, "context/notes.md", "inputs/a/clip.mp4"]);
    expect(job.status).toBe("done");
    expect(existsSync(join(s.dir, path))).toBe(true);
    expect(statSync(join(s.dir, path)).mtimeMs).toBe(before.mtimeMs);
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { label: string; file: string | null; code: string | null }) => [v.label, v.file, v.code])).toEqual([
      ["F1", path, null], ["F2", "context/notes.md", "not_video"], ["F3", "inputs/a/clip.mp4", "not_context"],
    ]);
    expect(watch.videos[0].measured.cuts_per_minute).toBeGreaterThan(10);
    expect(readdirSync(s.folder()).some((f) => /^F1-sheet-01\.jpg$/.test(f))).toBe(true);
    expect(readFileSync(join(s.folder(), "README.md"), "utf8")).toContain("`context/references/Kênh mẫu.mp4` (tải lên)");
  }, 120_000);

  it("YouTube blocked but an uploaded video given: the upload is watched, the job is done and says what to do instead", async () => {
    const s = await setup(["--fake-blocked"]);
    const path = await s.upload("mau.mp4");
    const job = await s.run(["U_17EqTHUIo", "U_17EqTHUIp"], [path]);
    expect(job.status).toBe("done");
    expect((job.result)).toMatchObject({ watched: 1, failed: 2, youtube_blocked: true });
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { label: string; code: string | null; skipped: boolean }) => [v.label, v.code, v.skipped])).toEqual([
      ["F1", null, false], ["R1", "youtube_blocked", true], ["R2", "youtube_blocked", true],
    ]);
  }, 120_000);
});
