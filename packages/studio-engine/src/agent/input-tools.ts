/**
 * The agent's tools for what a project works from (spec 2026-10-10 agent-workspace §4–§5): the sources people picked
 * (ag-go projects and videos, uploads), searching the ag-go projects of the project, adding videos to a video,
 * preparing them (a background job; the turn may wait up to a minute), and the jobs running for the project.
 */
import { z } from "zod";
import { StudioRunError } from "../errors.js";
import { DEFAULT_SITE_NAME } from "../site-name.js";
import { requireVideo } from "../workspace/project-db.js";
import { getJob, jobView, listJobs, requestJobCancel, type JobRecord } from "../workspace/jobs-db.js";
import { ASSET_ID } from "../workspace/prepare.js";
import { assetState as stateOf, queuePrepare } from "../workspace/inputs.js";
import { addSource, listSources, projectActAs, sourceView, type SourceRecord } from "../workspace/sources-db.js";
import { writeVideoIndex, videoIndexPath } from "../workspace/video-index.js";
import type { AgentTool, AgentToolContext } from "./tools.js";

/** One analysed ag-go video as the project's owner sees it. */
export interface FootageItem {
  assetId: string;
  name: string;
  durationMs: number;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
  hasSpeech?: boolean | null;
  projectNames?: string[] | null;
  summaryVi?: string | null;
  thumbnailUrl?: string | null;
}

