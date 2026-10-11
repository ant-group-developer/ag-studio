/**
 * The `research` job (spec 2026-10-10 agent-workspace §P5): one YouTube crawl, written into the project as
 * `research/<date>-<slug>.json` (the numbers, `studio.crawl/v1`) and `.md` (tables and what they say, for people and
 * the agent). Run from the agent's tools or the Research tab.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CrawlRequestSchema, type CrawlRequest, type ResearchVideo, type StudioCrawl } from "@harness/contracts";
import type { StudioDb } from "../studio-db.js";
import { writeWorkspaceFile } from "./files.js";
import type { JobContext, JobOutcome } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import type { ActorRole } from "../agent/threads-db.js";
import type { YoutubeCrawler } from "./youtube-crawl.js";

/** `request` of a `research` job. */
export interface ResearchJobRequest { crawl: CrawlRequest }

export function crawlTitle(r: CrawlRequest): string {
  switch (r.kind) {
    case "trending": return `Xu hướng YouTube ${r.region}${r.category ? ` (danh mục ${r.category})` : ""}`;
    case "topic": return `Video xem nhiều: "${r.q}" (${r.region}, ${r.days} ngày)`;
    case "top_channels": return `Kênh hàng đầu: "${r.q}" (${r.region})`;
    case "channel_top": return `Video xem nhiều nhất của ${r.channel}`;
  }
}

/** ASCII, lowercase, dashes: "Phố cổ Hội An" -> "pho-co-hoi-an". */
export function slugify(text: string, max = 48): string {
  const s = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "") || "x";
}

export function crawlSlug(r: CrawlRequest): string {
  switch (r.kind) {
    case "trending": return `xu-huong-${r.region.toLowerCase()}${r.category ? `-${r.category}` : ""}`;
    case "topic": return `chu-de-${slugify(r.q)}`;
    case "top_channels": return `kenh-top-${slugify(r.q)}`;
    case "channel_top": return `kenh-${slugify(r.channel.replace(/^https?:\/\/(www\.)?youtube\.com\//, ""))}`;
  }
}

const fmt = new Intl.NumberFormat("vi-VN");
const n = (x: number | null) => (x === null ? "—" : fmt.format(Math.round(x)));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
const length = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const link = (v: ResearchVideo) => `[${cell(v.title) || v.video_id}](https://www.youtube.com/watch?v=${v.video_id})`;

function videoTable(videos: ResearchVideo[], withChannel = true): string[] {
  return [
    `| # | Video | ${withChannel ? "Kênh | " : ""}Lượt xem | Xem/ngày | Dài | Đăng |`,
    `|---|---|${withChannel ? "---|" : ""}---|---|---|---|`,
    ...videos.map((v, i) => `| ${i + 1} | ${link(v)}${v.outlier ? " ⭐" : ""} | ${withChannel ? `${cell(v.channel_title)} | ` : ""}${n(v.views)} | ${n(v.views_per_day)} | ${length(v.duration_s)} | ${v.published_at.slice(0, 10)} |`),
  ];
}

