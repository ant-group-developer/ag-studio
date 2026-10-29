/**
 * The agent's YouTube research tools (spec 2026-10-10 agent-workspace §P5): each queues a `research` job (a crawl
 * written to `research/<date>-<slug>.{md,json}`) and may wait for it up to a minute. Large crawls (> 500 API units or
 * > 100 videos) are not run by the agent: a person starts them from the Research tab. `style_from_files` learns an edit
 * style from videos people uploaded (job `style_watch`): nothing leaves Studio, so no confirmation card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CrawlRequestSchema, estimateCrawlUnits, isLargeCrawl, type CrawlRequestInput, type StudioCrawl } from "@harness/contracts";
import { createJob, getJob } from "../workspace/jobs-db.js";
import { referenceFile, STYLE_WATCH_MAX } from "../workspace/style-watch.js";
import { queueResearch } from "../workspace/research.js";
import type { AgentTool, AgentToolContext, ToolAnswer } from "./tools.js";

const json = (v: unknown) => JSON.stringify(v, null, 2);
const tool = <I extends z.ZodTypeAny>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const region = z.string().regex(/^[A-Z]{2}$/).optional().describe("Mã quốc gia 2 chữ in hoa, mặc định VN");
const waitS = z.number().int().min(0).max(60).optional().describe("Chờ xong tối đa bấy nhiêu giây (mặc định 45)");

/** What the agent reads of a finished crawl: the file, the first rows, the quick notes. */
function summary(ctx: AgentToolContext, file: string): Record<string, unknown> {
  try {
    const doc = JSON.parse(readFileSync(join(ctx.workspaceDir, file.replace(/\.md$/, ".json")), "utf8")) as StudioCrawl;
    const row = (v: StudioCrawl["videos"][number]) => ({ title: v.title, channel: v.channel_title, views: v.views, views_per_day: v.views_per_day, duration_s: v.duration_s, published: v.published_at.slice(0, 10), outlier: v.outlier, id: v.video_id });
    return {
      file, source: doc.source, quota_units: doc.quota_units, notes: doc.notes,
      ...(doc.channels.length ? { channels: doc.channels.slice(0, 10).map((c) => ({ title: c.title, subscribers: c.subscribers, total_views: c.total_views, best: c.videos[0]?.title ?? null })) } : {}),
      ...(doc.videos.length ? { videos: doc.videos.slice(0, 10).map(row), more: Math.max(0, doc.videos.length - 10) } : {}),
      insights: { median_views_per_day: doc.insights.median_views_per_day, title_terms: doc.insights.top_title_terms.slice(0, 10), durations: doc.insights.duration_buckets },
    };
  } catch {
    return { file };
  }
}

