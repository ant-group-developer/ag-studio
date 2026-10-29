/**
 * Learning an edit style from reference videos (spec 2026-10-10 agent-workspace §P6, job `style_watch`): videos people
 * uploaded to the project (`context/…`, the agent's `style_from_files`, no card: nothing leaves Studio) and YouTube
 * videos (after a person confirmed a `reference_download` card: downloaded at ≤480p into a scratch folder). Each is
 * measured the same way (scene changes: shot lengths, cuts per minute, the opening), its frames kept and tiled into
 * contact sheets under `research/style-<date>-<n>/`. A downloaded video is deleted once measured; an uploaded one is
 * the person's file and is never touched. The agent reads the README and the sheets and writes `channel/style.md`.
 *
 * A YouTube video that cannot be had says why with a code (`yt-dlp.ts`, `YtFailureCode`). YouTube refusing the server
 * itself (`youtube_blocked`, the bot check) stops at once: the other videos would fail the same way, so they are
 * skipped; Studio remembers it for a while (`studio_settings`, `noteYoutubeBlocked`) and forgets it when a download goes
 * through.
 *
 * Where a YouTube video is downloaded (`referenceRoute`, ADR-0001 item 193): when a farm machine takes
 * `studio.reference_fetch` it fetches the video (YouTube blocks the Studio server, not the office machines), Studio
 * streams it from the bucket into the job's scratch folder and deletes both the object and the file once measured
 * (`reference-fetch.ts`); with no such machine, the Studio server's own yt-dlp as before. Each place's block is
 * remembered apart (`where`: studio / farm): a farm fetch neither clears nor sets the server's.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { measureShots, mergeCuts, pickFrameTimes } from "@harness/core";
import { detectCuts, grabFrame, probeMedia, tileSheet } from "../cut-ffmpeg.js";
import { StudioRunError } from "../errors.js";
import { clearYoutubeBlocked, noteYoutubeBlocked, referenceRoute, type YoutubeBlockWhere } from "../settings.js";
import type { StudioBucket } from "../bucket.js";
import type { StudioDb } from "../studio-db.js";
import { YT_FAILURE_REASON, ytFailureOf, type YtDlp, type YtFailure } from "../yt-dlp.js";
import { normalizeRelPath, resolveInside, writeWorkspaceFile } from "./files.js";
import { JobError, type JobContext, type JobHandler } from "./job-runner.js";
import { dropReferenceObjects, farmBlockedReason, fetchReferenceOnFarm, type ReferenceFarm } from "./reference-fetch.js";

export interface StyleWatchRequest {
  /** YouTube ids (a confirmed `reference_download` card). */
  video_ids?: string[];
  /** Videos uploaded to the project, workspace paths under `context/` (`style_from_files`). */
  files?: string[];
  purpose: string;
  action_id?: string;
}

/** At most this many videos of each kind in one job. */
export const STYLE_WATCH_MAX = 5;
/** Videos people may upload to learn a style from (≤480p is plenty), and where the Inputs tab puts them. */
export const REFERENCE_VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"] as const;
export const REFERENCE_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;
export const REFERENCE_UPLOAD_DIR = "context/references";

const SCENE_THRESHOLD = 0.3;
const FRAMES_PER_VIDEO = 32;
const OPENING_SECONDS = 15;
const OPENING_STEP = 1.5;
const INTERVAL = 10;
const FRAME_WIDTH = 480;
const SHEET_FRAMES = 16;
const SHEET_COLS = 4;
const REASON_MAX = 200;
const YOUTUBE_ID = /^[\w-]{11}$/;

/** What to offer when YouTube will not give a reference video. */
export const STYLE_INSTEAD = "Cách khác: tải video mẫu lên tab Nguồn (mục Video tham khảo) rồi nhờ agent học phong cách từ file đó, hoặc tả phong cách dựng bằng lời.";

/** Said to the thread when YouTube blocks the server and nothing could be watched. */
export const YOUTUBE_BLOCKED_MESSAGE = `${YT_FAILURE_REASON.youtube_blocked}, nên chưa tải được video mẫu nào. `
  + `Studio không dùng cookie hay đăng nhập để lách. ${STYLE_INSTEAD}`;

/** The same when the farm's machines were refused (they fetch while YouTube blocks the server). */
export const FARM_BLOCKED_MESSAGE = `YouTube đang chặn tải từ các máy farm (đòi đăng nhập để xác nhận không phải bot), nên chưa tải được video mẫu nào. `
  + `Studio không dùng cookie hay đăng nhập để lách. ${STYLE_INSTEAD}`;