/** The crawl as a page to read: what was asked, the tables, what they say. */
export function crawlMarkdown(doc: StudioCrawl): string {
  const r = doc.request;
  const count = doc.channels.length ? `${doc.channels.length} kênh` : `${doc.videos.length} video`;
  const lines = [
    `# ${crawlTitle(r)}`,
    "",
    `Crawl ${doc.fetched_at.slice(0, 16).replace("T", " ")} UTC · ${doc.source === "youtube_api" ? `YouTube Data API (${doc.quota_units} đơn vị hạn mức)` : "yt-dlp"} · ${count}.`,
    "Dữ liệu dạng số ở file `.json` cùng tên. ⭐ = lượt xem/ngày gấp đôi trung vị của danh sách.",
    "",
    ...doc.notes.map((x) => `> ${x}`),
    ...(doc.notes.length ? [""] : []),
  ];
  if (doc.channel) lines.push(`Kênh: **${cell(doc.channel.title ?? doc.channel.channel_id)}** (${n(doc.channel.subscribers)} người đăng ký)`, "");
  if (doc.channels.length) {
    lines.push("## Kênh", "", "| # | Kênh | Người đăng ký | Số video | Tổng lượt xem |", "|---|---|---|---|---|");
    doc.channels.forEach((c, i) => lines.push(`| ${i + 1} | [${cell(c.title) || c.channel_id}](https://www.youtube.com/channel/${c.channel_id}) | ${n(c.subscribers)} | ${n(c.video_count)} | ${n(c.total_views)} |`));
    for (const c of doc.channels) {
      if (!c.videos.length) continue;
      lines.push("", `### ${cell(c.title) || c.channel_id}`, "", ...videoTable(c.videos, false));
    }
    lines.push("");
  }
  if (doc.videos.length) lines.push("## Video", "", ...videoTable(doc.videos, r.kind !== "channel_top"), "");
  const ins = doc.insights;
  lines.push("## Nhận xét nhanh", "", `- Lượt xem/ngày trung vị: ${n(ins.median_views_per_day)}.`);
  if (ins.top_title_terms.length) lines.push(`- Từ hay gặp trong tiêu đề video tốt: ${ins.top_title_terms.slice(0, 15).map((t) => `${t.term} (${t.count})`).join(", ")}.`);
  if (ins.top_tags.length) lines.push(`- Tag hay gặp: ${ins.top_tags.slice(0, 15).map((t) => `${t.term} (${t.count})`).join(", ")}.`);
  lines.push(`- Độ dài: ${ins.duration_buckets.filter((b) => b.count).map((b) => `${b.bucket}: ${b.count}`).join(", ") || "—"}.`, "");
  return lines.join("\n");
}

/** `research/<date>-<slug>`, with `-2`, `-3`… when that crawl already ran today. */
export function researchBase(dir: string, r: CrawlRequest, now: string): string {
  const base = `research/${now.slice(0, 10)}-${crawlSlug(r)}`;
  for (let i = 1; ; i += 1) {
    const b = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(join(dir, `${b}.json`)) && !existsSync(join(dir, `${b}.md`))) return b;
  }
}

/** Queues one crawl as a `research` job of the project. */
export function queueResearch(db: StudioDb, p: {
  projectId: string; crawl: CrawlRequest; threadId?: string | null; continueAgent?: boolean; createdBy: string; actorRole?: ActorRole | null;
}, now = new Date().toISOString()): JobRecord {
  const crawl = CrawlRequestSchema.parse(p.crawl);
  const request: ResearchJobRequest = { crawl };
  return createJob(db, {
    projectId: p.projectId, threadId: p.threadId ?? null, kind: "research", title: crawlTitle(crawl), request,
    units: crawl.kind === "top_channels" ? crawl.max * 5 : crawl.max, continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

export function researchHandler(d: { db: StudioDb; crawler: YoutubeCrawler }): (job: JobRecord, ctx: JobContext) => Promise<JobOutcome> {
  return async (job, ctx) => {
    const req = CrawlRequestSchema.parse((JSON.parse(job.request) as ResearchJobRequest).crawl);
    ctx.setUnits(req.kind === "top_channels" ? req.max * 5 : req.max);
    const doc = await d.crawler.crawl(req, (phase, progress) => ctx.report({ phase, progress }), ctx.signal);
    ctx.checkpoint();
    ctx.report({ phase: "Đang ghi vào research/", progress: 0.98 });
    const base = researchBase(ctx.workspaceDir, req, ctx.now());
    const author = { kind: "studio" as const, id: null };
    writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path: `${base}.json`, content: `${JSON.stringify(doc, null, 2)}\n`, baseSha256: null, author, now: ctx.now() });
    writeWorkspaceFile(d.db, { projectId: job.project_id, dir: ctx.workspaceDir, path: `${base}.md`, content: crawlMarkdown(doc), baseSha256: null, author, now: ctx.now() });
    const what = doc.channels.length ? `${doc.channels.length} kênh` : `${doc.videos.length} video`;
    return {
      result: { files: [`${base}.md`, `${base}.json`], videos: doc.videos.length, channels: doc.channels.length, quota_units: doc.quota_units, source: doc.source },
      message: `Đã lưu nghiên cứu **${crawlTitle(req)}** (${what}${doc.source === "youtube_api" ? `, ${doc.quota_units} đơn vị API` : ", qua yt-dlp"}): \`${base}.md\`.`,
    };
  };
}

/** What the API needs of the crawl contracts (it does not depend on @harness/contracts itself). */
export { CrawlRequestSchema, estimateCrawlUnits, isLargeCrawl, type CrawlRequest, type StudioCrawl } from "@harness/contracts";
