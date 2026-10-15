/**
 * The Studio tools an agent turn calls through its MCP server (spec 2026-10-10 agent-workspace §3.3, ADR-0001 item
 * 183). Each tool checks its input with zod, needs a minimum team role of the person the turn acts for, and answers
 * text for the agent (short, often JSON). Tools grow by phase; this file holds the registry and the project tools.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { toolInputJsonSchema, VIDEO_STATUSES } from "@harness/contracts";
import { StudioRunError } from "../errors.js";
import { DEFAULT_SITE_NAME, withSiteName } from "../site-name.js";
import type { StudioDb } from "../studio-db.js";
import { createVideo, listVideos, projectView, requireVideo, updateVideo, type ProjectRecord, type VideoRecord } from "../workspace/project-db.js";
import { normalizeRelPath, recordFileVersion } from "../workspace/files.js";
import { playbookStatus, type StepFact } from "../workspace/playbook-status.js";
import { validateWorkspaceFile, validatorFor } from "../workspace/validators.js";
import type { AgentTokenClaims } from "./token.js";
import { threadMarkdown } from "./history.js";
import { getThread, listThreads, videoThread, type ActorRole, type MessageRecord, type ThreadRecord } from "./threads-db.js";
import { INPUT_TOOLS, type ProjectFootage } from "./input-tools.js";
import { projectAudioSummary, videoMusicSummary } from "../workspace/project-audio.js";
import { RESEARCH_TOOLS } from "./research-tools.js";
import { ACTION_TOOLS } from "./action-tools.js";
import { TIMELINE_TOOLS } from "./timeline-tools.js";

/** What a tool call runs with: the turn, its project (and video), the workspace folder. */
export interface AgentToolContext {
  db: StudioDb;
  claims: AgentTokenClaims;
  message: MessageRecord;
  thread: ThreadRecord;
  project: ProjectRecord;
  video: VideoRecord | null;
  workspaceDir: string;
  role: ActorRole;
  now: () => string;
  /** What Studio knows of the playbook's `studio` steps (later phases). */
  stepFacts?: (key: string, videoId: string | null) => StepFact | undefined;
  /** ag-go as the API reaches it (search the project's ag-go projects, check a video is usable); absent: no ag-go. */
  footage?: ProjectFootage;
  /** What people call the footage library (ag-go's `siteName`); default "AG Go". */
  siteName?: string;
  /** Farm machines online that fetch reference videos (`studio.reference_fetch`); absent: none. */
  referenceFetchers?: () => Promise<string[]>;
}

export interface ToolAnswer {
  text: string;
  isError?: boolean;
}

export interface AgentTool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  /** The person the turn acts for needs at least this role (default viewer). */
  role?: ActorRole;
  run(ctx: AgentToolContext, args: z.infer<I>): ToolAnswer | Promise<ToolAnswer>;
}

const ORDER: ActorRole[] = ["viewer", "editor", "producer", "owner"];
const json = (v: unknown) => JSON.stringify(v, null, 2);
const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;

const videoBrief = (title: string, brief: string, now: string) =>
  `---\nstatus: draft\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${brief.trim()}\n\n<!-- brief tạo ${now.slice(0, 10)} -->\n`;

