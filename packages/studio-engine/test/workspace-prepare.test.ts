/**
 * Preparing an ag-go video into `inputs/<asset>/` (job `prepare_asset`, plan 2026-10-13 P3): ag-go's prep is a fake
 * answering `read` / `run` as `POST /footage/assets/prep(/run)` do; frames and sheets are "downloaded" from their URLs.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSource, buildVideoIndex, createJob, createJobRunner, createProject, createThread, createVideo, getJob, getPrepared, inputReadme, JobStopped, listMessages,
  prepareAsset, prepareHandler, retryBusy, savePrepared, seedWorkspace, studioLogger, transcriptMarkdown, videoIndexPath, writeVideoIndex,
  type AgGoPrepItem, type JobContext, type JobRecord, type PrepareDeps,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const ASSET = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });

async function setup() {
  const w = await world();
  opened.push(w);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?) ON CONFLICT DO NOTHING", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
  // ag-go serves the project the videos of the ag-go projects added to it
  await addSource(w.db, { projectId: project.id, kind: "ag_go_project", ref: "agp-1", mediaType: "mixed", label: "Ninh Bình", addedBy: "u" }, NOW);
  const workspacesRoot = join(w.dir, "workspaces");
  const dir = seedWorkspace(workspacesRoot, project);
  return { ...w, project, workspacesRoot, ws: dir };
}

type Prep = NonNullable<AgGoPrepItem["prep"]>;

/** A ready prep of three shots on one sheet, as ag-go answers it. */
function readyPrep(over: Partial<Prep> = {}): Prep {
  return {
    prepId: "prep-1", preparedAt: NOW, durationS: 6, width: 854, height: 480, fps: 25, hasAudio: true, sourceKind: "preview", watermarked: false,
    scene: { threshold: 0.3, minShotS: 1, maxShotS: 20 },
    shots: [1, 2, 3].map((n) => ({ n, in: (n - 1) * 2, out: n * 2, frame: `frames/00${n}.jpg`, url: `https://r2.test/frames/00${n}.jpg?sig` })),
    sheets: [{ file: "sheets/01.jpg", shots: [1, 2, 3], url: "https://r2.test/sheets/01.jpg?sig" }],
    transcriptStatus: "done",
    transcript: {
      language: "vi", alignment: "word", engine: "whisperx",
      segments: [
        { start: 0.5, end: 2, text: "Chào mừng tới Hoa Lư", words: [{ word: "Chào", start: 0.5, end: 0.9, score: 0.9 }, { word: "mừng", start: 0.9, end: 1.3, score: 0.8 }] },
        // what nobody said: dropped when Studio writes transcript.json
        { start: 3, end: 5, text: "Hãy đăng ký kênh", words: [{ word: "Hãy", start: 3, end: 3.5, score: 0.05 }] },
      ],
    },
    ...over,
  };
}

const item = (state: AgGoPrepItem["state"], over: Partial<AgGoPrepItem> = {}): AgGoPrepItem =>
  ({ assetId: ASSET, state, phase: null, progress: null, error: null, prep: null, ...over });

/** ag-go's preps (its trusted mode, within the projects given): `reads` answered in turn (the last one repeats), `run` answers `ran`. */
function fakePreps(reads: AgGoPrepItem[], ran: AgGoPrepItem = reads[0]!) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    read: async (projectIds: string[], ids: string[]) => { calls.push(`read ${projectIds.join(",")} ${ids.join(",")}`); return { items: [reads[Math.min(i++, reads.length - 1)]!] }; },
    run: async (projectIds: string[], ids: string[], by?: string) => { calls.push(`run ${projectIds.join(",")} ${ids.join(",")} by ${by}`); return { items: [ran] }; },
  };
}

const download: PrepareDeps["download"] = async (url, dest) => { writeFileSync(dest, `jpeg ${url}`); };

