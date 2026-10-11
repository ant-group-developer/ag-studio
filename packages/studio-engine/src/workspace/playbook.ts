/**
 * The steps Studio suggests (spec 2026-10-10 agent-workspace §6, ADR-0001 item 184): for the channel (research →
 * strategy → style → branding) and for each video (brief → inputs → scenes → edit plan → timeline → preview → YouTube
 * kit → thumbnail → final). Only suggestions: the agent and the person may do any step at any time or go back to one.
 * A project replaces them with `.studio/playbook.yaml`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { StudioPlaybookSchema, type PlaybookStep, type StudioPlaybook } from "@harness/contracts";
import type { FileIssue } from "./validators.js";

export const PLAYBOOK_PATH = ".studio/playbook.yaml";

const step = (s: Omit<PlaybookStep, "description" | "requires" | "optional" | "done_when"> & Partial<PlaybookStep>): PlaybookStep => ({
  description: "", requires: [], optional: false, done_when: "doc_done", ...s,
});

export const DEFAULT_PLAYBOOK: StudioPlaybook = {
  schema_version: "studio.playbook/v1",
  steps: [
    step({
      key: "research", scope: "project", title: "Nghiên cứu thị trường", skill: "studio:research-report",
      description: "Video xu hướng và kênh dẫn đầu cùng chủ đề, số liệu thật, cơ hội và khoảng trống cho kênh.",
      outputs: [{ path: "research/report.md", role: "doc" }],
      prompts: {
        do: "Nghiên cứu thị trường cho kênh: tìm video xu hướng và các kênh dẫn đầu cùng chủ đề, rồi viết research/report.md theo skill research-report.",
        redo: "Làm lại nghiên cứu thị trường từ đầu và viết lại research/report.md.",
        revise: "Sửa research/report.md theo góp ý: ",
      },
    }),
    step({
      key: "channel", scope: "project", title: "Chiến lược kênh", skill: "studio:channel-strategy", requires: ["research"],
      description: "Định vị, khán giả, trụ cột nội dung, định dạng video, nhịp đăng.",
      outputs: [{ path: "channel/strategy.md", role: "doc" }],
      prompts: {
        do: "Viết chiến lược kênh channel/strategy.md theo skill channel-strategy, dựa trên research/report.md và CLAUDE.md.",
        redo: "Viết lại chiến lược kênh channel/strategy.md từ đầu.",
        revise: "Sửa channel/strategy.md theo góp ý: ",
      },
    }),
    step({
      key: "style", scope: "project", title: "Phong cách dựng", optional: true, requires: ["channel"],
      description: "Nhịp cắt, chuyển cảnh, chữ, nhạc — học từ video mẫu hoặc theo mô tả.",
      outputs: [{ path: "channel/style.md", role: "doc" }],
      prompts: {
        do: "Viết phong cách dựng của kênh vào channel/style.md: nhịp cắt (độ dài shot), chuyển cảnh, chữ trên hình, nhạc, điều nên và không nên.",
        revise: "Sửa channel/style.md theo góp ý: ",
      },
    }),
    step({
      key: "branding", scope: "project", title: "Branding", skill: "studio:branding", requires: ["channel"],
      description: "Giọng văn, công thức tiêu đề, thumbnail, kiểu chữ trên video, mood nhạc.",
      outputs: [{ path: "channel/branding.md", role: "doc", validator: "branding" }],
      prompts: {
        do: "Viết branding của kênh vào channel/branding.md theo skill branding (có frontmatter text_look, music_mood, thumbnail).",
        redo: "Làm lại branding channel/branding.md từ đầu.",
        revise: "Sửa channel/branding.md theo góp ý: ",
      },
    }),
    step({
      key: "brief", scope: "video", title: "Ý tưởng & brief", skill: "studio:video-brief",
      description: "Video này kể gì, cho ai, dài bao lâu, dùng footage nào, có lời dẫn không.",
      outputs: [{ path: "videos/{video}/brief.md", role: "doc", validator: "brief" }],
      prompts: {
        do: "Viết brief cho video này vào videos/{video}/brief.md theo skill video-brief.",
        redo: "Viết lại brief videos/{video}/brief.md từ đầu.",
        revise: "Sửa videos/{video}/brief.md theo góp ý: ",
      },
    }),
    step({
      key: "prepare", scope: "video", title: "Chuẩn bị đầu vào", requires: ["brief"], done_when: "studio",
      description: "Studio tải footage đã chọn, dò cảnh, trích khung hình và lời nói để agent xem được.",
      outputs: [{ path: "videos/{video}/sources/index.json", role: "studio" }],
      prompts: { do: "Chuẩn bị đầu vào cho video này: liệt kê footage đã chọn rồi gọi inputs_prepare." },
    }),
    step({
      key: "scenes", scope: "video", title: "Chọn cảnh", skill: "studio:scene-selection", requires: ["prepare"],
      description: "Xem contact sheet, chấm điểm và chọn các cảnh dùng được.",
      outputs: [{ path: "videos/{video}/scenes.md", role: "doc" }, { path: "videos/{video}/survey.json", role: "data", validator: "survey" }],
      prompts: {
        do: "Chọn cảnh cho video này theo skill scene-selection: viết videos/{video}/scenes.md và survey.json.",
        revise: "Sửa phần chọn cảnh (scenes.md, survey.json) theo góp ý: ",
      },
    }),
    step({
      key: "edit-plan", scope: "video", title: "Kế hoạch dựng", skill: "studio:edit-plan", requires: ["scenes", "brief"],
      description: "Thứ tự shot, đoạn lấy, lời dẫn, chữ trên hình, tiếng gốc.",
      outputs: [{ path: "videos/{video}/edit-plan.md", role: "doc" }, { path: "videos/{video}/edit-plan.json", role: "data", validator: "edit_plan" }],
      prompts: {
        do: "Viết kế hoạch dựng theo skill edit-plan: videos/{video}/edit-plan.md và edit-plan.json.",
        revise: "Sửa kế hoạch dựng theo góp ý: ",
      },
    }),
    step({
      key: "timeline", scope: "video", title: "Timeline", requires: ["edit-plan"], done_when: "studio",
      description: "Studio dựng timeline từ kế hoạch dựng (đọc lời dẫn, khớp hình).",
      outputs: [{ path: "videos/{video}/timeline.json", role: "studio" }],
      prompts: { do: "Dựng timeline cho video này từ kế hoạch dựng (timeline_from_edit_plan)." },
    }),
    step({
      key: "preview", scope: "video", title: "Xem trước", requires: ["timeline"], done_when: "studio",
      description: "Bản render xem trước của timeline mới nhất.",
      outputs: [{ path: "videos/{video}/renders/preview.md", role: "studio" }],
      prompts: { do: "Render bản xem trước của timeline mới nhất (render_preview)." },
    }),
    step({
      key: "youtube-kit", scope: "video", title: "Gói YouTube", skill: "studio:youtube-kit", requires: ["timeline", "branding"],
      description: "3 tiêu đề, mô tả, tags, hashtag, 3 ý tưởng thumbnail.",
      outputs: [{ path: "videos/{video}/youtube-kit.md", role: "doc", validator: "youtube_kit" }],
      prompts: {
        do: "Viết gói YouTube cho video này vào videos/{video}/youtube-kit.md theo skill youtube-kit.",
        redo: "Viết lại gói YouTube từ đầu.",
        revise: "Sửa videos/{video}/youtube-kit.md theo góp ý: ",
      },
    }),
    step({
      key: "thumbnail", scope: "video", title: "Thumbnail", requires: ["youtube-kit"], done_when: "studio", optional: true,
      description: "Ảnh thumbnail từ khung hình của video, chữ theo branding.",
      outputs: [{ path: "videos/{video}/thumbnails/README.md", role: "studio" }],
      prompts: { do: "Làm thumbnail cho video này theo 3 ý tưởng trong youtube-kit.md (thumbnail_make)." },
    }),
    step({
      key: "final", scope: "video", title: "Bản cuối", requires: ["preview", "youtube-kit"], done_when: "studio",
      description: "Render bản cuối trên farm (người bấm xác nhận).",
      outputs: [{ path: "videos/{video}/renders/final.md", role: "studio" }],
      prompts: { do: "Đề xuất render bản cuối cho video này." },
    }),
  ],
};

/** The project's playbook: `.studio/playbook.yaml` when it checks out, else the default (with why). */
export function loadPlaybook(dir: string): { playbook: StudioPlaybook; custom: boolean; issues: FileIssue[] } {
  const path = join(dir, ...PLAYBOOK_PATH.split("/"));
  if (!existsSync(path)) return { playbook: DEFAULT_PLAYBOOK, custom: false, issues: [] };
  let raw: unknown;
  try { raw = parseYaml(readFileSync(path, "utf8")); } catch (e) {
    return { playbook: DEFAULT_PLAYBOOK, custom: false, issues: [{ level: "error", code: "yaml", message: `${PLAYBOOK_PATH}: YAML sai, dùng quy trình mặc định (${(e as Error).message.split("\n")[0]})` }] };
  }
  const parsed = StudioPlaybookSchema.safeParse(raw);
  if (!parsed.success) {
    return { playbook: DEFAULT_PLAYBOOK, custom: false, issues: parsed.error.issues.map((i) => ({ level: "error" as const, code: "schema", message: `${PLAYBOOK_PATH}: ${i.path.join(".")}: ${i.message} — dùng quy trình mặc định` })) };
  }
  return { playbook: parsed.data, custom: true, issues: [] };
}

/** A step's output path for a video (`{video}` filled). */
export const stepPath = (path: string, videoId: string | null): string => path.replace(/\{video\}/g, videoId ?? "{video}");

/** The default playbook as YAML, to start a project's own `.studio/playbook.yaml` from. */
export function defaultPlaybookYaml(): string {
  return `# Quy trình gợi ý của dự án (sửa được). Sai cú pháp thì Studio báo lỗi và dùng quy trình mặc định.
${stringifyYaml(DEFAULT_PLAYBOOK, { lineWidth: 0 })}`;
}
