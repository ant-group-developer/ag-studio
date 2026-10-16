/**
 * Reference videos fetched by the farm's machines (P9, `studio.reference_fetch`): when a machine takes it, `style_watch`
 * hands each YouTube id to the farm instead of the Studio server's yt-dlp (YouTube bot-checks the server), records the
 * farm job like other steps, streams the video from the bucket, measures it and deletes both the bucket object and the
 * scratch file. A machine's refusal comes back with Studio's codes; a machine blocked by YouTube stops the rest and is
 * remembered for the farm, never as the server's block. The farm is a fake; no network.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView as FarmJobView } from "@ag-farm/protocol";
import {
  clearYoutubeBlocked, createJob, createJobRunner, createProject, FARM_BLOCKED_MESSAGE, getJob, MemoryBucket, noteYoutubeBlocked, referenceDownloadBlock,
  referenceFetchers, referenceFetchNodes, referenceRoute, seedWorkspace, studioLogger, styleWatchHandler, youtubeBlock, youtubeBlockLines, YtDlpError, ytDlp,
  type ProjectFarm, type YtDlp,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { world } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const ROOT = resolve(__dirname, "..", "..", "..");
const NOW = "2026-10-10T08:00:00.000Z";
const NODE_ID = "00000000-0000-4000-8000-0000000000a1";

const view = (over: Partial<FarmJobView>): FarmJobView => ({
  id: "00000000-0000-4000-8000-00000000f0f0", owner: "studio", type: "studio.reference_fetch", lane: "interactive", status: "queued", priority: 0,
  correlation_id: "c", affinity_key: null, group_key: null, attempt_count: 1, max_attempts: 2, node_id: null, progress_percent: null,
  progress_stage: null, result: null, error: null, created_at: NOW, updated_at: NOW, finished_at: null, acked_at: null, ...over,
} as FarmJobView);

/** The farm's error for an id, by its start (as the render worker classifies yt-dlp). */
function refusal(id: string): { code: string; message: string; retryable: boolean } | null {
  if (id.startsWith("BOT")) return { code: "youtube_blocked", message: "Sign in to confirm you're not a bot", retryable: false };
  if (id.startsWith("PRIV")) return { code: "private", message: "Private video", retryable: false };
  if (id.startsWith("ERR")) return { code: "unavailable", message: "Video unavailable", retryable: false };
  if (id.startsWith("NET")) return { code: "network", message: "Connection reset", retryable: true };
  if (id.startsWith("WEIRD")) return { code: "WORKER_ERROR", message: "upload failed", retryable: false };
  return null;
}

/** A yt-dlp that must not be used (the farm fetches), or answers each download with `answer`. */
function spyYtDlp(answer?: (id: string, dir: string) => Promise<string>): YtDlp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    version: async () => "fake",
    metadata: async (ids) => { calls.push(`metadata ${ids.join(",")}`); return new Map(); },
    listChannel: async () => { throw new Error("no"); },
    search: async () => [],
    download: async (id, dir) => {
      calls.push(`download ${id}`);
      if (!answer) throw new Error("Studio's yt-dlp should not download");
      return answer(id, dir);
    },
  };
}

const opened: Awaited<ReturnType<typeof world>>[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.db.close(); });
const open = async () => { const w = await world(); opened.push(w); return w; };