describe("video index", () => {
  it("lists a video's ag-go sources in the order picked, shots numbered for the video, not-yet-prepared ones marked", async () => {
    const { db, project, ws } = await setup();
    const video = await createVideo(db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
    await addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: "asset-b", mediaType: "video", label: "B", addedBy: "u" }, NOW);
    await addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "A", addedBy: "u" }, "2026-10-10T08:01:00.000Z");
    await savePrepared(db, {
      project_id: project.id, asset_id: "asset-b", status: "failed", name: "B.mp4", duration_s: null, width: null, height: null, has_audio: null, shots: null,
      transcript: false, source_kind: null, watermarked: null, error: "ag-go không trả được video",
    }, NOW);
    const index = await writeVideoIndex(db, ws, project.id, video.id);
    expect(index.sources.map((s) => [s.index, s.asset_id, s.status, s.error])).toEqual([[0, "asset-b", "failed", "ag-go không trả được video"], [1, ASSET, "missing", null]]);
    expect(JSON.parse(readFileSync(join(ws, videoIndexPath(video.id)), "utf8"))).toEqual(index);
  });

  it("README and transcript read like a person wrote them", () => {
    const md = inputReadme({
      schema_version: "studio.input-shots/v1", asset_id: ASSET, name: "Hoa Lư 03.mp4", duration_s: 72.4, width: 854, height: 480, fps: 30, has_audio: true,
      source: { kind: "preview", watermarked: false }, scene: { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20 },
      shots: [{ n: 1, in: 0, out: 4.2, frame: "frames/001.jpg" }], sheets: [{ file: "sheets/01.jpg", shots: [1] }],
    }, null, "video không có tiếng", NOW, "Kho Footage");
    expect(md).toContain("# Hoa Lư 03.mp4");
    expect(md).toContain("- Dài 1:12.4 · 854×480 · 30 fps · có tiếng");
    expect(md).toContain("- Cảnh, khung hình và lời thoại do Kho Footage chuẩn bị sẵn từ bản xem trước — chỉ để chọn cảnh");
    expect(md).toContain("| 1 | 0:00.0 | 0:04.2 | 4.2 s | frames/001.jpg |");
    expect(transcriptMarkdown("A", {
      schema_version: "studio.input-transcript/v1", asset_id: ASSET, language: "vi", alignment: "word", engine: "whisperx", dropped: 1,
      segments: [{ start: 1.2, end: 4, text: " Chào mừng tới Hoa Lư ", words: [] }],
    })).toBe("# Lời thoại — A\n\nNgôn ngữ: vi · căn theo từng từ · whisperx · bỏ 1 câu nghe nhầm\n\n- [0:01.2–0:04.0] Chào mừng tới Hoa Lư\n");
  });
});