/** ag-go as the API reaches it (service key, acting as the project's owner); wired by the API. */
export interface ProjectFootage {
  search(actAs: string, q: { projectIds: string[]; q?: string; limit?: number; cursor?: string }): Promise<{ items: FootageItem[]; nextCursor: string | null; total: number }>;
  /** Which of these videos ag-go serves to the owner (a preview at least). */
  check(actAs: string, assetIds: string[]): Promise<{ ok: string[]; missing: string[] }>;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const siteOf = (ctx: AgentToolContext) => ctx.siteName ?? DEFAULT_SITE_NAME;
const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function footageOf(ctx: AgentToolContext & { footage?: ProjectFootage }): { footage: ProjectFootage; actAs: string } {
  if (!ctx.footage) throw new StudioRunError("invalid", `Studio này chưa nối ${siteOf(ctx)}: không tìm hay thêm video được`, { code: "no_ag_go" });
  const actAs = projectActAs(ctx.db, ctx.project.id);
  if (!actAs) throw new StudioRunError("invalid", `dự án chưa có chủ để hỏi ${siteOf(ctx)}`, { code: "no_owner" });
  return { footage: ctx.footage, actAs };
}

function targetVideo(ctx: AgentToolContext, videoId: string | undefined): string {
  const id = videoId ?? ctx.video?.id;
  if (!id) throw new StudioRunError("invalid", "luồng này không gắn với video nào: cho biết video_id", { code: "no_video" });
  const v = requireVideo(ctx.db, id);
  if (v.project_id !== ctx.project.id) throw new StudioRunError("invalid", "video thuộc dự án khác", { code: "other_project" });
  return id;
}

/** Where an ag-go video of the project stands: prepared, being prepared, failed, or not yet. */
const assetState = (ctx: AgentToolContext, assetId: string) => stateOf(ctx.db, ctx.project.id, assetId);

const slimSource = (ctx: AgentToolContext, s: SourceRecord) => {
  const v = sourceView(s);
  return {
    id: v.id, kind: v.kind, ref: v.ref, media_type: v.mediaType, label: v.label, video_id: v.videoId,
    ...(v.kind === "upload" ? { path: v.ref } : {}),
    ...(v.kind === "ag_go_asset" ? assetState(ctx, v.ref) : {}),
  };
};

const jobLine = (j: JobRecord) => {
  const v = jobView(j);
  return {
    id: v.id, kind: v.kind, title: v.title, status: v.status, phase: v.phase, progress: v.progress, eta_seconds: v.etaSeconds, machine: v.nodeId,
    video_id: v.videoId, started_at: v.startedAt, finished_at: v.finishedAt, error: v.error, result: v.result,
  };
};

export const INPUT_TOOLS: AgentTool[] = [
  tool({
    name: "inputs_list",
    description: "Đầu vào người dùng đã chọn cho dự án (project {{site}}, video {{site}}, file tải lên trong context/) và cho video của luồng này (hoặc `video_id`): mỗi video {{site}} kèm trạng thái chuẩn bị (ready: đọc inputs/<asset>/README.md; not_prepared: gọi inputs_prepare).",
    input: z.object({ video_id: z.string().min(1).optional() }).strict(),
    run: (ctx, a) => {
      const videoId = a.video_id ?? ctx.video?.id;
      const all = videoId ? listSources(ctx.db, ctx.project.id, { videoId }) : listSources(ctx.db, ctx.project.id, { projectOnly: true });
      return {
        text: json({
          project: all.filter((s) => !s.video_id).map((s) => slimSource(ctx, s)),
          video: videoId ? { id: videoId, index: videoIndexPath(videoId), sources: all.filter((s) => s.video_id).map((s) => slimSource(ctx, s)) } : null,
          hint: all.some((s) => s.kind === "ag_go_project") ? `Tìm video trong các project ${siteOf(ctx)} bằng footage_search.` : undefined,
        }),
      };
    },
  }),
  tool({
    name: "footage_search",
    description: "Tìm video đã phân tích trong các project {{site}} của dự án (người dùng chọn ở tab Đầu vào). `q` tìm theo nội dung (tiếng Việt được), bỏ trống để liệt kê. Trả id, tên, độ dài, có lời nói không, tóm tắt, trạng thái chuẩn bị.",
    input: z.object({
      q: z.string().trim().min(1).max(200).optional(),
      ag_go_project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).optional(),
    }).strict(),
    run: async (ctx, a) => {
      const { footage, actAs } = footageOf(ctx);
      const projects = listSources(ctx.db, ctx.project.id).filter((s) => s.kind === "ag_go_project").map((s) => s.ref);
      if (!projects.length) return { text: `Dự án chưa có project ${siteOf(ctx)} nào. Nhờ người dùng chọn ở tab Đầu vào (hoặc thêm từng video).`, isError: true };
      if (a.ag_go_project_id && !projects.includes(a.ag_go_project_id)) {
        return { text: `Project ${siteOf(ctx)} ${a.ag_go_project_id} không thuộc đầu vào của dự án (có: ${projects.join(", ")}).`, isError: true };
      }
      const r = await footage.search(actAs, { projectIds: a.ag_go_project_id ? [a.ag_go_project_id] : projects, ...(a.q ? { q: a.q } : {}), limit: a.limit ?? 30, ...(a.cursor ? { cursor: a.cursor } : {}) });
      return {
        text: json({
          total: r.total, next_cursor: r.nextCursor,
          items: r.items.map((i) => ({
            asset_id: i.assetId, name: i.name, duration_s: Math.round(i.durationMs / 100) / 10, size: i.width && i.height ? `${i.width}x${i.height}` : null,
            has_speech: i.hasSpeech ?? null, projects: i.projectNames ?? [], summary: i.summaryVi ?? null, prepared: assetState(ctx, i.assetId).state,
          })),
        }),
      };
    },
  }),
  tool({
    name: "inputs_add",
    description: "Thêm video {{site}} vào video của luồng này (hoặc `video_id`), theo thứ tự dùng. Lấy asset_id và `name` (bắt buộc, người dùng đọc tên này) từ footage_search. Studio kiểm chủ dự án dùng được video đó. Sau đó gọi inputs_prepare cho video chưa chuẩn bị.",
    input: z.object({
      assets: z.array(z.object({ asset_id: z.string().regex(ASSET_ID), name: z.string().trim().min(1).max(200) }).strict()).min(1).max(40),
      video_id: z.string().min(1).optional(),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const videoId = targetVideo(ctx, a.video_id);
      const { footage, actAs } = footageOf(ctx);
      const { missing } = await footage.check(actAs, a.assets.map((x) => x.asset_id));
      if (missing.length) {
        return { text: `${siteOf(ctx)} không cho chủ dự án dùng các video: ${missing.join(", ")} (không có quyền hoặc chưa có bản xem). Không thêm gì.`, isError: true };
      }
      for (const x of a.assets) {
        addSource(ctx.db, { projectId: ctx.project.id, videoId, kind: "ag_go_asset", ref: x.asset_id, mediaType: "video", label: x.name, addedBy: ctx.claims.sub }, ctx.now());
      }
      const index = writeVideoIndex(ctx.db, ctx.workspaceDir, ctx.project.id, videoId);
      return { text: json({ video_id: videoId, index: videoIndexPath(videoId), sources: index.sources.map((s) => ({ index: s.index, asset_id: s.asset_id, name: s.name, status: s.status })) }) };
    },
  }),
  tool({
    name: "inputs_prepare",
    description: "Chuẩn bị video {{site}} để chọn cảnh (việc nền: tải bản xem 480p, dò cảnh, khung hình, tờ ghép, lời thoại qua farm) vào inputs/<asset>/. Mỗi video chỉ chuẩn bị một lần cho cả dự án. `wait_s` (≤ 60) chờ xong trong lượt này; chưa xong thì Studio báo vào luồng khi xong và bạn làm tiếp.",
    input: z.object({
      asset_ids: z.array(z.string().regex(ASSET_ID)).min(1).max(40),
      wait_s: z.number().int().min(0).max(60).optional(),
      again: z.boolean().optional(),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const queued = queuePrepare(ctx.db, {
        projectId: ctx.project.id, assetIds: a.asset_ids, threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role,
        ...(a.again ? { again: true } : {}),
      }, ctx.now());
      const jobs: string[] = [];
      const answer: Record<string, unknown> = {};
      for (const [id, st] of Object.entries(queued)) {
        answer[id] = st.state === "not_an_input" ? { state: "not_an_input", hint: "thêm vào video bằng inputs_add trước" } : st;
        if ("job_id" in st) jobs.push(st.job_id);
      }
      const until = Date.now() + (a.wait_s ?? 0) * 1000;
      while (jobs.length && Date.now() < until) {
        if (jobs.every((j) => { const s = getJob(ctx.db, j)?.status; return s !== "queued" && s !== "running"; })) break;
        await sleep(1000);
      }
      for (const id of a.asset_ids) if (answer[id] && (answer[id] as { state: string }).state !== "not_an_input") answer[id] = assetState(ctx, id);
      const pending = jobs.filter((j) => { const s = getJob(ctx.db, j)?.status; return s === "queued" || s === "running"; });
      return {
        text: json({
          assets: answer,
          ...(pending.length ? { note: `Còn ${pending.length} việc đang chạy: Studio báo vào luồng khi xong. Có thể làm việc khác hoặc kết thúc lượt.` } : {}),
        }),
      };
    },
  }),
  tool({
    name: "input_describe",
    description: "Tóm tắt một video {{site}} đã chuẩn bị: thư mục, số cảnh, có lời thoại không, đường dẫn README/shots/transcript. Đọc các file đó bằng Read để xem chi tiết.",
    input: z.object({ asset_id: z.string().regex(ASSET_ID) }).strict(),
    run: (ctx, a) => ({ text: json({ asset_id: a.asset_id, ...assetState(ctx, a.asset_id) }) }),
  }),
  tool({
    name: "job_status",
    description: "Việc nền của dự án: một việc (`job_id`) hoặc các việc đang chạy và 10 việc gần nhất — loại, trạng thái, đang làm gì, tiến độ 0–1, còn khoảng bao nhiêu giây, máy farm.",
    input: z.object({ job_id: z.string().min(1).optional() }).strict(),
    run: (ctx, a) => {
      if (a.job_id) {
        const j = getJob(ctx.db, a.job_id);
        if (!j || j.project_id !== ctx.project.id) throw new StudioRunError("not_found", `không có việc ${a.job_id} trong dự án`);
        return { text: json(jobLine(j)) };
      }
      const active = listJobs(ctx.db, ctx.project.id, { active: true });
      const recent = listJobs(ctx.db, ctx.project.id, { limit: 10 }).filter((j) => j.status !== "queued" && j.status !== "running");
      return { text: json({ active: active.map(jobLine), recent: recent.map(jobLine) }) };
    },
  }),
  tool({
    name: "job_cancel",
    description: "Dừng một việc nền của dự án (đang chờ thì huỷ ngay; đang chạy thì dừng ffmpeg / huỷ job farm). Chỉ khi người dùng muốn dừng.",
    input: z.object({ job_id: z.string().min(1) }).strict(),
    role: "editor",
    run: (ctx, a) => {
      const j = getJob(ctx.db, a.job_id);
      if (!j || j.project_id !== ctx.project.id) throw new StudioRunError("not_found", `không có việc ${a.job_id} trong dự án`);
      const after = requestJobCancel(ctx.db, a.job_id, ctx.now());
      return { text: after.status === "cancelled" ? `Đã huỷ: ${after.title}.` : after.status === "running" ? `Đang dừng: ${after.title}.` : `Việc đã ${after.status}, không cần dừng.` };
    },
  }),
];
