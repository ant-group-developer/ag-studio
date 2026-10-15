/**
 * The agent's tools for a video's timeline (spec 2026-10-10 agent-workspace §P6): build it from the edit plan (a
 * background job), read it, change it with edit operations (on the revision it read: a newer one is a conflict),
 * render a preview, and the music library to choose from. Final renders and exports go through `propose_action`.
 */
import { z } from "zod";
import { TimelineOpSchema, type TimelineV4 } from "@harness/contracts";
import { applyTimelineOps, timelineIssues, type TimelineIssue } from "@harness/core";
import { StudioRunError } from "../errors.js";
import { listLibraryMusic } from "../music-library.js";
import { queueFit, timelineSnapshotPath, videoAssets, writeTimelineSnapshot } from "../workspace/fit.js";
import { getJob } from "../workspace/jobs-db.js";
import { getVideoRevision, latestVideoRevision, requireVideo, saveVideoRevision } from "../workspace/project-db.js";
import { RevisionConflictError } from "../studio-db.js";
import { queueRender } from "../workspace/renders.js";
import { MAX_RENDER_FRAMES, queueRenderFrames, queueThumbnails } from "../workspace/thumbnails.js";
import { buildVideoIndex } from "../workspace/video-index.js";
import type { AgentTool, AgentToolContext, ToolAnswer } from "./tools.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitS = z.number().int().min(0).max(60).optional();
const r2 = (n: number) => Math.round(n * 100) / 100;

async function videoOf(ctx: AgentToolContext, id: string | undefined) {
  const videoId = id ?? ctx.video?.id;
  if (!videoId) throw new StudioRunError("invalid", "luồng này không gắn với video nào: cho biết video_id", { code: "no_video" });
  const v = await requireVideo(ctx.db, videoId);
  if (v.project_id !== ctx.project.id) throw new StudioRunError("invalid", "video thuộc dự án khác", { code: "other_project" });
  return v;
}

/** The timeline as the agent reads it: clips with their place in the video, texts, narration, music, problems. */
export function timelineSummary(t: TimelineV4, revision: number, label: string | null) {
  let at = 0;
  const clips = t.clips.map((c) => {
    const len = Math.max(0, (c.out ?? c.in) - c.in);
    const row = {
      clip_id: c.clip_id, at: r2(at), length: r2(len), asset: t.assets[c.asset_id]?.title ?? c.asset_id, asset_id: c.asset_id, in: c.in, out: c.out,
      shot_id: c.shot_id, line_id: c.line_id, section_title: c.section_title, transition: c.transition_out.kind, ...(c.muted ? { muted: true } : {}),
    };
    at += len - (c.transition_out.kind === "dissolve" ? c.transition_out.seconds : 0);
    return row;
  });
  return {
    revision, label, approx_seconds: r2(at), canvas: t.canvas, fps: t.fps, clips, texts: t.texts,
    narration: { voice: t.narration.voice, lines: t.narration.lines.map((l) => ({ line_id: l.line_id, text: l.text })) },
    music: t.music, captions: t.captions, source_muted: t.source_audio.muted,
    issues: timelineIssues(t).map((i) => `[${i.severity}] ${i.message}`),
  };
}

export const TIMELINE_VIEWS = ["overview", "clips", "texts", "full"] as const;
export type TimelineView = (typeof TIMELINE_VIEWS)[number];
/** At most this many clips or texts in one `clips`/`texts` read; the rest is read from `next_from_s`. */
const VIEW_ROWS = 120;

/**
 * What `timeline_get` answers (plan 2026-10-15 feedback-vps §3.2): a 145-clip timeline read whole was tens of thousands
 * of tokens every time. `overview` (the default): length, counts, the sections with their clip ranges and times, music,
 * source audio, problems. `clips` / `texts`: the rows that play within `[from_s, to_s)`, a page at a time. `full`: all
 * of it (`timelineSummary`).
 */