describe("prepare a video ag-go has prepared", () => {
  it("writes shots, frames, sheets, transcript and README in the formats Studio reads, records it and tells the thread", async () => {
    const { db, project, workspacesRoot, ws, dir } = await setup();
    const video = await createVideo(db, project.id, { title: "Tràng An", createdBy: "u" }, NOW);
    await addSource(db, { projectId: project.id, videoId: video.id, kind: "ag_go_asset", ref: ASSET, mediaType: "video", label: "Hoa Lư 03.mp4", addedBy: "u" }, NOW);
    const preps = fakePreps([item("ready", { prep: readyPrep() })]);
    const urls: string[] = [];
    const deps: PrepareDeps = { db, preps, download: async (url, dest, signal) => { urls.push(url); await download(url, dest, signal); } };
    const thread = (await createThread(db, { projectId: project.id, videoId: video.id, kind: "video", title: "Tràng An", createdBy: "u" }, NOW)).id;
    const job = await createJob(db, { projectId: project.id, videoId: video.id, threadId: thread, kind: "prepare_asset", title: "Chuẩn bị Hoa Lư 03.mp4", request: { asset_id: ASSET, name: "Hoa Lư 03.mp4" }, createdBy: "u" }, NOW);
    const runner = createJobRunner({ db, logger: studioLogger({ test: "prepare" }), workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: prepareHandler(deps) } });
    await runner.tick();
    await runner.idle();
    expect(await getJob(db, job.id)).toMatchObject({ status: "done", error: null, units: null });
    // ready at ag-go: read only, never run again
    expect(preps.calls).toEqual([`read agp-1 ${ASSET}`]);
    expect(urls.sort()).toEqual(["https://r2.test/frames/001.jpg?sig", "https://r2.test/frames/002.jpg?sig", "https://r2.test/frames/003.jpg?sig", "https://r2.test/sheets/01.jpg?sig"]);
    const input = join(ws, "inputs", ASSET);
    expect(JSON.parse(readFileSync(join(input, "shots.json"), "utf8"))).toEqual({
      schema_version: "studio.input-shots/v1", asset_id: ASSET, name: "Hoa Lư 03.mp4", duration_s: 6, width: 854, height: 480, fps: 25, has_audio: true,
      source: { kind: "preview", watermarked: false }, scene: { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20 },
      shots: [{ n: 1, in: 0, out: 2, frame: "frames/001.jpg" }, { n: 2, in: 2, out: 4, frame: "frames/002.jpg" }, { n: 3, in: 4, out: 6, frame: "frames/003.jpg" }],
      sheets: [{ file: "sheets/01.jpg", shots: [1, 2, 3] }],
    });
    expect(readdirSync(join(input, "frames"))).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(readFileSync(join(input, "frames", "002.jpg"), "utf8")).toBe("jpeg https://r2.test/frames/002.jpg?sig");
    expect(readdirSync(join(input, "sheets"))).toEqual(["01.jpg"]);
    expect(JSON.parse(readFileSync(join(input, "transcript.json"), "utf8"))).toEqual({
      schema_version: "studio.input-transcript/v1", asset_id: ASSET, language: "vi", alignment: "word", engine: "whisperx", dropped: 1,
      segments: [{ start: 0.5, end: 2, text: "Chào mừng tới Hoa Lư", words: [{ word: "Chào", start: 0.5, end: 0.9, score: 0.9 }, { word: "mừng", start: 0.9, end: 1.3, score: 0.8 }] }],
    });
    expect(readFileSync(join(input, "transcript.md"), "utf8")).toContain("- [0:00.5–0:02.0] Chào mừng tới Hoa Lư");
    const readme = readFileSync(join(input, "README.md"), "utf8");
    expect(readme).toContain("3 cảnh");
    expect(readme).toContain("- Lời thoại: `transcript.md` (1 câu, ngôn ngữ vi).");
    expect(await getPrepared(db, project.id, ASSET)).toMatchObject({ status: "ready", shots: 3, transcript: true, has_audio: true, width: 854, source_kind: "preview", watermarked: false });
    const index = await buildVideoIndex(db, ws, project.id, video.id);
    expect(index.sources[0]).toMatchObject({ status: "ready", transcript: `inputs/${ASSET}/transcript.md` });
    expect(index.sources[0]!.shots.map((s) => s.shot_id)).toEqual(["s000-000", "s000-001", "s000-002"]);
    expect((await listMessages(db, thread)).at(-1)!.text).toContain("Đã chuẩn bị **Hoa Lư 03.mp4** (0:06.0): 3 cảnh");
  });

  it("keeps the shots when ag-go could not read what is said, and says why there is no transcript", async () => {
    const { db, project, workspacesRoot, ws, dir } = await setup();
    const deps: PrepareDeps = { db, preps: fakePreps([item("ready", { prep: readyPrep({ transcriptStatus: "failed", transcript: null }) })]), download, siteName: () => "Kho Footage" };
    const job = await createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET, name: "A.mp4" }, createdBy: "u" }, NOW);
    const runner = createJobRunner({ db, logger: studioLogger({ test: "prepare" }), workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: prepareHandler(deps) } });
    await runner.tick();
    await runner.idle();
    expect(await getJob(db, job.id)).toMatchObject({ status: "done" });
    expect(readdirSync(join(ws, "inputs", ASSET)).sort()).toEqual(["README.md", "frames", "sheets", "shots.json"]);
    expect(readFileSync(join(ws, "inputs", ASSET, "README.md"), "utf8")).toContain("- Lời thoại: Kho Footage chưa đọc được (lời thoại là phần thêm: cảnh vẫn dùng được).");
    expect(await getPrepared(db, project.id, ASSET)).toMatchObject({ status: "ready", transcript: false });
  });

  it("says when the video has no sound or nobody speaks", async () => {
    for (const [status, hasAudio, note] of [["none", false, "video không có tiếng"], ["skipped", true, "AG Go cho biết video không có lời nói"]] as const) {
      const { db, project, ws } = await setup();
      const job = await createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET }, createdBy: "u" }, NOW);
      const prep = readyPrep({ transcriptStatus: status, transcript: null, hasAudio });
      await prepareAsset({ db, preps: fakePreps([item("ready", { prep })]), download }, (await getJob(db, job.id))!, fakeCtx(ws).ctx);
      expect(readFileSync(join(ws, "inputs", ASSET, "README.md"), "utf8")).toContain(`- Lời thoại: ${note}.`);
    }
  });
});