export const PROJECT_TOOLS: AgentTool[] = [
  tool({
    name: "project_info",
    description: "Thông tin dự án (kênh) đang làm: tên, kênh YouTube, mô tả, ngôn ngữ, khung hình, cài đặt, giọng đọc và nhạc nền, danh sách video (id, số, tên, trạng thái), và video của luồng này nếu có (kèm nhạc của video: nhạc riêng do người dùng chọn ở tab Đầu vào của video, không có thì nhạc dự án).",
    input: z.object({}).strict(),
    run: async (ctx) => ({
      text: json({
        project: { ...projectView(ctx.project), workspace: ".", audio: await projectAudioSummary(ctx.db, ctx.project.id) },
        videos: (await listVideos(ctx.db, ctx.project.id)).map((v) => ({ id: v.id, idx: v.idx, title: v.title, status: v.status, folder: `videos/${v.id}/` })),
        this_thread: {
          id: ctx.thread.id, kind: ctx.thread.kind, title: ctx.thread.title, video_id: ctx.thread.video_id,
          ...(ctx.thread.video_id ? { video_music: await videoMusicSummary(ctx.db, ctx.project.id, ctx.thread.video_id) } : {}),
        },
      }),
    }),
  }),
  tool({
    name: "video_list",
    description: "Danh sách video của dự án, mới nhất trước: id, số thứ tự, tên, trạng thái, thư mục.",
    input: z.object({}).strict(),
    run: async (ctx) => ({
      text: json((await listVideos(ctx.db, ctx.project.id)).map((v) => ({ id: v.id, idx: v.idx, title: v.title, status: v.status, folder: `videos/${v.id}/` }))),
    }),
  }),
  tool({
    name: "video_create",
    description: "Tạo một video mới trong dự án (mỗi video có thư mục videos/<id>/ và luồng chat riêng). Dùng khi người dùng muốn thêm video, ví dụ từ các ý tưởng vừa bàn. `brief` (markdown) được ghi vào videos/<id>/brief.md.",
    input: z.object({
      title: z.string().trim().min(1).max(200),
      brief: z.string().max(20_000).optional(),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const now = ctx.now();
      const video = await createVideo(ctx.db, ctx.project.id, { title: a.title, createdBy: ctx.claims.sub }, now);
      mkdirSync(join(ctx.workspaceDir, "videos", video.id), { recursive: true });
      await videoThread(ctx.db, { projectId: ctx.project.id, videoId: video.id, title: a.title, createdBy: ctx.claims.sub }, now);
      if (a.brief?.trim()) {
        const path = `videos/${video.id}/brief.md`;
        const text = videoBrief(a.title, a.brief, now);
        writeFileSync(join(ctx.workspaceDir, "videos", video.id, "brief.md"), text);
        await recordFileVersion(ctx.db, { projectId: ctx.project.id, path, bytes: Buffer.from(text, "utf8"), author: { kind: "agent", id: ctx.claims.sub, messageId: ctx.message.id }, now });
      }
      return { text: json({ id: video.id, idx: video.idx, title: video.title, folder: `videos/${video.id}/`, brief: a.brief ? `videos/${video.id}/brief.md` : null }) };
    },
  }),
  tool({
    name: "video_update",
    description: "Đổi tên hoặc trạng thái một video (draft, in_progress, rendering, done). Bỏ `video_id` = video của luồng này.",
    input: z.object({
      video_id: z.string().min(1).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      status: z.enum(VIDEO_STATUSES).optional(),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const id = a.video_id ?? ctx.video?.id;
      if (!id) throw new StudioRunError("invalid", "luồng này không gắn với video nào: cho biết video_id", { code: "no_video" });
      const v = await requireVideo(ctx.db, id);
      if (v.project_id !== ctx.project.id) throw new StudioRunError("invalid", "video thuộc dự án khác", { code: "other_project" });
      const out = await updateVideo(ctx.db, id, { ...(a.title ? { title: a.title } : {}), ...(a.status ? { status: a.status } : {}) }, ctx.now());
      return { text: json({ id: out.id, title: out.title, status: out.status }) };
    },
  }),
  tool({
    name: "suggest_replies",
    description: "Gợi ý 1–4 câu trả lời ngắn để người dùng bấm thay vì gõ (ví dụ các lựa chọn khi bạn hỏi lại). Gọi ở cuối lượt.",
    input: z.object({ options: z.array(z.string().trim().min(1).max(120)).min(1).max(4) }).strict(),
    run: (_ctx, a) => ({ text: `Đã hiện ${a.options.length} gợi ý cho người dùng.` }),
  }),
  tool({
    name: "playbook_status",
    description: "Tiến độ theo quy trình gợi ý của dự án (và video của luồng này): từng bước, trạng thái (missing, draft, invalid, done, skipped, stale, running), file của bước, lỗi, và các bước gợi ý tiếp theo (next) theo phạm vi: luồng video chỉ gợi ý bước của video, luồng kênh chỉ gợi ý bước của kênh; outside_requires là bước của phạm vi kia mà bước này dựa vào nhưng chưa xong (chỉ là ghi chú). Chỉ là gợi ý: không bước nào bắt buộc.",
    input: z.object({ video_id: z.string().min(1).optional() }).strict(),
    run: async (ctx, a) => {
      const videoId = a.video_id ?? ctx.video?.id ?? null;
      const st = await playbookStatus(ctx.db, ctx.workspaceDir, { projectId: ctx.project.id, videoId, ...(ctx.stepFacts ? { facts: ctx.stepFacts } : {}), now: ctx.now() });
      const slim = (x: typeof st.project) => x.map((t) => ({ key: t.key, title: t.title, status: t.status, file: t.primary, skill: t.skill, optional: t.optional, requires: t.requires, issues: t.issues.map((i) => `[${i.level}] ${i.message}`), stale_because: t.staleBecause, outside_requires: t.outsideRequires, detail: t.detail }));
      return { text: json({ custom_playbook: st.custom, playbook_issues: st.issues, scope: st.scope, project: slim(st.project), video: st.video ? slim(st.video) : null, next: st.next, project_open: st.projectOpen }) };
    },
  }),
  tool({
    name: "validate_file",
    description: "Kiểm một file trong dự án theo những gì Studio đọc từ nó (frontmatter của brief, branding, gói YouTube; style.json; JSON; playbook). Gọi ngay sau khi ghi các file đó; sửa đến khi hết lỗi (error). Cảnh báo (warning) là lời khuyên.",
    input: z.object({ path: z.string().min(1).max(300) }).strict(),
    run: (ctx, a) => {
      const path = normalizeRelPath(a.path);
      const kind = validatorFor(path);
      if (!kind) return { text: `Studio không đọc gì từ ${path}: không có gì để kiểm.` };
      const issues = validateWorkspaceFile(ctx.workspaceDir, path);
      return { text: issues.length ? json({ path, ok: !issues.some((i) => i.level === "error"), issues }) : `${path}: hợp lệ.` };
    },
  }),
  tool({
    name: "thread_history",
    description: "Đọc lịch sử một luồng chat khác của cùng dự án (danh sách luồng: bỏ trống thread_id). `query` lọc các tin có chứa chữ đó; `limit` lấy N tin cuối.",
    input: z.object({
      thread_id: z.string().min(1).optional(),
      query: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }).strict(),
    run: async (ctx, a) => {
      if (!a.thread_id) {
        return { text: json((await listThreads(ctx.db, ctx.project.id)).map((t) => ({ id: t.id, title: t.title, kind: t.kind, video_id: t.video_id, messages: t.message_count, last: t.last_message_at }))) };
      }
      const t = await getThread(ctx.db, a.thread_id);
      if (!t || t.project_id !== ctx.project.id) throw new StudioRunError("not_found", `không có luồng ${a.thread_id} trong dự án`);
      return { text: await threadMarkdown(ctx.db, t, { ...(a.query ? { query: a.query } : {}), limit: a.limit ?? 60 }) };
    },
  }),
];

/** Every tool a turn may call (later phases add theirs here). */
export function agentTools(extra: AgentTool[] = []): AgentTool[] {
  return [...PROJECT_TOOLS, ...INPUT_TOOLS, ...RESEARCH_TOOLS, ...TIMELINE_TOOLS, ...ACTION_TOOLS, ...extra];
}

/** The tools as MCP `tools/list` answers them. */
/** The tools as MCP lists them; `{{site}}` in a description becomes the footage library's name. */
export function agentToolList(
  tools: AgentTool[], opts: { siteName?: string } = {},
): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const site = opts.siteName ?? DEFAULT_SITE_NAME;
  return tools.map((t) => ({ name: t.name, description: withSiteName(t.description, site), inputSchema: toolInputJsonSchema(t.input) }));
}

/** `mcp__studio__<name>` for each tool: what `--allowedTools` lists. */
export const mcpToolNames = (tools: AgentTool[]): string[] => tools.map((t) => `mcp__studio__${t.name}`);

/** Runs one call: unknown tool, bad input, a role too low or a refusal of Studio are errors the agent reads. */
export async function callAgentTool(tools: AgentTool[], ctx: AgentToolContext, name: string, args: unknown): Promise<ToolAnswer> {
  const t = tools.find((x) => x.name === name);
  if (!t) return { text: `Không có tool ${name}.`, isError: true };
  if (ORDER.indexOf(ctx.role) < ORDER.indexOf(t.role ?? "viewer")) {
    return { text: `${name} cần vai ${t.role} trong team; người dùng của lượt này là ${ctx.role}. Hãy nói người dùng nhờ người có quyền.`, isError: true };
  }
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) {
    return { text: `Tham số sai: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`).join("; ")}`, isError: true };
  }
  try {
    return await t.run(ctx, parsed.data);
  } catch (e) {
    if (e instanceof StudioRunError) return { text: e.message, isError: true };
    throw e;
  }
}
