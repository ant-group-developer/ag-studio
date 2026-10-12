/**
 * Watching reference videos (job `style_watch`, after a reference_download card): the fake yt-dlp "downloads" a 10 s
 * clip of 2 s scenes with ffmpeg; the job measures it, keeps contact sheets under research/style-<date>-<n>/ and
 * deletes the video. Needs ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJob, createJobRunner, createProject, getJob, noteYoutubeBlocked, seedWorkspace, studioLogger, styleWatchHandler, youtubeBlock, ytDlp,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const ROOT = resolve(__dirname, "..", "..", "..");
const NOW = "2026-10-10T08:00:00.000Z";

function setup(extraArgv: string[] = []) {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const ytdlp = ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs"), ...extraArgv], ffmpeg: FFMPEG });
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "style" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { style_watch: styleWatchHandler({ db: w.db, ytdlp, ffmpeg: FFMPEG, ffprobe: FFPROBE }) } });
  const run = async (videoIds: string[]) => {
    const job = createJob(w.db, { projectId: project.id, kind: "style_watch", title: "Học phong cách", request: { video_ids: videoIds, purpose: "nhịp dựng" }, createdBy: "u" });
    runner.tick();
    await runner.idle();
    return getJob(w.db, job.id)!;
  };
  const folder = () => join(dir, "research", `style-${new Date().toISOString().slice(0, 10)}-1`);
  return { ...w, project, dir, run, folder };
}

describe("reference videos YouTube will not give (no ffmpeg needed)", () => {
  it("YouTube blocking the server: stops at once, says so plainly with the code, never tries the other videos", async () => {
    const s = setup(["--fake-blocked"]);
    const job = await s.run(["U_17EqTHUIo", "U_17EqTHUIp", "U_17EqTHUIq"]);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/^YouTube đang chặn tải từ máy chủ Studio \(đòi đăng nhập để xác nhận không phải bot\)/);
    expect(job.error).not.toMatch(/cookies|github/);
    expect(JSON.parse(job.result!)).toEqual({ error_code: "youtube_blocked" });
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.youtube_blocked).toBe(true);
    expect(watch.videos.map((v: { code: string; skipped: boolean }) => [v.code, v.skipped])).toEqual([["youtube_blocked", true], ["youtube_blocked", true], ["youtube_blocked", true]]);
    expect(readFileSync(join(s.folder(), "README.md"), "utf8")).toContain("lỗi `youtube_blocked`");
    // Studio remembers it: the agent, the cards and the Queue are told
    expect(youtubeBlock(s.db, new Date().toISOString())).toMatchObject({ where: "studio" });
  });

  it("each video that cannot be had says why in a word; nothing watched is a failure naming each", async () => {
    const s = setup();
    const job = await s.run(["ERRgone0000", "PRIVate0000", "AGEcheck000", "LONGvideo00"]);
    expect(job.status).toBe("failed");
    expect(JSON.parse(job.result!)).toEqual({ error_code: "reference_failed" });
    expect(job.error).toContain("PRIVate0000: video riêng tư");
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { code: string }) => v.code)).toEqual(["unavailable", "private", "age_restricted", "too_long"]);
    expect(watch.videos.every((v: { skipped: boolean }) => !v.skipped)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg())("style from reference videos (needs ffmpeg + ffprobe)", () => {
  it("measures each video, keeps contact sheets and a README, never the video", async () => {
    const w = world();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
    const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const root = join(w.dir, "workspaces");
    const dir = seedWorkspace(root, project, NOW);
    const ytdlp = ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")], ffmpeg: FFMPEG });
    const job = createJob(w.db, { projectId: project.id, kind: "style_watch", title: "Học phong cách", request: { video_ids: ["U_17EqTHUIo", "ERRxxxxxxxx"], purpose: "nhịp dựng" }, createdBy: "u" });
    const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "style" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { style_watch: styleWatchHandler({ db: w.db, ytdlp, ffmpeg: FFMPEG, ffprobe: FFPROBE }) } });
    noteYoutubeBlocked(w.db, new Date().toISOString());
    runner.tick();
    await runner.idle();
    expect(getJob(w.db, job.id)).toMatchObject({ status: "done", error: null });
    expect(youtubeBlock(w.db, new Date().toISOString())).toBeNull(); // a download went through: not blocked any more
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
    const s = setup();
    const job = await s.run(["U_17EqTHUIo", "BOTblocked1", "U_17EqTHUIp"]);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!)).toMatchObject({ watched: 1, failed: 2, youtube_blocked: true });
    const watch = JSON.parse(readFileSync(join(s.folder(), "watch.json"), "utf8"));
    expect(watch.videos.map((v: { code: string | null; skipped: boolean }) => [v.code, v.skipped])).toEqual([[null, false], ["youtube_blocked", false], ["youtube_blocked", true]]);
    expect(readdirSync(s.folder()).some((f) => f.startsWith("R3-"))).toBe(false);
    expect(youtubeBlock(s.db, new Date().toISOString())).not.toBeNull();
  }, 120_000);
});