async function crawl(ctx: AgentToolContext, input: CrawlRequestInput, waitSeconds: number | undefined): Promise<ToolAnswer> {
  const parsed = CrawlRequestSchema.safeParse(input);
  if (!parsed.success) return { text: `Tham số sai: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  const r = parsed.data;
  if (isLargeCrawl(r)) {
    return {
      text: `Crawl này lớn (≈ ${estimateCrawlUnits(r)} đơn vị hạn mức API, tối đa ${r.kind === "top_channels" ? r.max * 5 : r.max} video): cần người dùng xác nhận: gọi propose_action kind crawl_large với params {crawl: …} (hoặc nhờ họ bấm "Chạy nghiên cứu" ở tab Tài liệu), hoặc giảm số lượng.`,
      isError: true,
    };
  }
  const job = await queueResearch(ctx.db, { projectId: ctx.project.id, crawl: r, threadId: ctx.thread.id, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role }, ctx.now());
  const until = Date.now() + (waitSeconds ?? 45) * 1000;
  for (;;) {
    const j = (await getJob(ctx.db, job.id))!;
    if (j.status === "done") {
      const files = (j.result as { files?: string[] } | null)?.files ?? [];
      return { text: json({ job_id: j.id, status: "done", ...summary(ctx, files[0] ?? "") }) };
    }
    if (j.status === "failed" || j.status === "cancelled") return { text: `Không crawl được: ${j.error ?? j.status}`, isError: true };
    if (Date.now() >= until) {
      return { text: json({ job_id: j.id, status: j.status, phase: j.phase, note: "Đang chạy nền: Studio báo vào luồng khi xong, bạn sẽ làm tiếp." }) };
    }
    await sleep(1000);
  }
}

export const RESEARCH_TOOLS: AgentTool[] = [
  tool({
    name: "youtube_trending",
    description: "Video đang xu hướng (Thịnh hành) trên YouTube ở một quốc gia, tuỳ chọn theo danh mục (ví dụ 19 = Du lịch & sự kiện). Ghi kết quả vào research/<ngày>-xu-huong-<vùng>.md (+ .json). Cần YOUTUBE_API_KEY ở worker.",
    input: z.object({ region, category: z.string().regex(/^\d{1,3}$/).optional(), max: z.number().int().min(1).max(100).optional(), wait_s: waitS }).strict(),
    role: "editor",
    run: (ctx, a) => crawl(ctx, { kind: "trending", ...(a.region ? { region: a.region } : {}), ...(a.category ? { category: a.category } : {}), ...(a.max ? { max: a.max } : {}) }, a.wait_s),
  }),
  tool({
    name: "youtube_search",
    description: "Video xem nhiều nhất (hoặc liên quan nhất, mới nhất) về một chủ đề trong N ngày gần đây, mặc định 30 video, 90 ngày. Ghi research/<ngày>-chu-de-<chủ đề>.md (+ .json): bảng video, lượt xem/ngày, độ dài, từ hay gặp trong tiêu đề.",
    input: z.object({
      q: z.string().trim().min(1).max(200), region, days: z.number().int().min(1).max(3650).optional(),
      order: z.enum(["viewCount", "relevance", "date"]).optional(), max: z.number().int().min(1).max(100).optional(), wait_s: waitS,
    }).strict(),
    role: "editor",
    run: (ctx, a) => crawl(ctx, {
      kind: "topic", q: a.q, ...(a.region ? { region: a.region } : {}), ...(a.days ? { days: a.days } : {}), ...(a.order ? { order: a.order } : {}), ...(a.max ? { max: a.max } : {}),
    }, a.wait_s),
  }),
  tool({
    name: "youtube_top_channels",
    description: "Kênh hàng đầu về một chủ đề (theo người đăng ký), mỗi kênh kèm vài video xem nhiều gần đây. Mặc định 10 kênh. Ghi research/<ngày>-kenh-top-<chủ đề>.md (+ .json).",
    input: z.object({ q: z.string().trim().min(1).max(200), region, max: z.number().int().min(1).max(25).optional(), wait_s: waitS }).strict(),
    role: "editor",
    run: (ctx, a) => crawl(ctx, { kind: "top_channels", q: a.q, ...(a.region ? { region: a.region } : {}), max: a.max ?? 10 }, a.wait_s),
  }),
  tool({
    name: "youtube_channel_top_videos",
    description: "Video xem nhiều nhất của một kênh, mặc định 30. `channel`: link, @handle hoặc ID kênh; chỉ có tên kênh thì Studio tìm kênh mang tên đó và ghi trong ghi chú kênh nào đã chọn. Ghi research/<ngày>-kenh-<kênh>.md (+ .json).",
    input: z.object({ channel: z.string().trim().min(2).max(300), max: z.number().int().min(1).max(100).optional(), wait_s: waitS }).strict(),
    role: "editor",
    run: (ctx, a) => crawl(ctx, { kind: "channel_top", channel: a.channel, ...(a.max ? { max: a.max } : {}) }, a.wait_s),
  }),
  tool({
    name: "style_from_files",
    description: [
      "Học phong cách dựng từ video mẫu người dùng đã tải lên dự án (file video trong context/, thường context/references/; tối đa 5):",
      "Studio đo nhịp cắt (độ dài shot, số lần cắt/phút, mở đầu) và ghép khung hình thành tờ ghép trong research/style-<ngày>-<n>/",
      "(README.md, watch.json, *-sheet-*.jpg), không đổi hay xoá file của người dùng. Chạy nền, không cần thẻ xác nhận;",
      "Studio báo vào luồng khi xong, rồi bạn đọc README và tờ ghép để viết channel/style.md.",
      "Dùng khi người dùng có video mẫu, nhất là khi YouTube đang chặn tải từ máy chủ Studio. Xem file đã tải lên bằng inputs_list.",
    ].join(" "),
    input: z.object({
      paths: z.array(z.string().min(1).max(300)).min(1).max(STYLE_WATCH_MAX),
      purpose: z.string().trim().min(1).max(300).describe("Học gì từ các video này (nhịp dựng, mở đầu, chuyển cảnh…)"),
    }).strict(),
    role: "editor",
    run: async (ctx, a) => {
      const files = [...new Set(a.paths.map((p) => referenceFile(ctx.workspaceDir, p).path))];
      const job = await createJob(ctx.db, {
        projectId: ctx.project.id, threadId: ctx.thread.id, kind: "style_watch", title: `Học phong cách từ ${files.length} video tải lên`,
        request: { files, purpose: a.purpose }, continueAgent: true, createdBy: ctx.claims.sub, actorRole: ctx.role,
      }, ctx.now());
      return { text: json({ job_id: job.id, status: job.status, files, note: "Đang chạy nền: Studio báo vào luồng khi xong. Kết thúc lượt." }) };
    },
  }),
];
