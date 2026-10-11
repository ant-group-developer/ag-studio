/**
 * Watching reference videos (job `style_watch`, after a reference_download card): the fake yt-dlp "downloads" a 10 s
 * clip of 2 s scenes with ffmpeg; the job measures it, keeps contact sheets under research/style-<date>-<n>/ and
 * deletes the video. Needs ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJob, createJobRunner, createProject, getJob, seedWorkspace, studioLogger, styleWatchHandler, ytDlp,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const ROOT = resolve(__dirname, "..", "..", "..");
const NOW = "2026-10-10T08:00:00.000Z";

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
    runner.tick();
    await runner.idle();
    expect(getJob(w.db, job.id)).toMatchObject({ status: "done", error: null });
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
    expect(readFileSync(join(folder, "README.md"), "utf8")).toContain("| R2 |");
  }, 120_000);
});