export function timelineView(t: TimelineV4, revision: number, label: string | null, view: TimelineView = "overview", range: { from_s?: number; to_s?: number } = {}) {
  const full = timelineSummary(t, revision, label);
  if (view === "full") return { view, ...full };
  const head = { revision, label, view, approx_seconds: full.approx_seconds };
  const from = range.from_s ?? 0;
  const to = range.to_s ?? Number.POSITIVE_INFINITY;
  const page = <R>(rows: R[], startOf: (r: R) => number) => {
    const shown = rows.slice(0, VIEW_ROWS);
    return {
      shown,
      more: rows.length > VIEW_ROWS ? { truncated: true, next_from_s: r2(startOf(rows[VIEW_ROWS]!)), left: rows.length - VIEW_ROWS } : {},
    };
  };
  if (view === "clips") {
    const rows = full.clips.filter((c) => c.at < to && c.at + c.length > from);
    const { shown, more } = page(rows, (c) => c.at);
    const lineIds = new Set(shown.map((c) => c.line_id).filter((id): id is string => id !== null));
    return {
      ...head, from_s: from, ...(Number.isFinite(to) ? { to_s: to } : {}), clips_total: full.clips.length, clips: shown, ...more,
      narration: full.narration.lines.filter((l) => lineIds.has(l.line_id)),
    };
  }
  if (view === "texts") {
    const rows = full.texts.filter((x) => x.start < to && x.start + x.duration > from);
    const { shown, more } = page(rows, (x) => x.start);
    return { ...head, from_s: from, ...(Number.isFinite(to) ? { to_s: to } : {}), texts_total: full.texts.length, texts: shown, ...more };
  }
  // overview: a section starts at a clip with a section title (clips before the first one make an untitled section)
  const sections: { title: string | null; clips: string; at: number; end: number; count: number }[] = [];
  for (const c of full.clips) {
    const last = sections.at(-1);
    if (!last || c.section_title !== null) {
      sections.push({ title: c.section_title, clips: c.clip_id, at: c.at, end: r2(c.at + c.length), count: 1 });
      continue;
    }
    last.clips = `${last.clips.split("–")[0]}–${c.clip_id}`;
    last.end = r2(c.at + c.length);
    last.count += 1;
  }
  return {
    ...head, canvas: t.canvas, fps: t.fps, edit_style: t.edit_style,
    counts: {
      clips: t.clips.length, videos: new Set(t.clips.map((c) => c.asset_id)).size, texts: t.texts.length, narration_lines: t.narration.lines.length,
      muted_clips: t.clips.filter((c) => c.muted).length, dissolves: t.clips.filter((c) => c.transition_out.kind === "dissolve").length,
    },
    sections, music: t.music, narration_voice: t.narration.voice, captions: t.captions.mode, source_muted: t.source_audio.muted,
    issues: full.issues,
    read_more: "Đọc từng khúc: view \"clips\" hoặc \"texts\" với from_s/to_s (giây trong video); view \"full\" khi thật cần cả timeline.",
  };
}

async function waitFor(ctx: AgentToolContext, jobId: string, seconds: number): Promise<ToolAnswer> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const j = (await getJob(ctx.db, jobId))!;
    if (j.status === "done") return { text: json({ job_id: j.id, status: "done", result: j.result ?? null }) };
    if (j.status === "failed" || j.status === "cancelled") return { text: `Không xong: ${j.error ?? j.status}`, isError: true };
    if (Date.now() >= until) return { text: json({ job_id: j.id, status: j.status, phase: j.phase, note: "Đang chạy nền: Studio báo vào luồng khi xong, bạn sẽ làm tiếp." }) };
    await sleep(1000);
  }
}