async function setup(o: { nodes?: { online: boolean; kinds: string[] }[]; ytdlp?: YtDlp | null; video?: () => Promise<Buffer> } = {}) {
  const w = await open();
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  const root = join(w.dir, "workspaces");
  const dir = seedWorkspace(root, project, NOW);
  const bucket = new MemoryBucket();
  const fetched: string[] = [];
  const getFile = bucket.getFile.bind(bucket);
  bucket.getFile = async (key, path) => { fetched.push(key); return getFile(key, path); };
  const submitted: { type: string; correlation_id: string; payload: Record<string, unknown>; requirements?: unknown }[] = [];
  const views = new Map<string, FarmJobView>();
  const phases: string[] = [];
  let jobId = "";
  const nodes = (o.nodes ?? [{ online: true, kinds: ["studio.render_preview", "studio.reference_fetch"] }])
    .map((n, i) => ({ id: i ? `00000000-0000-4000-8000-0000000000b${i}` : NODE_ID, name: i ? `PC-0${i + 1}` : "PC-01", gpus: [], running_jobs: 0, last_seen_at: NOW, ...n }));
  const farm: ProjectFarm = {
    listNodes: async () => ({ nodes }) as never,
    submitJob: async (req) => {
      const payload = req.payload as Record<string, unknown>;
      submitted.push({ type: req.type, correlation_id: req.correlation_id, payload, requirements: req.requirements });
      const id = `00000000-0000-4000-8000-${String(submitted.length).padStart(12, "0")}`;
      const attempt = req.correlation_id.replace("studio-job-reference_fetch-", "");
      const videoId = String(payload.video_id);
      const error = refusal(videoId);
      if (!error) {
        await bucket.put(`productions/${project.id}/jobs/reference_fetch/${attempt}/out/${String(payload.output)}`, o.video ? await o.video() : Buffer.from("not a video"));
      }
      views.set(id, error
        ? view({ id, status: "failed", node_id: NODE_ID, error })
        : view({
          id, status: "completed", node_id: NODE_ID, progress_percent: 100,
          result: { manifest: null, summary: { output: payload.output, ext: "mp4", duration_s: 10, size_bytes: 1234, width: 854, height: 480, title: `Video ${videoId}`, channel: "Kênh mẫu" } } as never,
        }));
      return { job: view({ id, status: "leased", node_id: NODE_ID, progress_percent: 40 }), created: true };
    },
    getJob: async (id) => { phases.push((await getJob(w.db, jobId))?.phase ?? ""); return views.get(id)!; },
    cancelJob: async (id) => views.get(id)!,
    ackJob: async (id) => views.get(id)!,
  };
  const ytdlp = o.ytdlp === undefined ? spyYtDlp() : o.ytdlp;
  const runner = createJobRunner({
    db: w.db, logger: studioLogger({ test: "reference-fetch" }), workspacesRoot: root, dataRoot: join(w.dir, "data"),
    handlers: { style_watch: styleWatchHandler({ db: w.db, ytdlp, ffmpeg: FFMPEG, ffprobe: FFPROBE, farm: { client: farm, bucket, fetchers: referenceFetchers(farm), pollMs: 1 } }) },
  });
  const run = async (videoIds: string[]) => {
    const job = await createJob(w.db, { projectId: project.id, kind: "style_watch", title: "Học phong cách", request: { video_ids: videoIds, purpose: "nhịp dựng" }, createdBy: "u" });
    jobId = job.id;
    await runner.tick();
    await runner.idle();
    return (await getJob(w.db, job.id))!;
  };
  const watch = () => JSON.parse(readFileSync(join(dir, "research", `style-${new Date().toISOString().slice(0, 10)}-1`, "watch.json"), "utf8"));
  const left = () => [...bucket.objects.keys()].filter((k) => k.includes("/jobs/reference_fetch/"));
  return { ...w, project, dir, bucket, farm, submitted, fetched, phases, ytdlp, run, watch, left };
}