/** A job context that records what the job reports; `stop()` stops the job as a person would. */
function fakeCtx(ws: string) {
  const reports: { phase?: string; progress?: number | null; waiting?: boolean }[] = [];
  const units: number[] = [];
  let stopped = false;
  const ac = new AbortController();
  const temp = mkdtempSync(join(tmpdir(), "prepare-job-"));
  mkdirSync(temp, { recursive: true });
  const ctx: JobContext = {
    signal: ac.signal, stopRequested: async () => (stopped ? "cancelled" : null), checkpoint: async () => { if (stopped) throw new JobStopped("cancelled"); },
    report: async (p) => { reports.push(p); }, setUnits: async (n) => { units.push(n); }, workspaceDir: ws, tempDir: temp,
    logger: studioLogger({ test: "prepare" }), now: () => NOW,
  };
  return { ctx, reports, units, stop: () => { stopped = true; ac.abort(); } };
}

describe("prepare a video ag-go has not prepared yet", () => {
  async function job(s: Awaited<ReturnType<typeof setup>>): Promise<JobRecord> {
    const j = await createJob(s.db, { projectId: s.project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET, name: "A.mp4", duration_s: 61 }, createdBy: "u" }, NOW);
    return (await getJob(s.db, j.id))!;
  }

  it("asks ag-go to run it, then waits, showing where it is, until it is ready", async () => {
    const s = await setup();
    const preps = fakePreps(
      [item("missing"), item("running", { phase: "cutting", progress: 0.5 }), item("running", { phase: "transcribing", progress: null }), item("ready", { prep: readyPrep() })],
      item("running", { phase: "queued" }),
    );
    const { ctx, reports, units } = fakeCtx(s.ws);
    const out = await prepareAsset({ db: s.db, preps, download, pollMs: 1 }, await job(s), ctx);
    expect(preps.calls).toEqual([`read agp-1 ${ASSET}`, `run agp-1 ${ASSET} by u`, `read agp-1 ${ASSET}`, `read agp-1 ${ASSET}`, `read agp-1 ${ASSET}`]);
    expect(units).toEqual([61]);
    const waits = reports.filter((r) => r.phase?.startsWith("Đang c") || r.phase?.startsWith("Đang đọc"));
    expect(waits.map((r) => [r.phase, r.progress, r.waiting])).toEqual([
      ["Đang chờ máy", 0.02, true], ["Đang cắt cảnh", 0.275, false], ["Đang đọc lời thoại", 0.5, false],
    ]);
    expect(out.message).toContain("3 cảnh");
    expect(await getPrepared(s.db, s.project.id, ASSET)).toMatchObject({ status: "ready", shots: 3 });
  });

  it("raises a prep waiting in ag-go's backfill (run), and fails with ag-go's error when it fails", async () => {
    const s = await setup();
    const preps = fakePreps([item("running", { phase: "queued" }), item("failed", { error: "scan.prep: không đọc được video" })], item("running", { phase: "queued" }));
    const deps: PrepareDeps = { db: s.db, preps, download, pollMs: 1 };
    const j = await job(s);
    const runner = createJobRunner({ db: s.db, logger: studioLogger({ test: "prepare" }), workspacesRoot: s.workspacesRoot, dataRoot: join(s.dir, "data"), handlers: { prepare_asset: prepareHandler(deps) } });
    await runner.tick();
    await runner.idle();
    expect(preps.calls.slice(0, 2)).toEqual([`read agp-1 ${ASSET}`, `run agp-1 ${ASSET} by u`]);
    expect(await getJob(s.db, j.id)).toMatchObject({ status: "failed", error: "AG Go không chuẩn bị được video này: scan.prep: không đọc được video" });
    expect(await getPrepared(s.db, s.project.id, ASSET)).toMatchObject({ status: "failed", error: "AG Go không chuẩn bị được video này: scan.prep: không đọc được video" });
  });

  it("tries ag-go again when it is busy (429/502/503/504), for the prep and every image", async () => {
    const s = await setup();
    const busy = (status: number) => Object.assign(new Error(`ag-go-api error: HTTP ${status}`), { status });
    const inner = fakePreps([item("ready", { prep: readyPrep() })]);
    let reads = 0;
    const preps = { ...inner, read: async (projectIds: string[], ids: string[]) => { if (reads++ < 2) throw busy(reads === 1 ? 503 : 429); return inner.read(projectIds, ids); } };
    const tries = new Map<string, number>();
    const flaky: PrepareDeps["download"] = async (url, dest, signal) => {
      tries.set(url, (tries.get(url) ?? 0) + 1);
      if (url.includes("002") && tries.get(url)! < 3) throw busy(502);
      await download(url, dest, signal);
    };
    const out = await prepareAsset({ db: s.db, preps, download: flaky, pollMs: 1, retryDelaysMs: [1, 1, 1] }, await job(s), fakeCtx(s.ws).ctx);
    expect(out.message).toContain("3 cảnh");
    expect(reads).toBe(3);
    expect(tries.get("https://r2.test/frames/002.jpg?sig")).toBe(3);
  });

  it("does not try again on a refusal, nor more than three times", async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    await expect(retryBusy(async () => { calls++; throw Object.assign(new Error("HTTP 403"), { status: 403 }); }, signal, [1, 1, 1])).rejects.toThrow("HTTP 403");
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryBusy(async () => { calls++; throw Object.assign(new Error("HTTP 503"), { status: 503 }); }, signal, [1, 1, 1])).rejects.toThrow("HTTP 503");
    expect(calls).toBe(4);
  });

  it("gives up after the longest wait", async () => {
    const s = await setup();
    const preps = fakePreps([item("running", { phase: "transcribing", progress: 0.2 })]);
    await expect(prepareAsset({ db: s.db, preps, download, pollMs: 1, maxWaitMs: 0 }, await job(s), fakeCtx(s.ws).ctx))
      .rejects.toThrow("AG Go chưa chuẩn bị xong video này sau 0 phút; thử lại sau");
  });

  it("stops waiting when the job is stopped, recording nothing", async () => {
    const s = await setup();
    const preps = fakePreps([item("running", { phase: "queued" })]);
    const { ctx, stop } = fakeCtx(s.ws);
    const j = await job(s);
    setTimeout(stop, 30);
    const started = Date.now();
    await expect(prepareHandler({ db: s.db, preps, download, pollMs: 60_000 })(j, ctx)).rejects.toBeInstanceOf(JobStopped);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await getPrepared(s.db, s.project.id, ASSET)).toBeUndefined();
  });
});

