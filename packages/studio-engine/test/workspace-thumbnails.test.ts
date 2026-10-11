import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimJob, createJob, createJobRunner, createProject, createVideo, finishJob, getJob, queueThumbnails, seedWorkspace, studioLogger, thumbnailHandler,
  thumbnailStyleOf, type ThumbnailRenderer,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const video = createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const calls: unknown[] = [];
  const renderer: ThumbnailRenderer = {
    extractFrame: async (v, t, out, size) => { calls.push(["frame", t, size]); writeFileSync(out, "jpg-frame"); void v; },
    compose: async (base, out, p) => { calls.push(["compose", p.lines, p.style]); copyFileSync(base, out); },
    normalize: async () => {},
  };
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "thumbs" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers: { thumbnail: thumbnailHandler({ db: w.db, bucket: w.bucket, renderer }) } });
  const run = async () => { runner.tick(); await runner.idle(); };
  return { ...w, project, video, dir, calls, run };
}

describe("thumbnails", () => {
  it("take the branding's look: position, case, colours", () => {
    const s = setup();
    mkdirSync(join(s.dir, "channel"), { recursive: true });
    writeFileSync(join(s.dir, "channel", "branding.md"), "---\ntext_look:\n  text_color: \"#FFE600\"\n  outline_color: \"#101010\"\n  box_color: null\n  size: m\nthumbnail:\n  position: top\n  text_case: sentence\n---\n# B\n");
    expect(thumbnailStyleOf(s.dir)).toEqual({ position: "top", size: "l", text_color: "#FFE600", outline_color: "#101010", box_color: null, uppercase: false });
    expect(thumbnailStyleOf(s.dir, { position: "center" }).position).toBe("center");
  });

  it("need a render; then cut frames from it, draw the words and list them in a README", async () => {
    const s = setup();
    const a = queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Tràng An" }], createdBy: "u" }, NOW);
    await s.run();
    expect(getJob(s.db, a.id)!.error).toContain("cần một bản render");
    const r = createJob(s.db, { projectId: s.project.id, videoId: s.video.id, kind: "render_preview", title: "r", request: {}, createdBy: "u" }, NOW);
    claimJob(s.db, ["render_preview"], NOW);
    finishJob(s.db, r.id, { status: "done", result: { kind: "render_preview", revision: 2, key: "k/preview.mp4", duration_s: 60, width: 1920, height: 1080, watermarked: false, size_bytes: 1, note: "" } }, NOW);
    await s.bucket.put("k/preview.mp4", Buffer.from("mp4"));
    queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Tràng An buổi sáng" }, { text: "Hang Sáng", at_seconds: 40 }], createdBy: "u" }, NOW);
    await s.run();
    expect(s.calls.filter((c) => (c as unknown[])[0] === "frame")).toEqual([["frame", 15, { width: 1280, height: 720 }], ["frame", 40, { width: 1280, height: 720 }]]);
    const tdir = join(s.dir, "videos", s.video.id, "thumbnails");
    expect(readFileSync(join(tdir, "01.jpg"), "utf8")).toBe("jpg-frame");
    expect(readFileSync(join(tdir, "README.md"), "utf8")).toContain('- `02.jpg`: "Hang Sáng" · khung ở giây 40.0 của bản xem trước (timeline bản 2)');
    // more later go next to them
    queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Lần 2" }], createdBy: "u" }, NOW);
    await s.run();
    expect(readFileSync(join(tdir, "README.md"), "utf8")).toContain("`03.jpg`");
  });
});