describe("reference videos through the farm (no ffmpeg needed)", () => {
  it("a machine takes it: the farm job is recorded with its machine, the video comes from the bucket and is deleted", async () => {
    const s = await setup();
    await noteYoutubeBlocked(s.db, new Date().toISOString()); // YouTube blocks the server
    const job = await s.run(["U_17EqTHUIo"]);
    expect(s.submitted).toEqual([{
      type: "studio.reference_fetch", correlation_id: `studio-job-reference_fetch-${job.id}-r1`, requirements: { ytdlp: true },
      payload: { production_id: s.project.id, video_id: "U_17EqTHUIo", max_height: 480, max_seconds: 1800, max_bytes: 300 * 1024 * 1024, output: "reference/U_17EqTHUIo.mp4" },
    }]);
    expect(await s.db.get("SELECT job_id, job_type, stage_key, attempt_id FROM project_farm_jobs")).toEqual({
      job_id: job.id, job_type: "studio.reference_fetch", stage_key: "reference_fetch", attempt_id: `${job.id}-r1`,
    });
    expect(s.phases).toContain("Đang tải video mẫu 1/1 trên máy PC-01");
    expect(s.fetched).toEqual([`productions/${s.project.id}/jobs/reference_fetch/${job.id}-r1/out/reference/U_17EqTHUIo.mp4`]);
    expect(s.left()).toEqual([]); // never kept on the bucket
    expect((s.ytdlp as ReturnType<typeof spyYtDlp>).calls).toEqual([]); // the blocked server is not asked, not even for titles
    // the file was not a video, so nothing was measured; what the machine said is kept
    expect(s.watch().videos[0]).toMatchObject({ video_id: "U_17EqTHUIo", via: "farm", node: "PC-01", title: "Video U_17EqTHUIo", channel: "Kênh mẫu", code: "other" });
    // a farm fetch says nothing of the server: its block stays
    expect(await youtubeBlock(s.db, new Date().toISOString())).toMatchObject({ where: "studio" });
  });

  it("a machine YouTube blocks stops the rest, remembered for the farm and not as the server's block", async () => {
    const s = await setup();
    const job = await s.run(["BOTblocked1", "U_17EqTHUIp", "U_17EqTHUIq"]);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(FARM_BLOCKED_MESSAGE);
    expect(job.result).toEqual({ error_code: "youtube_blocked" });
    expect(s.submitted).toHaveLength(1);
    const watch = s.watch();
    expect(watch).toMatchObject({ youtube_blocked: true, blocked_where: "farm" });
    expect(watch.videos.map((v: { code: string; skipped: boolean }) => [v.code, v.skipped])).toEqual([["youtube_blocked", false], ["youtube_blocked", true], ["youtube_blocked", true]]);
    expect(watch.videos[0].error).toBe("YouTube đang chặn tải từ máy farm PC-01 (đòi đăng nhập để xác nhận không phải bot)");
    const now = new Date().toISOString();
    expect(await youtubeBlock(s.db, now, "farm")).toMatchObject({ where: "farm" });
    expect(await youtubeBlock(s.db, now)).toBeNull();
  });

  it("each refusal says why in Studio's words; anything else the farm says is kept", async () => {
    const s = await setup();
    const job = await s.run(["PRIVate0000", "ERRgone0000", "NETfail0000", "WEIRDcode00"]);
    expect(job.status).toBe("failed");
    expect(job.result).toEqual({ error_code: "reference_failed" });
    const videos = s.watch().videos as { code: string; error: string; skipped: boolean }[];
    expect(videos.map((v) => v.code)).toEqual(["private", "unavailable", "network", "other"]);
    expect(videos[0]!.error).toBe("video riêng tư");
    expect(videos[3]!.error).toBe("farm báo lỗi: upload failed");
    expect(s.submitted).toHaveLength(4);
    expect(s.left()).toEqual([]);
  });

  it("no machine takes it (offline, or without the kind): Studio's own yt-dlp as before", async () => {
    const yt = spyYtDlp(async () => { throw new YtDlpError({ code: "private", reason: "video riêng tư", detail: "" }); });
    const s = await setup({ nodes: [{ online: false, kinds: ["studio.reference_fetch"] }, { online: true, kinds: ["studio.render_preview"] }], ytdlp: yt });
    await s.run(["PRIVate0000"]);
    expect(s.submitted).toEqual([]);
    expect(yt.calls).toEqual(["metadata PRIVate0000", "download PRIVate0000"]);
    expect(s.watch().videos[0]).toMatchObject({ via: "studio", node: null, code: "private" });
  });

  it("only the farm remembered blocked and Studio has yt-dlp: the server downloads; no yt-dlp here: the farm still tries", async () => {
    const yt = spyYtDlp(async () => { throw new YtDlpError({ code: "private", reason: "video riêng tư", detail: "" }); });
    const s = await setup({ ytdlp: yt });
    await noteYoutubeBlocked(s.db, new Date().toISOString(), "farm");
    await s.run(["PRIVate0000"]);
    expect(s.submitted).toEqual([]);
    expect(yt.calls).toContain("download PRIVate0000");

    const t = await setup({ ytdlp: null });
    await noteYoutubeBlocked(t.db, new Date().toISOString(), "farm");
    await t.run(["PRIVate0000"]);
    expect(t.submitted).toHaveLength(1);
  });
});

