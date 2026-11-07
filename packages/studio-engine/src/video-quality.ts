/**
 * How the videos rendered in a period are made (plan 2026-11-07 prod-diagnostics P4), for an admin looking for what
 * to improve: the cut (shot lengths, footage used twice, jump cuts), the voice (gaps between lines, lines not read),
 * the render worker's check of the file (`inspect.json`: freezes, black, silence, loudness of clips), and how much
 * people had to ask again after the first render. One row per video: its latest final render of the period, else its
 * latest preview.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTimelineV4, layoutTimeline, timelineIssues } from "@harness/core";
import { RenderInspectionSchema, upgradeTimelineV3, type RenderInspection, type StoredTimeline, type TimelineV4 } from "@harness/contracts";
import { quantile, type DiagnosticsPeriod } from "./diagnostics.js";
import type { StudioDb } from "./studio-db.js";

/** Videos read per request (each reads its timeline and its inspection file). */
export const VIDEO_QUALITY_LIMIT = 300;

/**
 * A shot longer than this holds the picture too long, even for the slow channels Studio makes (rain, walks: shots
 * of 10-20 s are their style; on the prod data of 2026-10, 8 s flagged three videos in four).
 */
export const LONG_SHOT_SECONDS = 20;
/** A shot shorter than this flashes by. */
export const SHORT_SHOT_SECONDS = 1;
/** Narration silent this long between two lines leaves the picture alone. */
export const VOICE_GAP_SECONDS = 10;
/** Renders of one video, or messages after its first render, from which it took too many tries. */
export const MANY_RENDERS = 6;
export const MANY_ASKS = 10;
/** Median loudness of the clips outside this reads too quiet or too loud (LUFS). */
export const LOUDNESS_RANGE: readonly [number, number] = [-20, -10];

export const VIDEO_FLAGS = [
  "render_problem", "lines_without_audio", "freeze", "black", "silence", "repeated_onset", "narration_overrun",
  "repeated_footage", "jump_cuts", "long_shots", "fast_cuts", "voice_gaps", "clip_loudness", "loudness_off",
  "transitions_dropped", "many_retakes", "no_music", "no_captions", "no_inspection",
] as const;
export type VideoFlagCode = (typeof VIDEO_FLAGS)[number];
export interface VideoFlag { code: VideoFlagCode; severity: "error" | "warning" | "info"; detail: string }

export interface VideoQualityRow {
  videoId: string; videoTitle: string; projectId: string; projectName: string; teamId: string;
  jobId: string; kind: "render_final" | "render_preview"; revision: number; finishedAt: string;
  width: number | null; height: number | null; durationSeconds: number | null;
  editStyle: string | null; voice: string | null; captions: string | null; music: boolean; look: string | null;
  shots: number; shotMean: number | null; shotMedian: number | null; longShare: number | null; shortShare: number | null; longestShot: number | null;
  /** Distinct footage files over shots (1: every shot from a different file). */
  assetVariety: number | null;
  lines: number; linesWithoutAudio: number; maxVoiceGap: number | null; voiceCoverage: number | null;
  /** `timelineIssues` codes and how many. */
  timelineIssues: Record<string, number>;
  /** The render worker's inspection, when the file is there. */
  inspect: { issues: Record<string, number>; loudnessMedianLufs: number | null; freezes: number; blacks: number; silences: number } | null;
  renders: number; asksAfterFirstRender: number; agentEditsAfterFirstRender: number;
  flags: VideoFlag[];
}

export interface VideoQualitySummary {
  videos: number;
  /** Videos with each flag, most common first. */
  flags: { code: VideoFlagCode; videos: number; severity: VideoFlag["severity"] }[];
  shotMedian: number | null;
  longShare: number | null;
  rendersMedian: number | null;
  asksMedian: number | null;
  byHeight: Record<string, number>;
}

export interface VideoQuality { rows: VideoQualityRow[]; summary: VideoQualitySummary; truncated: boolean }