describe("prepare when ag-go does not serve the video", () => {
  it("fails when the project has no ag-go project, without asking ag-go", async () => {
    const { db, project, workspacesRoot, dir } = await setup();
    await db.run("DELETE FROM project_sources WHERE project_id = ?", [project.id]);
    const job = await createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET }, createdBy: "u" }, NOW);
    const preps = fakePreps([item("ready", { prep: readyPrep() })]);
    const runner = createJobRunner({ db, logger: studioLogger({ test: "prepare" }), workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: prepareHandler({ db, preps, download }) } });
    await runner.tick();
    await runner.idle();
    expect(await getJob(db, job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("dự án chưa có project AG Go nào") });
    expect(preps.calls).toEqual([]);
  });

  it("fails before any download, naming the library as ag-go calls itself", async () => {
    const { db, project, workspacesRoot, dir } = await setup();
    const job = await createJob(db, { projectId: project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET }, createdBy: "u" }, NOW);
    const notFound = Object.assign(new Error("ag-go-api error: HTTP 404"), { status: 404 });
    const deps: PrepareDeps = {
      db, siteName: () => "Kho Footage", download: async () => { throw new Error("not reached"); },
      preps: { read: async () => { throw notFound; }, run: async () => { throw notFound; } },
    };
    const runner = createJobRunner({ db, logger: studioLogger({ test: "prepare" }), workspacesRoot, dataRoot: join(dir, "data"), handlers: { prepare_asset: prepareHandler(deps) } });
    await runner.tick();
    await runner.idle();
    expect(await getJob(db, job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("video không thuộc project Kho Footage nào của dự án") });
  });

  it("refuses image paths that are not ag-go's frames or sheets", async () => {
    const s = await setup();
    const prep = readyPrep({ sheets: [{ file: "../../evil.jpg", shots: [1], url: "https://r2.test/x" }] });
    const j = await createJob(s.db, { projectId: s.project.id, kind: "prepare_asset", title: "Chuẩn bị", request: { asset_id: ASSET }, createdBy: "u" }, NOW);
    await expect(prepareAsset({ db: s.db, preps: fakePreps([item("ready", { prep })]), download }, (await getJob(s.db, j.id))!, fakeCtx(s.ws).ctx))
      .rejects.toThrow("AG Go trả về đường dẫn ảnh lạ: ../../evil.jpg");
  });
});