describe("where a reference video goes, and what the agent is told", () => {
  it("the route and the block a card would meet", async () => {
    const { db } = await open();
    expect(await referenceRoute(db, NOW, 0)).toBe("studio");
    expect(await referenceRoute(db, NOW, 2)).toBe("farm");
    await noteYoutubeBlocked(db, NOW);
    expect(await referenceDownloadBlock(db, NOW, 0)).toMatchObject({ where: "studio" });
    expect(await referenceDownloadBlock(db, NOW, 1)).toBeNull(); // through the farm it works
    await noteYoutubeBlocked(db, NOW, "farm");
    expect(await referenceRoute(db, NOW, 1)).toBe("farm");
    expect(await referenceDownloadBlock(db, NOW, 1)).toMatchObject({ where: "farm" });
    await clearYoutubeBlocked(db); // the server's own clears only its own
    expect(await youtubeBlock(db, NOW, "farm")).not.toBeNull();
    expect(await referenceRoute(db, NOW, 1)).toBe("studio");
    expect(await referenceDownloadBlock(db, NOW, 1)).toBeNull();
  });

  it("machines that can fetch: online and taking the kind; a farm that does not answer counts none", async () => {
    expect(referenceFetchNodes([
      { name: "a", online: true, kinds: ["studio.reference_fetch"] }, { name: "b", online: false, kinds: ["studio.reference_fetch"] },
      { name: "c", online: true, kinds: ["studio.tts"] },
    ]).map((n) => n.name)).toEqual(["a"]);
    expect(await referenceFetchers({ listNodes: async () => { throw new Error("down"); } })()).toEqual([]);
    expect(await referenceFetchers({})()).toEqual([]);
  });

  it("the turn's context: blocked but a machine can fetch -> the card is fine; the farm blocked too -> not", () => {
    const studio = { blockedAt: "2026-10-10T08:00:00.000Z", until: "2026-10-10T14:00:00.000Z", where: "studio" as const };
    const farm = { ...studio, where: "farm" as const };
    const ok = youtubeBlockLines(studio, { fetchers: ["PC-01"] }).join(" ");
    expect(ok).toContain("máy farm (PC-01) vẫn tải được video mẫu");
    expect(ok).toContain("reference_download dùng được");
    expect(ok).not.toContain("Đừng đề xuất");
    const both = youtubeBlockLines(studio, { fetchers: ["PC-01"], farm }).join(" ");
    expect(both).toContain("và cả các máy farm");
    expect(both).toContain("Đừng đề xuất reference_download");
    expect(youtubeBlockLines(studio).join(" ")).toContain("không máy farm nào tải video mẫu thay được");
  });

});

describe.skipIf(!hasFfmpeg())("a reference video fetched by the farm, measured (needs ffmpeg + ffprobe)", () => {
  it("measured like a downloaded one, sheets kept, the video deleted from the bucket and the scratch folder", async () => {
    const made = join((await open()).dir, "made");
    mkdirSync(made, { recursive: true });
    const clip = await ytDlp({ argv: [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")], ffmpeg: FFMPEG }).download("U_17EqTHUIo", made);
    const s = await setup({ video: async () => readFileSync(clip) });
    const job = await s.run(["U_17EqTHUIo"]);
    expect(await getJob(s.db, job.id)).toMatchObject({ status: "done", error: null });
    const watch = s.watch();
    expect(watch.videos[0]).toMatchObject({ via: "farm", node: "PC-01", error: null, title: "Video U_17EqTHUIo" });
    expect(watch.videos[0].measured.cuts_per_minute).toBeGreaterThan(10);
    expect(s.left()).toEqual([]);
    const readme = readFileSync(join(s.dir, "research", `style-${new Date().toISOString().slice(0, 10)}-1`, "README.md"), "utf8");
    expect(readme).toContain("do máy farm tải ≤480p (PC-01)");
    expect(await youtubeBlock(s.db, new Date().toISOString(), "farm")).toBeNull();
  }, 120_000);
});