interface PickRow {
  job_id: string; kind: "render_final" | "render_preview"; video_id: string; title: string; project_id: string; project_name: string; team_id: string;
  finished_at: string; result: { revision?: number; width?: number | null; height?: number | null; duration_s?: number | null; problem?: string | null; inspect?: { dir?: string } } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const share = (n: number, of: number) => (of ? r2(n / of) : null);

/** The inspection file of a render in its project's workspace; null when missing or unreadable. */
export function readInspection(workspacesRoot: string, projectId: string, dir: string | undefined): RenderInspection | null {
  if (!dir || dir.includes("..")) return null;
  try {
    const parsed = RenderInspectionSchema.safeParse(JSON.parse(readFileSync(join(workspacesRoot, projectId, dir, "inspect.json"), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The numbers and flags of one timeline and its render (pure: the DB and file reads are the caller's). */
export function measureVideo(
  stored: StoredTimeline,
  render: { problem?: string | null; inspected: boolean },
  inspection: RenderInspection | null,
  history: { renders: number; asksAfterFirstRender: number; agentEditsAfterFirstRender: number },
): Omit<VideoQualityRow, "videoId" | "videoTitle" | "projectId" | "projectName" | "teamId" | "jobId" | "kind" | "revision" | "finishedAt" | "width" | "height" | "durationSeconds"> {
  const t: TimelineV4 = isTimelineV4(stored) ? stored : upgradeTimelineV3(stored);
  const layout = layoutTimeline(t);
  const durations = layout.clips.map((c) => c.duration).filter((d) => d > 0);
  const issues: Record<string, number> = {};
  for (const i of timelineIssues(t)) issues[i.code] = (issues[i.code] ?? 0) + 1;
  const reading = t.narration.voice !== "none" && t.narration.lines.length > 0;
  const lines = [...layout.lines].sort((a, b) => a.start - b.start);
  let maxGap: number | null = null;
  for (let i = 1; i < lines.length; i++) maxGap = Math.max(maxGap ?? 0, lines[i]!.start - lines[i - 1]!.end);
  if (lines.length) maxGap = Math.max(maxGap ?? 0, layout.duration - lines[lines.length - 1]!.end);
  const voiced = lines.reduce((s, l) => s + Math.max(0, l.end - l.start), 0);
  const withoutAudio = t.narration.lines.filter((l) => !l.audio).length;

  const ins = inspection
    ? {
      issues: inspection.issues.reduce<Record<string, number>>((m, i) => ({ ...m, [i.code]: (m[i.code] ?? 0) + 1 }), {}),
      loudnessMedianLufs: inspection.loudness_median_lufs, freezes: inspection.freezes.length, blacks: inspection.blacks.length, silences: inspection.silences.length,
    }
    : null;

  const long = durations.filter((d) => d > LONG_SHOT_SECONDS).length;
  const short = durations.filter((d) => d < SHORT_SHOT_SECONDS).length;
  const flags: VideoFlag[] = [];
  const flag = (code: VideoFlagCode, severity: VideoFlag["severity"], detail: string) => flags.push({ code, severity, detail });
  if (render.problem) flag("render_problem", "error", render.problem);
  if (reading && withoutAudio) flag("lines_without_audio", "error", `${withoutAudio} câu chưa có giọng đọc`);
  const insErr = (code: string) => inspection?.issues.filter((i) => i.code === code) ?? [];
  if (insErr("freeze").length) flag("freeze", "error", `${insErr("freeze").length} đoạn hình đứng`);
  if (insErr("black").length) flag("black", "error", `${insErr("black").length} đoạn màn đen`);
  if (insErr("silence").length) flag("silence", "warning", `${insErr("silence").length} đoạn im tiếng`);
  if (insErr("repeated_onset").length) flag("repeated_onset", "warning", "nhiều câu mở đầu cùng một âm (lọt giọng mẫu)");
  if (issues.narration_overrun) flag("narration_overrun", "warning", `${issues.narration_overrun} câu đọc tràn qua cảnh sau`);
  const repeated = (issues.overlapping_range ?? 0) + (issues.duplicate_asset ?? 0);
  if (repeated) flag("repeated_footage", "warning", `${repeated} chỗ dùng lại cùng một đoạn footage`);
  if (issues.jump_cut) flag("jump_cuts", "warning", `${issues.jump_cut} jump cut`);
  if (durations.length >= 5 && long / durations.length >= 0.3) flag("long_shots", "warning", `${Math.round((long / durations.length) * 100)}% cảnh dài hơn ${LONG_SHOT_SECONDS} s`);
  if (durations.length >= 5 && short / durations.length >= 0.3) flag("fast_cuts", "warning", `${Math.round((short / durations.length) * 100)}% cảnh ngắn hơn ${SHORT_SHOT_SECONDS} s`);
  if (reading && lines.length >= 3 && maxGap !== null && maxGap > VOICE_GAP_SECONDS) flag("voice_gaps", "warning", `có chỗ ${Math.round(maxGap)} s không có lời`);
  if (insErr("clip_loudness").length >= 3) flag("clip_loudness", "warning", `${insErr("clip_loudness").length} cảnh to/nhỏ lệch hẳn so với cả video`);
  const lufs = inspection?.loudness_median_lufs ?? null;
  if (lufs !== null && (lufs < LOUDNESS_RANGE[0] || lufs > LOUDNESS_RANGE[1])) flag("loudness_off", "warning", `độ to trung vị ${lufs.toFixed(1)} LUFS`);
  if (issues.transition_no_tail) flag("transitions_dropped", "info", `${issues.transition_no_tail} chuyển cảnh không đủ đuôi`);
  if (history.renders >= MANY_RENDERS || history.asksAfterFirstRender >= MANY_ASKS) {
    flag("many_retakes", "warning", `${history.renders} lần render, ${history.asksAfterFirstRender} tin nhắn sau bản render đầu`);
  }
  if (!t.music) flag("no_music", "info", "không có nhạc nền");
  if (reading && t.captions.mode === "none") flag("no_captions", "info", "không có phụ đề");
  if (!render.inspected || !inspection) flag("no_inspection", "info", render.inspected ? "không đọc được inspect.json" : "máy render không tự kiểm bản này");

  return {
    editStyle: t.edit_style, voice: t.narration.voice, captions: t.captions.mode, music: !!t.music, look: t.look ?? null,
    shots: durations.length, shotMean: durations.length ? r2(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    shotMedian: (() => { const q = quantile(durations, 0.5); return q === null ? null : r2(q); })(),
    longShare: share(long, durations.length), shortShare: share(short, durations.length), longestShot: durations.length ? r2(Math.max(...durations)) : null,
    assetVariety: durations.length ? r2(new Set(layout.clips.map((c) => c.asset_id)).size / layout.clips.length) : null,
    lines: t.narration.lines.length, linesWithoutAudio: withoutAudio, maxVoiceGap: maxGap === null ? null : r2(maxGap),
    voiceCoverage: reading && layout.duration ? r2(voiced / layout.duration) : null,
    timelineIssues: issues, inspect: ins, ...history, flags,
  };
}

export async function videoQuality(db: StudioDb, p: DiagnosticsPeriod, o: { workspacesRoot?: string; limit?: number } = {}): Promise<VideoQuality> {
  const limit = Math.min(o.limit ?? VIDEO_QUALITY_LIMIT, VIDEO_QUALITY_LIMIT);
  const picks = await db.all<PickRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (j.video_id) j.id AS job_id, j.kind, j.video_id, v.title, j.project_id, pr.name AS project_name, pr.team_id, j.finished_at, j.result
         FROM project_jobs j JOIN videos v ON v.id = j.video_id JOIN projects pr ON pr.id = j.project_id
        WHERE j.kind IN ('render_final', 'render_preview') AND j.status = 'done' AND j.finished_at >= ? AND j.finished_at < ?
        ORDER BY j.video_id, (j.kind = 'render_final') DESC, j.finished_at DESC
     ) x ORDER BY finished_at DESC LIMIT ?`,
    [p.from, p.to, limit + 1],
  );
  const truncated = picks.length > limit;
  if (truncated) picks.length = limit;

  const rows: VideoQualityRow[] = [];
  for (const pick of picks) {
    const revision = pick.result?.revision;
    const rev = revision !== undefined
      ? await db.get<{ data: StoredTimeline }>("SELECT data FROM video_revisions WHERE video_id = ? AND revision = ?", [pick.video_id, revision])
      : await db.get<{ data: StoredTimeline }>("SELECT data FROM video_revisions WHERE video_id = ? ORDER BY revision DESC LIMIT 1", [pick.video_id]);
    if (!rev) continue;
    const first = await db.get<{ at: string | null }>(
      "SELECT MIN(finished_at) AS at FROM project_jobs WHERE video_id = ? AND kind IN ('render_final', 'render_preview') AND status = 'done'", [pick.video_id],
    );
    const firstAt = first?.at ?? pick.finished_at;
    const h = await db.get<{ renders: number; asks: number; edits: number }>(
      `SELECT (SELECT COUNT(*)::int FROM project_jobs WHERE video_id = ? AND kind IN ('render_final', 'render_preview')) AS renders,
              (SELECT COUNT(*)::int FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id
                WHERE t.video_id = ? AND m.role = 'user' AND m.created_at > ?) AS asks,
              (SELECT COUNT(*)::int FROM video_revisions WHERE video_id = ? AND label = 'agent' AND created_at > ?) AS edits`,
      [pick.video_id, pick.video_id, firstAt, pick.video_id, firstAt],
    );
    const inspection = o.workspacesRoot ? readInspection(o.workspacesRoot, pick.project_id, pick.result?.inspect?.dir) : null;
    let measured: ReturnType<typeof measureVideo>;
    try {
      measured = measureVideo(
        rev.data, { problem: pick.result?.problem ?? null, inspected: !!pick.result?.inspect }, inspection,
        { renders: h?.renders ?? 0, asksAfterFirstRender: h?.asks ?? 0, agentEditsAfterFirstRender: h?.edits ?? 0 },
      );
    } catch {
      continue; // a timeline Studio no longer reads
    }
    rows.push({
      videoId: pick.video_id, videoTitle: pick.title, projectId: pick.project_id, projectName: pick.project_name, teamId: pick.team_id,
      jobId: pick.job_id, kind: pick.kind, revision: revision ?? 0, finishedAt: pick.finished_at,
      width: pick.result?.width ?? null, height: pick.result?.height ?? null, durationSeconds: pick.result?.duration_s ?? null,
      ...measured,
    });
  }
  return { rows, summary: summarize(rows), truncated };
}

export function summarize(rows: readonly VideoQualityRow[]): VideoQualitySummary {
  const counts = new Map<VideoFlagCode, { videos: number; severity: VideoFlag["severity"] }>();
  for (const r of rows) {
    for (const code of new Set(r.flags.map((f) => f.code))) {
      const severity = r.flags.find((f) => f.code === code)!.severity;
      const c = counts.get(code) ?? { videos: 0, severity };
      c.videos++;
      counts.set(code, c);
    }
  }
  const order = { error: 0, warning: 1, info: 2 } as const;
  const med = (xs: (number | null)[]) => { const q = quantile(xs.filter((x): x is number => x !== null), 0.5); return q === null ? null : r2(q); };
  const byHeight: Record<string, number> = {};
  for (const r of rows) if (r.height) byHeight[String(r.height)] = (byHeight[String(r.height)] ?? 0) + 1;
  return {
    videos: rows.length,
    flags: [...counts.entries()].map(([code, c]) => ({ code, ...c })).sort((a, b) => order[a.severity] - order[b.severity] || b.videos - a.videos),
    shotMedian: med(rows.map((r) => r.shotMedian)), longShare: med(rows.map((r) => r.longShare)),
    rendersMedian: med(rows.map((r) => r.renders)), asksMedian: med(rows.map((r) => r.asksAfterFirstRender)), byHeight,
  };
}
