/**
 * Checks of workspace files (spec 2026-10-10 agent-workspace §6, ADR-0001 item 184): the fields Studio reads from a
 * step's document (frontmatter) or data file, run when a person saves, when the agent asks (`validate_file`) and after
 * each turn. Errors are things Studio cannot use as they are; warnings are advice. Files nothing reads are not checked.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  HashtagSchema, PROJECT_ASPECTS, StudioPlaybookSchema, TextLookSchema, YOUTUBE_DESCRIPTION_BODY_MAX, YOUTUBE_TAGS_MAX_CHARS,
  YOUTUBE_TITLE_MAX, type FileValidatorId,
} from "@harness/contracts";
import { contrastRatio, TEXT_LOOK_MIN_CONTRAST, validateStyle } from "@harness/core";
import { readFrontmatter } from "./frontmatter.js";
import { normalizeRelPath } from "./files.js";

export interface FileIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

const status = z.enum(["draft", "done", "skipped"]).optional();

export const BriefFrontmatterSchema = z.object({
  status,
  title: z.string().min(1).max(120),
  target_seconds: z.number().positive().max(4 * 3600).optional(),
  narration: z.enum(["tts", "original", "none"]).optional(),
  aspect: z.enum(PROJECT_ASPECTS).optional(),
  edit_style: z.enum(["whole", "cut"]).optional(),
}).passthrough();

export const BrandingFrontmatterSchema = z.object({
  status,
  series_name: z.string().min(1).max(100).optional(),
  /** How the words look on the video (the render draws exactly this). */
  text_look: TextLookSchema.optional(),
  music_mood: z.array(z.string().min(1).max(40)).max(5).optional(),
  title_max_chars: z.number().int().min(20).max(100).optional(),
  hashtags: z.array(HashtagSchema).max(5).optional(),
  banned_words: z.array(z.string().min(1).max(60)).max(50).optional(),
  thumbnail: z.object({
    max_words: z.number().int().min(1).max(8).optional(),
    text_case: z.enum(["upper", "sentence"]).optional(),
    position: z.enum(["top", "center", "bottom", "left", "right"]).optional(),
  }).passthrough().optional(),
}).passthrough();

export const YoutubeKitFrontmatterSchema = z.object({
  status,
  titles: z.array(z.string().min(1).max(YOUTUBE_TITLE_MAX)).length(3),
  tags: z.array(z.string().min(1).max(100)).max(40).default([]),
  hashtags: z.array(HashtagSchema).max(15).default([]),
  thumbnails: z.array(z.object({
    text: z.string().min(1).max(40),
    asset_id: z.string().min(1).optional(),
    at_seconds: z.number().min(0).optional(),
  }).passthrough()).max(3).default([]),
  playlist: z.string().max(150).optional(),
}).passthrough();

/** Which check a path gets (none: Studio reads nothing from it). */
export function validatorFor(rel: string): FileValidatorId | "playbook" | "json" | "markdown" | null {
  const p = normalizeRelPath(rel);
  if (p === ".studio/playbook.yaml") return "playbook";
  if (/^videos\/[^/]+\/brief\.md$/.test(p)) return "brief";
  if (p === "channel/branding.md") return "branding";
  if (/^videos\/[^/]+\/youtube-kit\.md$/.test(p)) return "youtube_kit";
  if (p === "channel/style.json") return "style";
  if (/\.json$/i.test(p)) return "json";
  if (/\.(md|markdown)$/i.test(p)) return "markdown";
  return null;
}

const zodIssues = (e: z.ZodError): FileIssue[] => e.issues.map((i) => ({
  level: "error", code: "schema", message: `${i.path.join(".") || "(gốc)"}: ${i.message}`,
}));

function frontmatterIssues(text: string, schema: z.ZodTypeAny): { issues: FileIssue[]; data: Record<string, unknown> | null } {
  const fm = readFrontmatter(text);
  if (fm.error) return { issues: [{ level: "error", code: "frontmatter_yaml", message: fm.error }], data: null };
  if (!fm.present) return { issues: [{ level: "error", code: "frontmatter_missing", message: "thiếu khối frontmatter (--- … ---) ở đầu file" }], data: null };
  const parsed = schema.safeParse(fm.data);
  return parsed.success ? { issues: [], data: parsed.data as Record<string, unknown> } : { issues: zodIssues(parsed.error), data: null };
}

