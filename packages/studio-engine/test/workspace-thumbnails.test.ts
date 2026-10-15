import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimJob, createJob, createJobRunner, createProject, createVideo, finishJob, getJob, queueRenderFrames, queueThumbnails, seedWorkspace, studioLogger, thumbnailHandler,
  thumbnailStyleOf, type ThumbnailRenderer,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });
const open = async () => { const w = await world(); opened.push(w); return w; };

async function setup() {
  const w = await open();
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const calls: unknown[] = [];
  const renderer: ThumbnailRenderer = {
    extractFrame: async (v, t, out, size) => { calls.push(["frame", t, size]); writeFileSync(out, "jpg-frame"); void v; },
    compose: async (base, out, p) => { calls.push(["compose", p.lines, p.style]); copyFileSync(base, out); },
    normalize: async () => {},
  };
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "thumbs" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { thumbnail: thumbnailHandler({ db: w.db, bucket: w.bucket, renderer }) } });
  const run = async () => { await runner.tick(); await runner.idle(); };
  return { ...w, project, video, dir, calls, run };
}

describe("thumbnails", () => {
  it("take the branding's look: position, case, colours", async () => {
    const s = await setup();
    mkdirSync(join(s.dir, "channel"), { recursive: true });
    writeFileSync(join(s.dir, "channel", "branding.md"), "---\ntext_look:\n  text_color: \"#FFE600\"\n  outline_color: \"#101010\"\n  box_color: null\n  size: m\nthumbnail:\n  position: top\n  text_case: sentence\n---\n# B\n");
    expect(thumbnailStyleOf(s.dir)).toEqual({ position: "top", size: "l", text_color: "#FFE600", outline_color: "#101010", box_color: null, uppercase: false });
    expect(thumbnailStyleOf(s.dir, { position: "center" }).position).toBe("center");
  });

  it("need a render; then cut frames from it, draw the words and list them in a README", async () => {
    const s = await setup();
    const a = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Tràng An" }], createdBy: "u" }, NOW);
    await s.run();
    expect((await getJob(s.db, a.id))!.error).toContain("cần một bản render");
    const r = await createJob(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_preview", title: "r", request: {}, createdBy: "u" }, NOW);
    await claimJob(s.db, ["render_preview"], NOW);
    await finishJob(s.db, r.id, { status: "done", result: { kind: "render_preview", revision: 2, key: "k/preview.mp4", duration_s: 60, width: 1920, height: 1080, watermarked: false, size_bytes: 1, note: "" } }, NOW);
    await s.bucket.put("k/preview.mp4", Buffer.from("mp4"));
    await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Tràng An buổi sáng" }, { text: "Hang Sáng", at_seconds: 40 }], createdBy: "u" }, NOW);
    await s.run();
    expect(s.calls.filter((c) => (c as unknown[])[0] === "frame")).toEqual([["frame", 15, { width: 1280, height: 720 }], ["frame", 40, { width: 1280, height: 720 }]]);
    const tdir = join(s.dir, "videos", s.video.id, "thumbnails");
    expect(readFileSync(join(tdir, "01.jpg"), "utf8")).toBe("jpg-frame");
    expect(readFileSync(join(tdir, "README.md"), "utf8")).toContain('- `02.jpg`: "Hang Sáng" · khung ở giây 40.0 của bản xem trước (timeline bản 2)');
    // more later go next to them
    await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Lần 2" }], createdBy: "u" }, NOW);
    await s.run();
    expect(readFileSync(join(tdir, "README.md"), "utf8")).toContain("`03.jpg`");
  });

  it("render_frames cuts plain frames of the newest render at its own aspect into renders/frames", async () => {
    const s = await setup();
    const done = async (kind: "render_preview" | "render_final", revision: number, key: string, at: string) => {
      const r = await createJob(s.db, { projectId: s.project.id, videoId: s.video.id, kind, title: "r", request: {}, createdBy: "u" }, at);
      await claimJob(s.db, [kind], at);
      await finishJob(s.db, r.id, { status: "done", result: { kind, revision, key, duration_s: 803.3, width: 1080, height: 1920, watermarked: false, size_bytes: 1, note: "" } }, at);
      await s.bucket.put(key, Buffer.from("mp4"));
    };
    await done("render_final", 2, "k/final.mp4", "2026-10-10T08:00:00.000Z");
    await done("render_preview", 3, "k/preview.mp4", "2026-10-10T09:00:00.000Z");
    const many = Array.from({ length: 14 }, (_, i) => i * 60);
    const job = await queueRenderFrames(s.db, { projectId: s.project.id, videoId: s.video.id, atSeconds: [801.04, 801.0, 900, ...many], createdBy: "u" }, NOW);
    expect((job.request as { frames: number[] }).frames).toHaveLength(12);
    await s.run();
    const finished = (await getJob(s.db, job.id))!;
    expect(finished.status).toBe("done");
    const frames = s.calls.filter((c) => (c as unknown[])[0] === "frame");
    // no words drawn; the newest render (the preview), 960 wide at its 9:16 aspect; past the end is the last frame
    expect(s.calls.some((c) => (c as unknown[])[0] === "compose")).toBe(false);
    expect(frames.slice(0, 2)).toEqual([["frame", 801, { width: 960, height: 1706 }], ["frame", 803.2, { width: 960, height: 1706 }]]);
    const fdir = join(s.dir, "videos", s.video.id, "renders", "frames");
    expect(readFileSync(join(fdir, "r3-0801.0s.jpg"), "utf8")).toBe("jpg-frame");
    expect(finished.result).toMatchObject({ from: "render_preview", revision: 3, files: expect.arrayContaining([`videos/${s.video.id}/renders/frames/r3-0803.2s.jpg`]) });
  });
});
