/** Job `image` (plan 2026-11-03 codex-imagegen P3): AI thumbnails and channel art, with a fake imager and renderer. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  channelArtPrompt, claimJob, CodexImageError, createJob, createJobRunner, createProject, createVideo, finishJob, getJob, imageHandler, queueChannelArt,
  queueThumbnails, seedWorkspace, studioLogger, thumbnailAiPrompt, thumbnailHandler, type CodexImager, type ThumbnailRenderer,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-11-03T08:00:00.000Z";

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });

async function setup(o: { imager?: "ok" | "rate" } = {}) {
  const w = await world();
  opened.push(w);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const video = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
  const calls: unknown[][] = [];
  const renderer: ThumbnailRenderer = {
    extractFrame: async (_v, t, out, size) => { calls.push(["frame", t, size]); writeFileSync(out, "jpg-frame"); },
    compose: async (base, out, p) => { calls.push(["compose", readFileSync(base, "utf8"), p.lines]); copyFileSync(base, out); },
    normalize: async (input, out, size) => { calls.push(["normalize", readFileSync(input, "utf8"), size]); writeFileSync(out, `cropped:${readFileSync(input, "utf8")}`); },
  };
  const imager: CodexImager = {
    version: async () => "codex-cli 0.0.0-fake",
    login: async () => "chatgpt",
    generate: async (r) => {
      calls.push(["generate", r.prompt, r.references?.map((p) => readFileSync(p, "utf8")) ?? [], r.transparentBackground ?? false]);
      if (o.imager === "rate") throw new CodexImageError({ code: "rate_limited", reason: "tài khoản ChatGPT đã hết hạn mức tạo ảnh, thử lại sau", detail: "usage limit" });
      writeFileSync(r.out, "ai-png");
      return { out: r.out, threadId: "thread-1", seconds: 41.5, usage: { input_tokens: 65553, cached_input_tokens: 52992, output_tokens: 718 } };
    },
  };
  const handlers = o.imager
    ? { thumbnail: thumbnailHandler({ db: w.db, bucket: w.bucket, renderer }), image: imageHandler({ db: w.db, bucket: w.bucket, renderer, imager }) }
    : { thumbnail: thumbnailHandler({ db: w.db, bucket: w.bucket, renderer }) };
  const runner = createJobRunner({ db: w.db, logger: studioLogger({ test: "images" }), workspacesRoot: root, dataRoot: join(w.dir, "data"), handlers });
  const run = async () => { await runner.tick(); await runner.idle(); };
  const render = async () => {
    const r = await createJob(w.db, { projectId: project.id, videoId: video.id, kind: "render_preview", title: "r", request: {}, createdBy: "u" }, NOW);
    await claimJob(w.db, ["render_preview"], NOW);
    await finishJob(w.db, r.id, { status: "done", result: { kind: "render_preview", revision: 2, key: "k/preview.mp4", duration_s: 60, width: 1920, height: 1080, watermarked: false, size_bytes: 1, note: "" } }, NOW);
    await w.bucket.put("k/preview.mp4", Buffer.from("mp4"));
  };
  return { ...w, project, video, dir, calls, run, render };
}

describe("AI thumbnails", () => {
  it("a thumbnail with a prompt is an image job; one without stays a plain thumbnail", async () => {
    const s = await setup();
    const plain = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "A", prompt: "  " }], createdBy: "u" }, NOW);
    expect(plain).toMatchObject({ kind: "thumbnail", request: { items: [{ text: "A" }] } });
    const ai = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "A" }, { text: "B", prompt: " golden hour " }], createdBy: "u" }, NOW);
    expect(ai).toMatchObject({ kind: "image", title: "Thumbnail AI: Tràng An", request: { target: "thumbnail", items: [{ text: "A" }, { text: "B", prompt: "golden hour" }] } });
  });

  it("the render's frame is edited by Codex, cropped to the thumbnail, then the words are drawn on it", async () => {
    const s = await setup({ imager: "ok" });
    await s.render();
    const job = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "Tràng An", at_seconds: 20, prompt: "make it golden hour" }], createdBy: "u" }, NOW);
    await s.run();
    expect((await getJob(s.db, job.id))!.status).toBe("done");
    const gen = s.calls.find((c) => c[0] === "generate")!;
    expect(gen[1]).toContain("make it golden hour");
    expect(gen[1]).toContain("a wide 16:9 landscape picture");
    expect(gen[1]).toContain("Keep the bottom third calm");
    expect(gen[2]).toEqual(["jpg-frame"]);
    expect(s.calls.find((c) => c[0] === "normalize")).toEqual(["normalize", "ai-png", { width: 1280, height: 720 }]);
    expect(s.calls.find((c) => c[0] === "compose")![1]).toBe("cropped:ai-png");
    const tdir = join(s.dir, "videos", s.video.id, "thumbnails");
    expect(readFileSync(join(tdir, "01.jpg"), "utf8")).toBe("cropped:ai-png");
    expect(readFileSync(join(tdir, "README.md"), "utf8")).toContain('- `01.jpg`: "Tràng An" · ảnh AI (ChatGPT) sửa từ khung ở giây 20.0 của bản xem trước (timeline bản 2) · prompt: "make it golden hour"');
    const call = await s.db.get<Record<string, unknown>>("SELECT * FROM llm_calls WHERE source = 'codex-image'");
    expect(call).toMatchObject({ run_id: job.id, skill: "thumbnail", model: "gpt-image-2", outcome: "ok", input_tokens: 65553, output_tokens: 718, cache_read_tokens: 52992, wall_seconds: 41.5, team_id: "team-1", user_id: "u" });
  });

  it("a quota hit fails the job saying so, and is kept in llm_calls", async () => {
    const s = await setup({ imager: "rate" });
    await s.render();
    const job = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "A", prompt: "p" }], createdBy: "u" }, NOW);
    await s.run();
    const failed = (await getJob(s.db, job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("hết hạn mức tạo ảnh");
    expect(await s.db.get("SELECT outcome FROM llm_calls WHERE source = 'codex-image'")).toEqual({ outcome: "failed" });
  });

  it("an image job waits for a worker with Codex", async () => {
    const s = await setup();
    await s.render();
    const job = await queueThumbnails(s.db, { projectId: s.project.id, videoId: s.video.id, items: [{ text: "A", prompt: "p" }], createdBy: "u" }, NOW);
    await s.run();
    expect((await getJob(s.db, job.id))!.status).toBe("queued");
  });

  it("the prompt leaves room where the words go, in the project's shape", () => {
    expect(thumbnailAiPrompt({ prompt: "p", position: "top", aspect: "9:16" })).toMatch(/tall 9:16 portrait.*No text.*Keep the top third calm/s);
  });
});

describe("channel art", () => {
  it("checks the references: pictures in the project only, at most three", async () => {
    const s = await setup();
    const q = (references: string[]) => queueChannelArt(s.db, { projectId: s.project.id, workspaceDir: s.dir, kind: "banner", prompt: "p", references, createdBy: "u" }, NOW);
    await expect(q(["context/missing.png"])).rejects.toThrow(/không có file này/);
    await expect(q(["CLAUDE.md"])).rejects.toThrow(/phải là .jpg/);
    await expect(q(["../x.png"])).rejects.toThrow();
    await expect(q(["a.png", "b.png", "c.png", "d.png"])).rejects.toThrow(/tối đa 3/);
  });

  it("a banner follows the logo and is cropped to 2560×1440; a logo stays a PNG, transparent when asked", async () => {
    const s = await setup({ imager: "ok" });
    mkdirSync(join(s.dir, "channel", "art"), { recursive: true });
    writeFileSync(join(s.dir, "channel", "art", "logo-01.png"), "old-logo");
    const banner = await queueChannelArt(s.db, { projectId: s.project.id, workspaceDir: s.dir, kind: "banner", prompt: "calm green", references: ["channel/art/logo-01.png"], transparent: true, createdBy: "u" }, NOW);
    expect(banner).toMatchObject({ kind: "image", video_id: null, request: { target: "channel_art", kind: "banner", transparent: false } });
    await s.run();
    expect(await getJob(s.db, banner.id)).toMatchObject({ status: "done", result: { files: ["channel/art/banner-01.jpg"] } });
    const gen = s.calls.find((c) => c[0] === "generate")!;
    expect(gen[1]).toContain("YouTube channel banner");
    expect(gen[2]).toEqual(["old-logo"]);
    expect(s.calls.find((c) => c[0] === "normalize")).toEqual(["normalize", "ai-png", { width: 2560, height: 1440 }]);

    const logo = await queueChannelArt(s.db, { projectId: s.project.id, workspaceDir: s.dir, kind: "logo", prompt: "a lotus", transparent: true, createdBy: "u" }, NOW);
    await s.run();
    expect(await getJob(s.db, logo.id)).toMatchObject({ status: "done", result: { files: ["channel/art/logo-02.png"] } });
    expect(readFileSync(join(s.dir, "channel", "art", "logo-02.png"), "utf8")).toBe("ai-png");
    expect(s.calls.filter((c) => c[0] === "generate").at(-1)![3]).toBe(true);
    const readme = readFileSync(join(s.dir, "channel", "art", "README.md"), "utf8");
    expect(readme).toContain('- `banner-01.jpg` (banner, 2560×1440) · theo `channel/art/logo-01.png` · prompt: "calm green"');
    expect(readme).toContain('- `logo-02.png` (logo, PNG nền trong suốt) · prompt: "a lotus"');
    expect(existsSync(join(s.dir, "channel", "art", "logo-01.png"))).toBe(true);
  });

  it("says the shape of each kind before the words", () => {
    expect(channelArtPrompt({ kind: "avatar", prompt: "a lotus", references: [] })).toMatch(/^A YouTube channel avatar.*a lotus$/);
    expect(channelArtPrompt({ kind: "art", prompt: "x", references: ["a.png"] })).toBe("x Follow the attached picture(s): keep their mark, colours and style unless the words above say otherwise.");
  });
});