/** The checks of one file's text. */
export function validateFileText(rel: string, text: string): FileIssue[] {
  const kind = validatorFor(rel);
  switch (kind) {
    case "brief":
      return frontmatterIssues(text, BriefFrontmatterSchema).issues;
    case "branding": {
      const { issues, data } = frontmatterIssues(text, BrandingFrontmatterSchema);
      const look = data?.text_look as z.infer<typeof TextLookSchema> | undefined;
      if (look) {
        const behind = look.box_color ?? look.outline_color;
        const ratio = contrastRatio(look.text_color, behind);
        if (ratio < TEXT_LOOK_MIN_CONTRAST) {
          issues.push({ level: "error", code: "text_look_no_contrast", message: `text_look: chữ ${look.text_color} trên ${look.box_color ? "hộp" : "viền"} ${behind} chỉ tương phản ${ratio.toFixed(1)}:1 (cần ≥ ${TEXT_LOOK_MIN_CONTRAST}:1)` });
        }
      } else if (data) {
        issues.push({ level: "warning", code: "text_look_missing", message: "chưa có text_look: chữ trên video dùng kiểu mặc định của Studio" });
      }
      return issues;
    }
    case "youtube_kit": {
      const { issues, data } = frontmatterIssues(text, YoutubeKitFrontmatterSchema);
      const description = readFrontmatter(text).body.trim();
      if (!description) issues.push({ level: "error", code: "description_missing", message: "phần thân file (mô tả video) đang trống" });
      if (description.length > YOUTUBE_DESCRIPTION_BODY_MAX) issues.push({ level: "error", code: "description_too_long", message: `mô tả ${description.length} ký tự, tối đa ${YOUTUBE_DESCRIPTION_BODY_MAX}` });
      if (data) {
        const tags = (data.tags as string[]).join(",");
        if (tags.length > YOUTUBE_TAGS_MAX_CHARS) issues.push({ level: "error", code: "tags_too_long", message: `tags tổng ${tags.length} ký tự, tối đa ${YOUTUBE_TAGS_MAX_CHARS}` });
        const titles = data.titles as string[];
        if (new Set(titles).size !== titles.length) issues.push({ level: "error", code: "duplicate_title", message: "ba tiêu đề phải khác nhau" });
        if ((data.thumbnails as unknown[]).length < 3) issues.push({ level: "warning", code: "thumbnails_missing", message: "nên có 3 ý tưởng thumbnail" });
      }
      return issues;
    }
    case "style": {
      let raw: unknown;
      try { raw = JSON.parse(text); } catch (e) { return [{ level: "error", code: "json", message: `JSON sai: ${(e as Error).message}` }]; }
      const v = validateStyle(raw, { watch: null });
      return [
        ...v.problems.map((p) => ({ level: "error" as const, code: p.code, message: p.message })),
        ...v.warnings.map((p) => ({ level: "warning" as const, code: p.code, message: p.message })),
      ];
    }
    case "playbook": {
      let raw: unknown;
      try { raw = parseYaml(text); } catch (e) { return [{ level: "error", code: "yaml", message: `YAML sai: ${(e as Error).message.split("\n")[0]}` }]; }
      const parsed = StudioPlaybookSchema.safeParse(raw);
      return parsed.success ? [] : zodIssues(parsed.error);
    }
    case "json":
      try { JSON.parse(text); return []; } catch (e) { return [{ level: "error", code: "json", message: `JSON sai: ${(e as Error).message}` }]; }
    case "markdown": {
      const fm = readFrontmatter(text);
      return fm.error ? [{ level: "error", code: "frontmatter_yaml", message: fm.error }] : [];
    }
    default:
      return [];
  }
}

/** The checks of a file on disk (none when it is missing or too big to be a document). */
export function validateWorkspaceFile(dir: string, rel: string): FileIssue[] {
  const p = normalizeRelPath(rel);
  const abs = join(dir, ...p.split("/"));
  if (!validatorFor(p) || !existsSync(abs) || statSync(abs).size > 2 * 1024 * 1024) return [];
  return validateFileText(p, readFileSync(abs, "utf8"));
}

export const hasErrors = (issues: FileIssue[]) => issues.some((i) => i.level === "error");