/** The project's reference videos kept on the bucket (items of someone's media library), by the path they are named by. */
export async function referenceMedia(db: StudioDb, projectId: string): Promise<Map<string, { key: string; bytes: number }>> {
  const rows = await db.all<{ ref: string; key: string; bytes: string | null }>(
    "SELECT ref, meta->>'key' AS key, meta->>'bytes' AS bytes FROM project_sources WHERE project_id = ? AND kind = 'upload' AND media_type = 'video' AND meta->>'key' IS NOT NULL",
    [projectId],
  );
  return new Map(rows.map((r) => [r.ref, { key: r.key, bytes: Number(r.bytes) || 0 }]));
}

/**
 * A reference video uploaded to the project: a file under `context/` with a video extension, in the workspace (`abs`)
 * or on the bucket (`key`, one of `onBucket`). Throws a `StudioRunError` (`code` in details: `not_context`,
 * `not_video`, `no_file`) saying what is wrong.
 */
export function referenceFile(
  workspaceDir: string, raw: string, onBucket: Map<string, { key: string; bytes: number }> = new Map(),
): { path: string; abs: string | null; key: string | null; bytes: number } {
  const path = normalizeRelPath(raw);
  if (!path.startsWith("context/")) throw new StudioRunError("invalid", `${path}: video mẫu phải là file người dùng tải lên context/`, { code: "not_context" });
  if (!(REFERENCE_VIDEO_EXTS as readonly string[]).includes(extname(path).toLowerCase())) {
    throw new StudioRunError("invalid", `${path}: không phải video (${REFERENCE_VIDEO_EXTS.join(", ")})`, { code: "not_video" });
  }
  const stored = onBucket.get(path);
  if (stored) return { path, abs: null, key: stored.key, bytes: stored.bytes };
  const { abs } = resolveInside(workspaceDir, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StudioRunError("invalid", `${path}: không có file này`, { code: "no_file" });
  return { path, abs, key: null, bytes: statSync(abs).size };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ");

type Measured = ReturnType<typeof measureShots>;
interface WatchRow {
  label: string;
  /** A YouTube video (`id`), or a file of the project (`file`). */
  id: string | null; file: string | null;
  title: string; channel: string; duration: number | null;
  /** Why it was not measured: a code (`YtFailureCode`, `not_video`…) and the short reason; null when it was. */
  code: string | null; error: string | null;
  /** Not tried (YouTube blocked the server on an earlier one). */
  skipped: boolean;
  /** Where a YouTube video was downloaded (`farm`: on the machine `node`); null for an uploaded one. */
  via: YoutubeBlockWhere | null; node: string | null;
  measured: Measured; sheets: string[];
}

/** A failure that is not yt-dlp's: the start of its message, on one line. */
function otherReason(e: unknown): string {
  const s = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s;
}

/** Measures one local video: cuts, the opening, frames tiled into contact sheets written under `folder`. */
async function measureVideo(
  d: { db: StudioDb; ffmpeg: string; ffprobe: string }, projectId: string, ctx: JobContext,
  p: { path: string; folder: string; row: WatchRow; all: { cuts: number[]; duration: number }[]; n: string; progress: (part: number) => number },
): Promise<void> {
  const facts = await probeMedia(d.ffprobe, p.path);
  if (!facts?.duration_s) throw new Error("không đọc được video");
  p.row.duration = facts.duration_s;
  await ctx.report({ phase: `Đang đo nhịp dựng video mẫu ${p.n}`, progress: p.progress(0.4) });
  const cuts = mergeCuts(await detectCuts(d.ffmpeg, p.path, SCENE_THRESHOLD, ctx.signal), facts.duration_s);
  p.row.measured = measureShots([{ cuts, duration: facts.duration_s }]);
  p.all.push({ cuts, duration: facts.duration_s });
  const opening = Array.from({ length: Math.floor(OPENING_SECONDS / OPENING_STEP) }, (_, k) => Math.round(k * OPENING_STEP * 10) / 10 + 0.5);
  const times = pickFrameTimes({ duration: facts.duration_s, scene: cuts.map((c) => c + 0.2), marks: opening, interval_seconds: INTERVAL, max_frames: FRAMES_PER_VIDEO });
  const frames: string[] = [];
  for (const f of times) {
    const t = Math.min(f.t, Math.max(0, facts.duration_s - 0.1));
    const local = join(ctx.tempDir, "frames", p.row.label, `${t.toFixed(1).padStart(6, "0")}.jpg`);
    try { await grabFrame(d.ffmpeg, p.path, t, local, FRAME_WIDTH); frames.push(local); } catch { /* a frame it cannot read is skipped */ }
  }
  for (let s = 0; s * SHEET_FRAMES < frames.length; s++) {
    const name = `${p.row.label}-sheet-${String(s + 1).padStart(2, "0")}.jpg`;
    const local = join(ctx.tempDir, name);
    await tileSheet(d.ffmpeg, frames.slice(s * SHEET_FRAMES, (s + 1) * SHEET_FRAMES), SHEET_COLS, local);
    await writeWorkspaceFile(d.db, { projectId, dir: ctx.workspaceDir, path: `${p.folder}/${name}`, content: readFileSync(local), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
    p.row.sheets.push(name);
  }
}

export interface StyleWatchDeps {
  db: StudioDb;
  ffmpeg: string;
  ffprobe: string;
  /** yt-dlp for YouTube videos; absent (no yt-dlp, or `STUDIO_REFERENCE_DOWNLOADS=0`): only uploaded videos are watched. */
  ytdlp?: YtDlp | null;
  /** The farm's machines that fetch YouTube videos (`studio.reference_fetch`); absent: only Studio's own yt-dlp. */
  farm?: ReferenceFarm | null;
  /** Studio's bucket, where reference videos of someone's media library are; absent: only files of the workspace. */
  bucket?: StudioBucket | null;
}

export function styleWatchHandler(d: StyleWatchDeps): JobHandler {
  return async (job, ctx) => {
    const req = job.request as StyleWatchRequest;
    const ids = (req.video_ids ?? []).filter((id) => YOUTUBE_ID.test(id)).slice(0, STYLE_WATCH_MAX);
    const files = (req.files ?? []).slice(0, STYLE_WATCH_MAX);
    if (!ids.length && !files.length) throw new Error("không có video mẫu nào: cần id video YouTube hợp lệ hoặc file video đã tải lên");
    let n = 1;
    const day = ctx.now().slice(0, 10);
    while (existsSync(join(ctx.workspaceDir, "research", `style-${day}-${n}`))) n += 1;
    const folder = `research/style-${day}-${n}`;
    const total = files.length + ids.length;
    const rows: WatchRow[] = [];
    const all: { cuts: number[]; duration: number }[] = [];
    const row = (r: Partial<WatchRow> & { label: string; title: string }): WatchRow => {
      const out: WatchRow = { id: null, file: null, channel: "", duration: null, code: null, error: null, skipped: false, via: null, node: null, measured: null, sheets: [], ...r };
      rows.push(out);
      return out;
    };
    const step = (k: number) => ({ n: `${k + 1}/${total}`, progress: (part: number) => 0.05 + 0.9 * ((k + part) / total) });

    // the project's own videos first (a library item brought down into the scratch folder): never changed or deleted
    const onBucket = files.length ? await referenceMedia(d.db, job.project_id) : new Map<string, { key: string; bytes: number }>();
    for (const [i, raw] of files.entries()) {
      await ctx.checkpoint();
      const r = row({ label: `F${i + 1}`, file: raw, title: raw.split("/").pop() ?? raw });
      try {
        const f = referenceFile(ctx.workspaceDir, raw, onBucket);
        r.file = f.path;
        await ctx.report({ phase: `Đang đọc video mẫu ${i + 1}/${total} (tải lên)`, progress: step(i).progress(0) });
        let path = f.abs;
        if (!path) {
          if (!d.bucket) throw new Error("worker này không nối kho lưu trữ nên chưa đọc được video mẫu trong thư viện");
          path = join(ctx.tempDir, `F${i + 1}${extname(f.path).toLowerCase()}`);
          await d.bucket.getFile(f.key!, path);
        }
        await measureVideo(d, job.project_id, ctx, { path, folder, row: r, all, ...step(i) });
      } catch (e) {
        if (await ctx.stopRequested()) throw e;
        r.code = e instanceof StudioRunError ? String(e.details.code ?? "other") : "other";
        r.error = otherReason(e);
      }
    }

    let blocked: YtFailure | null = null;
    let blockedWhere: YoutubeBlockWhere = "studio";
    const fetchedOn = new Set<string>();
    if (ids.length) {
      const yt = d.ytdlp ?? null;
      // a farm machine when one can take it (unless only the farm is remembered blocked and Studio has its own yt-dlp)
      const fetchers = d.farm ? await d.farm.fetchers().catch(() => [] as string[]) : [];
      const farm = fetchers.length && (!yt || await referenceRoute(d.db, ctx.now(), fetchers.length) === "farm") ? d.farm ?? null : null;
      const via: YoutubeBlockWhere = farm ? "farm" : "studio";
      // the numbers are a nicety read by Studio's yt-dlp; through the farm they come with each video
      if (!farm) await ctx.report({ phase: "Đang đọc thông tin video mẫu trên YouTube", progress: step(files.length).progress(0) });
      const meta = !farm && yt ? await yt.metadata(ids, ctx.signal).catch((e: unknown) => {
        // a bot check here is the server blocked: nothing would download
        const f = ytFailureOf(e);
        if (f?.code === "youtube_blocked") blocked = f;
        return new Map<string, { title: string; channel_title: string; duration_s: number; views: number }>();
      }) : new Map<string, { title: string; channel_title: string }>();
      for (const [i, id] of ids.entries()) {
        await ctx.checkpoint();
        const m = meta.get(id);
        const r = row({ label: `R${i + 1}`, id, title: m?.title ?? id, channel: m?.channel_title ?? "", via });
        const stop = blocked as YtFailure | null;
        if (!yt && !farm) {
          Object.assign(r, { code: "no_ytdlp", error: "máy chủ Studio không tải video YouTube (không có yt-dlp hoặc đã tắt tải video mẫu) và không máy farm nào tải được" });
          continue;
        }
        if (stop) {
          Object.assign(r, { code: "youtube_blocked", error: `không thử: ${stop.reason}`, skipped: true });
          continue;
        }
        const k = files.length + i;
        const scratch = join(ctx.tempDir, id);
        mkdirSync(scratch, { recursive: true });
        try {
          let path: string;
          if (farm) {
            const n = `${k + 1}/${total}`;
            await ctx.report({ phase: `Đang gửi video mẫu ${n} cho máy farm tải (≤480p)`, progress: step(k).progress(0), waiting: true });
            const got = await fetchReferenceOnFarm({ db: d.db, farm, now: ctx.now }, job, { videoId: id, n: i + 1, dir: scratch }, {
              stopRequested: ctx.stopRequested,
              onUpdate: (u) => ctx.report({
                phase: u.waiting ? `Đang chờ máy farm tải video mẫu ${n}` : `Đang tải video mẫu ${n} trên máy ${u.node ?? "farm"}`,
                progress: step(k).progress(0.3 * (u.progress ?? 0)), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting,
              }),
            });
            await ctx.report({ waiting: false });
            path = got.path;
            r.node = got.node;
            if (got.node) fetchedOn.add(got.node);
            Object.assign(r, { title: got.result.title || id, channel: got.result.channel });
            await clearYoutubeBlocked(d.db, "farm");
          } else {
            await ctx.report({ phase: `Đang tải video mẫu ${k + 1}/${total} (≤480p)`, progress: step(k).progress(0) });
            path = await yt!.download(id, scratch, ctx.signal);
            await clearYoutubeBlocked(d.db, "studio");
          }
          await measureVideo(d, job.project_id, ctx, { path, folder, row: r, all, ...step(k) });
        } catch (e) {
          if (await ctx.stopRequested()) throw e;
          const f = ytFailureOf(e);
          r.code = f?.code ?? "other";
          r.error = f?.reason ?? otherReason(e);
          if (f?.code === "youtube_blocked") { blocked = f; blockedWhere = via; }
        } finally {
          // a downloaded video is never kept: the scratch file, and through the farm the bucket object too
          rmSync(scratch, { recursive: true, force: true });
          if (farm) {
            await dropReferenceObjects(farm.bucket, job.project_id, job.id, i + 1).catch((e: unknown) => {
              ctx.logger.warn("reference video left on the bucket", { job_id: job.id, video_id: id, error: e instanceof Error ? e.message : String(e) });
            });
          }
        }
      }
    }

    const wasBlocked = (blocked as YtFailure | null) !== null;
    if (wasBlocked) await noteYoutubeBlocked(d.db, ctx.now(), blockedWhere);
    const blockedReason = blockedWhere === "farm" ? farmBlockedReason(null) : YT_FAILURE_REASON.youtube_blocked;
    const measured = measureShots(all);
    const source = (r: WatchRow) => (r.id ? `[${cell(r.title)}](https://www.youtube.com/watch?v=${r.id})` : `\`${cell(r.file ?? r.title)}\` (tải lên)`);
    const lines = [
      `# Phong cách dựng từ video mẫu (${day})`,
      "",
      `Mục đích: ${req.purpose}`,
      "",
      ...(wasBlocked ? [`**${blockedReason}**: dừng ở video bị chặn, các video YouTube sau không thử. Studio không dùng cookie hay đăng nhập để lách.`, ""] : []),
      ...(ids.length ? [fetchedOn.size
        ? `Video YouTube do máy farm tải ≤480p (${[...fetchedOn].join(", ")}), Studio đo rồi xoá cả bản trên bucket lẫn bản tạm.`
        : "Video YouTube đã tải ≤480p để đo rồi xoá."] : []),
      ...(files.length ? ["Video tải lên được đo tại chỗ, không đổi, không xoá."] : []),
      "Chỉ giữ tờ ghép khung hình (mở bằng Read). Khung đầu tiên mỗi tờ theo thứ tự thời gian:",
      "15 giây mở đầu (mỗi 1,5 giây), rồi các chỗ đổi cảnh và mỗi 10 giây.",
      "",
      measured
        ? `**Chung:** ${measured.videos} video, ${measured.shots} shot, ${measured.cuts_per_minute} lần cắt/phút, shot dài trung vị ${measured.shot_seconds.median} s (25–75%: ${measured.shot_seconds.p25}–${measured.shot_seconds.p75} s), shot mở đầu ≈ ${measured.first_shot_s} s.`
        : "**Không đo được video nào.**",
      "",
      "| # | Video | Kênh | Dài | Cắt/phút | Shot trung vị | Tờ ghép |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.label} | ${source(r)} | ${cell(r.channel) || "—"} | ${r.duration ? clock(r.duration) : "—"} | ${r.measured?.cuts_per_minute ?? "—"} | ${r.measured ? `${r.measured.shot_seconds.median} s` : "—"} | ${r.error ? `lỗi \`${r.code}\`: ${cell(r.error)}` : r.sheets.map((s) => `\`${s}\``).join(", ")} |`),
      "",
      "Bước tiếp: viết `channel/style.md` (và `channel/style.json` nếu dùng) từ những gì thấy: nhịp, độ dài shot, mở đầu, chữ, chuyển cảnh, màu.",
      "",
    ];
    await writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path: `${folder}/README.md`, content: lines.join("\n"), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
    await writeWorkspaceFile(d.db, {
      projectId: job.project_id, dir: ctx.workspaceDir, path: `${folder}/watch.json`, baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now(),
      content: `${JSON.stringify({
        purpose: req.purpose, measured, youtube_blocked: wasBlocked, ...(wasBlocked ? { blocked_where: blockedWhere } : {}),
        videos: rows.map((r) => ({
          label: r.label, video_id: r.id, file: r.file, title: r.title, channel: r.channel, duration_s: r.duration, code: r.code, error: r.error, skipped: r.skipped,
          via: r.via, node: r.node,
          measured: r.measured, sheets: r.sheets,
        })),
      }, null, 2)}\n`,
    });
    const ok = rows.filter((r) => !r.error).length;
    const name = (r: WatchRow) => r.id ?? r.file ?? r.title;
    if (!ok) {
      if (wasBlocked && !files.length) throw new JobError("youtube_blocked", blockedWhere === "farm" ? FARM_BLOCKED_MESSAGE : YOUTUBE_BLOCKED_MESSAGE);
      const codes = new Set(rows.map((r) => r.code));
      throw new JobError(codes.size === 1 ? rows[0]!.code ?? "other" : "reference_failed", `không xem được video mẫu nào: ${rows.map((r) => `${name(r)}: ${r.error}`).join("; ")}`);
    }
    const notWatched = rows.filter((r) => r.error);
    return {
      result: { folder: `${folder}/`, watched: ok, failed: rows.length - ok, measured, youtube_blocked: wasBlocked },
      message: [
        `Đã xem ${ok}/${rows.length} video mẫu${measured ? `: ${measured.cuts_per_minute} lần cắt/phút, shot trung vị ${measured.shot_seconds.median} s` : ""}. Xem \`${folder}/README.md\` và các tờ ghép.`,
        ...(notWatched.length ? [`Không xem được: ${notWatched.map((r) => `${name(r)} (${r.error})`).join("; ")}.`] : []),
        ...(wasBlocked ? [STYLE_INSTEAD] : []),
      ].join(" "),
    };
  };
}
