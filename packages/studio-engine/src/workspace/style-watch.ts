/**
 * Learning an edit style from reference videos (spec 2026-10-10 agent-workspace §P6, job `style_watch`, run after a
 * person confirmed a `reference_download` card): each YouTube video is downloaded at ≤480p into a scratch folder,
 * measured (scene changes: shot lengths, cuts per minute, the opening), its frames kept and tiled into contact sheets
 * under `research/style-<date>-<n>/`, then deleted — the video itself is never kept. The agent reads the README and the
 * sheets and writes `channel/style.md` (+ `style.json`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { measureShots, mergeCuts, pickFrameTimes } from "@harness/core";
import { detectCuts, grabFrame, probeMedia, tileSheet } from "../cut-ffmpeg.js";
import type { StudioDb } from "../studio-db.js";
import type { YtDlp } from "../yt-dlp.js";
import { writeWorkspaceFile } from "./files.js";
import type { JobHandler } from "./job-runner.js";

export interface StyleWatchRequest { video_ids: string[]; purpose: string; action_id?: string }

const SCENE_THRESHOLD = 0.3;
const FRAMES_PER_VIDEO = 32;
const OPENING_SECONDS = 15;
const OPENING_STEP = 1.5;
const INTERVAL = 10;
const FRAME_WIDTH = 480;
const SHEET_FRAMES = 16;
const SHEET_COLS = 4;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function styleWatchHandler(d: { db: StudioDb; ytdlp: YtDlp; ffmpeg: string; ffprobe: string }): JobHandler {
  return async (job, ctx) => {
    const req = JSON.parse(job.request) as StyleWatchRequest;
    const ids = req.video_ids.filter((id) => /^[\w-]{11}$/.test(id)).slice(0, 5);
    if (!ids.length) throw new Error("không có id video YouTube hợp lệ");
    let n = 1;
    const day = ctx.now().slice(0, 10);
    while (existsSync(join(ctx.workspaceDir, "research", `style-${day}-${n}`))) n += 1;
    const folder = `research/style-${day}-${n}`;
    ctx.report({ phase: "Đang đọc thông tin video mẫu", progress: 0.02 });
    const meta = await d.ytdlp.metadata(ids, ctx.signal).catch(() => new Map<string, { title: string; channel_title: string; duration_s: number; views: number }>());
    const rows: { label: string; id: string; title: string; channel: string; duration: number | null; error: string | null; measured: ReturnType<typeof measureShots>; sheets: string[] }[] = [];
    const all: { cuts: number[]; duration: number }[] = [];
    for (const [i, id] of ids.entries()) {
      ctx.checkpoint();
      const label = `R${i + 1}`;
      const m = meta.get(id);
      const row = { label, id, title: m?.title ?? id, channel: m?.channel_title ?? "", duration: null as number | null, error: null as string | null, measured: null as ReturnType<typeof measureShots>, sheets: [] as string[] };
      rows.push(row);
      const scratch = join(ctx.tempDir, id);
      mkdirSync(scratch, { recursive: true });
      const base = i / ids.length;
      try {
        ctx.report({ phase: `Đang tải video mẫu ${i + 1}/${ids.length} (≤480p)`, progress: 0.05 + 0.9 * base });
        const path = await d.ytdlp.download(id, scratch, ctx.signal);
        const facts = await probeMedia(d.ffprobe, path);
        if (!facts?.duration_s) throw new Error("không đọc được video đã tải");
        row.duration = facts.duration_s;
        ctx.report({ phase: `Đang đo nhịp dựng video mẫu ${i + 1}/${ids.length}`, progress: 0.05 + 0.9 * (base + 0.4 / ids.length) });
        const cuts = mergeCuts(await detectCuts(d.ffmpeg, path, SCENE_THRESHOLD, ctx.signal), facts.duration_s);
        row.measured = measureShots([{ cuts, duration: facts.duration_s }]);
        all.push({ cuts, duration: facts.duration_s });
        const opening = Array.from({ length: Math.floor(OPENING_SECONDS / OPENING_STEP) }, (_, k) => Math.round(k * OPENING_STEP * 10) / 10 + 0.5);
        const times = pickFrameTimes({ duration: facts.duration_s, scene: cuts.map((c) => c + 0.2), marks: opening, interval_seconds: INTERVAL, max_frames: FRAMES_PER_VIDEO });
        const frames: string[] = [];
        for (const f of times) {
          const t = Math.min(f.t, Math.max(0, facts.duration_s - 0.1));
          const local = join(ctx.tempDir, "frames", label, `${t.toFixed(1).padStart(6, "0")}.jpg`);
          try { await grabFrame(d.ffmpeg, path, t, local, FRAME_WIDTH); frames.push(local); } catch { /* a frame it cannot read is skipped */ }
        }
        for (let s = 0; s * SHEET_FRAMES < frames.length; s++) {
          const name = `${label}-sheet-${String(s + 1).padStart(2, "0")}.jpg`;
          const local = join(ctx.tempDir, name);
          await tileSheet(d.ffmpeg, frames.slice(s * SHEET_FRAMES, (s + 1) * SHEET_FRAMES), SHEET_COLS, local);
          writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path: `${folder}/${name}`, content: readFileSync(local), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
          row.sheets.push(name);
        }
      } catch (e) {
        if (ctx.stopRequested()) throw e;
        row.error = (e instanceof Error ? e.message : String(e)).slice(-300);
      } finally {
        rmSync(scratch, { recursive: true, force: true }); // the video itself is never kept
      }
    }
    const measured = measureShots(all);
    const lines = [
      `# Phong cách dựng từ video mẫu (${day})`,
      "",
      `Mục đích: ${req.purpose}`,
      "",
      "Video đã tải ≤480p để đo rồi xoá; chỉ giữ tờ ghép khung hình (mở bằng Read). Khung đầu tiên mỗi tờ theo thứ tự thời gian:",
      "15 giây mở đầu (mỗi 1,5 giây), rồi các chỗ đổi cảnh và mỗi 10 giây.",
      "",
      measured
        ? `**Chung:** ${measured.videos} video, ${measured.shots} shot, ${measured.cuts_per_minute} lần cắt/phút, shot dài trung vị ${measured.shot_seconds.median} s (25–75%: ${measured.shot_seconds.p25}–${measured.shot_seconds.p75} s), shot mở đầu ≈ ${measured.first_shot_s} s.`
        : "**Không đo được video nào.**",
      "",
      "| # | Video | Kênh | Dài | Cắt/phút | Shot trung vị | Tờ ghép |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.label} | [${r.title.replace(/\|/g, "\\|")}](https://www.youtube.com/watch?v=${r.id}) | ${r.channel.replace(/\|/g, "\\|")} | ${r.duration ? clock(r.duration) : "—"} | ${r.measured?.cuts_per_minute ?? "—"} | ${r.measured ? `${r.measured.shot_seconds.median} s` : "—"} | ${r.error ? `lỗi: ${r.error.replace(/\|/g, "/")}` : r.sheets.map((s) => `\`${s}\``).join(", ")} |`),
      "",
      "Bước tiếp: viết `channel/style.md` (và `channel/style.json` nếu dùng) từ những gì thấy: nhịp, độ dài shot, mở đầu, chữ, chuyển cảnh, màu.",
      "",
    ];
    writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path: `${folder}/README.md`, content: lines.join("\n"), baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now() });
    writeWorkspaceFile(d.db, {
      projectId: job.project_id, dir: ctx.workspaceDir, path: `${folder}/watch.json`, baseSha256: null, author: { kind: "studio", id: null }, now: ctx.now(),
      content: `${JSON.stringify({ purpose: req.purpose, measured, videos: rows.map((r) => ({ label: r.label, video_id: r.id, title: r.title, channel: r.channel, duration_s: r.duration, error: r.error, measured: r.measured, sheets: r.sheets })) }, null, 2)}\n`,
    });
    const ok = rows.filter((r) => !r.error).length;
    if (!ok) throw new Error(`không xem được video mẫu nào: ${rows.map((r) => `${r.id}: ${r.error}`).join("; ").slice(0, 400)}`);
    return {
      result: { folder: `${folder}/`, watched: ok, failed: rows.length - ok, measured },
      message: `Đã xem ${ok}/${rows.length} video mẫu: ${measured ? `${measured.cuts_per_minute} lần cắt/phút, shot trung vị ${measured.shot_seconds.median} s` : ""}. Xem \`${folder}/README.md\` và các tờ ghép.`,
    };
  };
}