export const TIMELINE_TOOLS: AgentTool[] = [
  tool({
    name: "timeline_from_edit_plan",
    description: "Dựng timeline của video từ videos/<id>/edit-plan.json và survey.json (việc nền: đọc lời dẫn bằng giọng của dự án trên farm, khớp hình với lời, chữ theo branding, nhạc của dự án hoặc thư viện). Lưu thành bản timeline mới; Studio ghi videos/<id>/timeline.json để bạn đọc.",
    input: z.object({ video_id: z.string().min(1).optional(), wait_s: waitS }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      const job = await queueFit(ctx.db, { projectId: ctx.project.id, videoId: v.id, threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role }, ctx.now());
      return waitFor(ctx, job.id, a.wait_s ?? 45);
    },
  }),
  tool({
    name: "timeline_get",
    description: [
      "Đọc timeline của video (bản mới nhất, hoặc `revision`). Dùng số `revision` trả về làm base_revision khi sửa.",
      "`view`: overview (mặc định: độ dài, số clip/chữ/câu lời dẫn, các phần với khoảng clip và mốc giờ, nhạc, tiếng gốc, lỗi/cảnh báo);",
      "clips (từng clip: vị trí trong video, đoạn lấy, shot, câu lời dẫn, chuyển cảnh, tắt tiếng) và texts (chữ trên hình) đọc theo khúc `from_s`–`to_s` (giây trong video);",
      "full (tất cả, rất dài với timeline nhiều clip: chỉ dùng khi thật cần).",
    ].join(" "),
    input: z.object({
      video_id: z.string().min(1).optional(),
      revision: z.number().int().min(1).optional(),
      view: z.enum(TIMELINE_VIEWS).optional(),
      from_s: z.number().min(0).optional(),
      to_s: z.number().positive().optional(),
    }).strict(),
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      const rev = a.revision ? await getVideoRevision(ctx.db, v.id, a.revision) : await latestVideoRevision(ctx.db, v.id);
      if (!rev) return { text: "Video chưa có timeline: dựng bằng timeline_from_edit_plan sau khi có edit-plan.json.", isError: true };
      if (a.from_s !== undefined && a.to_s !== undefined && a.to_s <= a.from_s) return { text: "to_s phải lớn hơn from_s.", isError: true };
      const range = { ...(a.from_s !== undefined ? { from_s: a.from_s } : {}), ...(a.to_s !== undefined ? { to_s: a.to_s } : {}) };
      return { text: json(timelineView(rev.data, rev.revision, rev.label, a.view ?? "overview", range)) };
    },
  }),
  tool({
    name: "timeline_apply_ops",
    description: [
      "Sửa timeline bằng các thao tác (tối đa 50), lưu thành bản mới. `base_revision` là bản bạn đã đọc (timeline_get); bản mới hơn đã có thì bị từ chối: đọc lại rồi sửa.",
      "Thao tác: addClip {asset_id, index}, removeClip {clip_id}, moveClip {from, to}, replaceClipAsset {clip_id, asset_id}, trimClip {clip_id, in, out|null},",
      "setTransition {clip_id, kind: cut|dissolve, seconds}, setClipMuted {clip_id, muted}, setSectionTitle {clip_id, title|null},",
      "addText {kind, text (≤ 120 ký tự), start, duration (≤ 600 s), position, size?: s|m|l}, updateText {text_id, kind|null, text|null, start|null, duration|null, position|null, size?}, removeText {text_id} (chữ cùng vị trí cùng lúc tự xếp chồng),",
      "setMusic {music: {track: 'library:…', gain_db, ducking} | null}, setSourceMuted {muted}, setCaptions {mode}. asset_id phải là video đã chuẩn bị của video này.",
    ].join(" "),
    input: z.object({
      video_id: z.string().min(1).optional(),
      base_revision: z.number().int().min(1),
      ops: z.array(TimelineOpSchema).min(1).max(50),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      const base = await getVideoRevision(ctx.db, v.id, a.base_revision);
      if (!base) return { text: `Không có timeline bản ${a.base_revision}.`, isError: true };
      const allowed = videoAssets(await buildVideoIndex(ctx.db, ctx.workspaceDir, ctx.project.id, v.id), ctx.workspaceDir);
      let next: TimelineV4;
      const clamped: TimelineIssue[] = [];
      try {
        next = applyTimelineOps(base.data, a.ops, { ...base.data.assets, ...allowed }, clamped);
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
      }
      try {
        const { revision } = await saveVideoRevision(ctx.db, v.id, { baseRevision: a.base_revision, data: next, authorId: ctx.claims.sub, label: "agent" });
        await writeTimelineSnapshot(ctx.db, ctx.workspaceDir, ctx.project.id, v.id, ctx.now());
        const issues = [...clamped, ...timelineIssues(next)];
        return { text: json({ revision, saved: timelineSnapshotPath(v.id), issues: issues.map((i) => `[${i.severity}] ${i.message}`) }) };
      } catch (e) {
        if (e instanceof RevisionConflictError) return { text: `Timeline đã có bản mới hơn (${e.current}): đọc lại bằng timeline_get rồi sửa trên bản đó.`, isError: true };
        throw e;
      }
    },
  }),
  tool({
    name: "render_preview",
    description: "Render bản xem trước của timeline mới nhất của video (việc nền trên farm, thường vài phút). Studio báo vào luồng khi xong; người dùng xem ở trang video.",
    input: z.object({ video_id: z.string().min(1).optional(), wait_s: waitS }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      if (!(await latestVideoRevision(ctx.db, v.id))) return { text: "Video chưa có timeline: dựng bằng timeline_from_edit_plan trước.", isError: true };
      const job = await queueRender(ctx.db, { projectId: ctx.project.id, videoId: v.id, kind: "render_preview", threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role }, ctx.now());
      return waitFor(ctx, job.id, a.wait_s ?? 0);
    },
  }),
  tool({
    name: "thumbnail_make",
    description: "Làm 1–3 thumbnail cho video: cắt khung từ bản render mới nhất (bản cuối nếu có, không thì bản xem trước) ở giây `at_seconds` và vẽ `text` theo branding (vị trí, chữ hoa, màu). Ghi videos/<id>/thumbnails/NN.jpg và README.md; mở ảnh bằng Read để xem lại. Lấy ý tưởng từ youtube-kit.md.",
    input: z.object({
      video_id: z.string().min(1).optional(),
      items: z.array(z.object({ text: z.string().trim().min(1).max(60), at_seconds: z.number().min(0).optional() }).strict()).min(1).max(3),
      position: z.enum(["top", "center", "bottom", "left", "right"]).optional(),
      wait_s: waitS,
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      const job = await queueThumbnails(ctx.db, {
        projectId: ctx.project.id, videoId: v.id, items: a.items, ...(a.position ? { style: { position: a.position } } : {}),
        threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role,
      }, ctx.now());
      return waitFor(ctx, job.id, a.wait_s ?? 30);
    },
  }),
  tool({
    name: "render_frames",
    description: "Cắt khung hình (không vẽ chữ) từ bản render mới nhất của video ở các giây `at_seconds` (tối đa 12) để tự xem bản render: kiểm chỗ máy render báo đứng hình, màn đen, chữ đè nhau, cảnh sai. Ghi videos/<id>/renders/frames/r<bản>-<giây>s.jpg; mở bằng Read. Muốn nhìn cả video thì xem trước tờ ghép khung hình trong thư mục của bản render (ghi chú videos/<id>/renders/*.md).",
    input: z.object({
      video_id: z.string().min(1).optional(),
      at_seconds: z.array(z.number().min(0)).min(1).max(MAX_RENDER_FRAMES),
      wait_s: waitS,
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const v = await videoOf(ctx, a.video_id);
      const job = await queueRenderFrames(ctx.db, {
        projectId: ctx.project.id, videoId: v.id, atSeconds: a.at_seconds, threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role,
      }, ctx.now());
      return waitFor(ctx, job.id, a.wait_s ?? 60);
    },
  }),
  tool({
    name: "music_list",
    description: "Nhạc trong thư viện của Studio (đang dùng được), lọc theo tâm trạng (`mood`). Đặt nhạc cho timeline bằng setMusic với `track` của bài; hoặc ghi `music_mood` trong edit-plan.json để Studio chọn khi dựng.",
    input: z.object({ mood: z.string().trim().min(1).max(40).optional() }).strict(),
    run: async (ctx, a) => {
      const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
      const tracks = (await listLibraryMusic(ctx.db, { activeOnly: true })).filter((t) => !a.mood || t.mood.some((m) => fold(m) === fold(a.mood!)));
      return { text: json(tracks.slice(0, 60).map((t) => ({ name: t.display_name, mood: t.mood, seconds: Math.round(t.duration_seconds), loop_ok: t.loop_ok, track: t.file }))) };
    },
  }),
];
