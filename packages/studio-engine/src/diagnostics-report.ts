/**
 * The admin's diagnostics of a period as one file to keep or hand to Claude (plan 2026-11-07 prod-diagnostics P5):
 * every section's data, a Markdown summary in Vietnamese, and, when asked, the chats of the videos measured.
 */
import type { DiagnosticsErrors, DiagnosticsOverview, DiagnosticsPeriod, DiagnosticsRenders, FarmJobsSummary } from "./diagnostics.js";
import type { StudioDb } from "./studio-db.js";
import type { VideoQuality } from "./video-quality.js";

export interface DiagnosticsBundle {
  period: DiagnosticsPeriod;
  generatedAt: string;
  overview: DiagnosticsOverview;
  errors: DiagnosticsErrors;
  renders: DiagnosticsRenders & { farm: (FarmJobsSummary & { truncated: boolean }) | null; farmError: string | null };
  videos: VideoQuality;
  chats?: VideoChat[];
}

export interface VideoChat { videoId: string; messages: { at: string; role: string; status: string; text: string }[] }

/** Messages kept per video, and characters per message, in a bundle. */
export const CHAT_MESSAGES_PER_VIDEO = 200;
export const CHAT_TEXT_CHARS = 2000;

/** The chats of these videos in the period (people and the agent), oldest first, cut to fit a bundle. */
export async function videoChats(db: StudioDb, videoIds: readonly string[], p: DiagnosticsPeriod): Promise<VideoChat[]> {
  const out: VideoChat[] = [];
  for (const videoId of videoIds) {
    const rows = await db.all<{ at: string; role: string; status: string; text: string }>(
      `SELECT m.created_at AS at, m.role, m.status, m.text FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id
        WHERE t.video_id = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at LIMIT ?`,
      [videoId, p.from, p.to, CHAT_MESSAGES_PER_VIDEO],
    );
    out.push({ videoId, messages: rows.map((r) => ({ ...r, text: r.text.length > CHAT_TEXT_CHARS ? `${r.text.slice(0, CHAT_TEXT_CHARS)}…` : r.text })) });
  }
  return out;
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const mins = (s: number | null) => (s === null ? "—" : s >= 120 ? `${(s / 60).toFixed(1)} phút` : `${Math.round(s)} s`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const day = (iso: string) => iso.slice(0, 10);

const FLAG_LABELS: Record<string, string> = {
  render_problem: "Bản render có lỗi", lines_without_audio: "Câu chưa có giọng đọc", freeze: "Hình đứng", black: "Màn đen", silence: "Im tiếng",
  repeated_onset: "Lọt giọng mẫu đầu câu", narration_overrun: "Lời đọc tràn cảnh", repeated_footage: "Dùng lại footage", jump_cuts: "Jump cut",
  long_shots: "Cảnh quá dài", fast_cuts: "Cảnh quá ngắn", voice_gaps: "Khoảng lặng lời đọc dài", clip_loudness: "Cảnh to/nhỏ lệch",
  loudness_off: "Độ to cả video lệch", transitions_dropped: "Chuyển cảnh bị bỏ", many_retakes: "Làm lại nhiều lần", no_music: "Không có nhạc",
  no_captions: "Không có phụ đề", no_inspection: "Chưa tự kiểm",
};
export function flagLabel(code: string): string { return FLAG_LABELS[code] ?? code; }

/** The Markdown summary of a bundle. */
export function diagnosticsReportMarkdown(b: DiagnosticsBundle): string {
  const L: string[] = [];
  const { overview: o, errors: e, renders: r, videos: v } = b;
  L.push(`# Chẩn đoán Studio ${day(b.period.from)} → ${day(b.period.to)}`, "", `Tạo lúc ${b.generatedAt}. So với kỳ trước cùng độ dài.`, "");

  L.push("## Tổng quan", "", "| Loại job | Tổng | Lỗi | Tỉ lệ lỗi | Kỳ trước (lỗi/tổng) |", "|---|---:|---:|---:|---:|");
  const kinds = [...new Set([...o.jobs, ...o.previousJobs].map((j) => j.kind))].sort();
  const sum = (rows: typeof o.jobs, kind: string, status?: string) => rows.filter((j) => j.kind === kind && (!status || j.status === status)).reduce((n, j) => n + j.n, 0);
  for (const k of kinds) {
    const total = sum(o.jobs, k);
    const failed = sum(o.jobs, k, "failed");
    L.push(`| ${k} | ${total} | ${failed} | ${pct(failed, total)} | ${sum(o.previousJobs, k, "failed")}/${sum(o.previousJobs, k)} |`);
  }
  const turns = Object.values(o.turns.byStatus).reduce((a, n) => a + n, 0);
  L.push("", `Lượt agent: ${turns} (lỗi ${o.turns.byStatus.failed ?? 0}, rate limit ${o.turns.byStatus.rate_limited ?? 0}, tiếp tục sau timeout ${o.turns.byTrigger.timeout ?? 0}), chi phí $${o.turns.costUsd.toFixed(2)}.`);
  if (o.stuck.length) {
    L.push("", `**Job đang kẹt (${o.stuck.length})**:`);
    for (const s of o.stuck.slice(0, 20)) L.push(`- ${s.kind} ${s.status} ${s.minutes} phút — ${s.projectName ?? s.projectId} (${s.id})`);
  }
  if (o.accounts.length) {
    L.push("", "**Tài khoản Claude có lỗi**:");
    for (const a of o.accounts) L.push(`- ${a.label}: ${a.lastError} (${a.lastErrorAt})`);
  }
  L.push("");

  L.push(`## Lỗi (${e.total} lần, ${e.groups.length} nhóm${e.truncated ? ", đã cắt bớt" : ""})`, "", "| Nguồn | Lỗi | Số lần | Dự án | Kỳ trước | Lần cuối |", "|---|---|---:|---:|---:|---|");
  for (const g of e.groups.slice(0, 40)) {
    L.push(`| ${g.source} ${g.kinds.slice(0, 3).join(", ")} | ${cell(g.signature)}${g.trend === "new" ? " **(mới)**" : ""} | ${g.count} | ${g.projects} | ${g.previousCount} | ${day(g.lastAt)} |`);
  }
  if (e.gone.length) {
    L.push("", "**Đã hết so với kỳ trước**:");
    for (const g of e.gone.slice(0, 20)) L.push(`- ${g.source}: ${g.signature} (${g.previousCount} lần)`);
  }
  L.push("");

  L.push("## Render", "", "| Loại | Tổng | Xong | Lỗi | Thời gian p50 / p90 | Tốc độ p50 (× realtime) | Thử lại |", "|---|---:|---:|---:|---|---:|---:|");
  for (const k of r.kinds) {
    if (!k.total) continue;
    L.push(`| ${k.kind} | ${k.total} | ${k.done} | ${k.failed} | ${mins(k.wallP50)} / ${mins(k.wallP90)} | ${k.speedP50 ?? "—"} | ${k.retried} |`);
  }
  if (r.nodes.length) {
    L.push("", "| Máy | Job | Lỗi | Tốc độ p50 | Bản cuối | Bản cuối p50 |", "|---|---:|---:|---:|---:|---|");
    for (const n of r.nodes) L.push(`| ${n.name ?? n.nodeId} | ${n.jobs} | ${n.failed} | ${n.speedP50 ?? "—"} | ${n.finals} | ${mins(n.finalWallP50)} |`);
  }
  if (r.farm?.errors.length) {
    L.push("", "**Lỗi phía farm**:");
    for (const g of r.farm.errors.slice(0, 20)) L.push(`- ${g.type} \`${g.code}\` ×${g.count}: ${g.signature} (máy: ${g.nodes.join(", ") || "—"})`);
  } else if (r.farmError) {
    L.push("", `Không đọc được farm: ${r.farmError}`);
  }
  L.push("");

  const s = v.summary;
  L.push(`## Chất lượng video (${s.videos} video${v.truncated ? ", đã cắt bớt" : ""})`, "",
    `Cảnh trung vị ${s.shotMedian ?? "—"} s; render trung vị ${s.rendersMedian ?? "—"} lần/video; tin nhắn sau bản render đầu trung vị ${s.asksMedian ?? "—"}.`, "",
    "| Vấn đề | Số video | Mức |", "|---|---:|---|");
  for (const f of s.flags) L.push(`| ${flagLabel(f.code)} | ${f.videos} (${pct(f.videos, s.videos)}) | ${f.severity} |`);
  L.push("", "| Video | Dự án | Bản | Cảnh (p50) | Lặng lời dài nhất | Render | Hỏi lại | Vấn đề |", "|---|---|---|---:|---:|---:|---:|---|");
  for (const x of v.rows.filter((x) => x.flags.some((f) => f.severity !== "info")).slice(0, 60)) {
    L.push(`| ${cell(x.videoTitle)} | ${cell(x.projectName)} | ${x.kind === "render_final" ? "cuối" : "xem trước"} ${x.height ?? ""}p | ${x.shots} (${x.shotMedian ?? "—"} s) | ${x.maxVoiceGap ?? "—"} | ${x.renders} | ${x.asksAfterFirstRender} | ${x.flags.filter((f) => f.severity !== "info").map((f) => flagLabel(f.code)).join(", ")} |`);
  }
  L.push("");
  return L.join("\n");
}
