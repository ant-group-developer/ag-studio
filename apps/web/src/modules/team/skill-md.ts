/**
 * Team skills as `.md` files: import (frontmatter `name` / `description` / `applies_to`, like a SKILL.md), export,
 * and the starter templates a team begins from.
 */
import type { TeamSkillStep } from "../../api/studio-client";

/** Canonical order of the steps (the API keeps the same order). */
export const SKILL_STEPS: TeamSkillStep[] = ["intake", "trend-report", "style", "rnd", "branding", "plan-episodes", "timeline", "youtube-kit"];
/** Character limits shared with the API (`TEAM_SKILL_LIMITS`). */
export const SKILL_LIMITS = { name: 100, purpose: 500, content: 20_000, enabledTotal: 60_000 } as const;

export interface SkillFile {
  name: string;
  purpose: string;
  appliesTo: TeamSkillStep[];
  content: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function steps(v: string): TeamSkillStep[] {
  const items = v.trim().replace(/^\[|\]$/g, "").split(",").map((x) => unquote(x)).filter(Boolean);
  return SKILL_STEPS.filter((s) => items.includes(s));
}

/** A `.md` file -> skill fields. No frontmatter name: the first `# heading`, else the file name. */
export function parseSkillMarkdown(text: string, fileName: string): SkillFile {
  const normalized = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1]!.split("\n")) {
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!;
    }
  }
  const content = (fm ? normalized.slice(fm[0].length) : normalized).trim();
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const name = (meta.name !== undefined ? unquote(meta.name) : "") || heading || fileName.replace(/\.[^.]+$/, "");
  const purposeRaw = meta.description ?? meta.purpose;
  const stepsRaw = meta.applies_to ?? meta.appliesto ?? meta.steps;
  return {
    name: name.slice(0, SKILL_LIMITS.name),
    purpose: purposeRaw !== undefined ? unquote(purposeRaw) : "",
    appliesTo: stepsRaw !== undefined ? steps(stepsRaw) : [],
    content,
  };
}

/** Skill fields -> a `.md` file with frontmatter (double-quoted values, so `:` and quotes survive). */
export function toSkillMarkdown(skill: SkillFile): string {
  return [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.purpose)}`,
    `applies_to: [${skill.appliesTo.join(", ")}]`,
    "---",
    "",
    skill.content.trim(),
    "",
  ].join("\n");
}

/** `Quy chuẩn làm video!` -> `quy-chuan-lam-video.md`. */
export function skillFileName(name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${slug || "quy-chuan"}.md`;
}

/** Starting points a team edits to its own rules ("Tạo từ mẫu"). */
export const STARTER_TEMPLATES: SkillFile[] = [
  {
    name: "Quy chuẩn làm video",
    purpose: "Mục đích kênh và các quy tắc mọi tập phải theo",
    appliesTo: [],
    content: `# Quy chuẩn làm video của nhóm

## Mục đích kênh
- Kênh làm cho ai, giúp họ điều gì: …
- Một câu định vị: "…"

## Khán giả
- Độ tuổi, sở thích, xem trên điện thoại hay TV: …

## Nội dung
- 5 giây đầu phải có cảnh đẹp nhất hoặc một câu hỏi gây tò mò.
- Mỗi tập kể trọn một câu chuyện: mở đầu → phát triển → kết.
- Không đặt hai cảnh gần giống nhau liền nhau.

## Nhịp dựng
- Đổi cảnh ít nhất mỗi … giây; đoạn chậm không quá … giây.

## Tiêu đề
- Tối đa 60 ký tự, từ khoá chính ở đầu.
- Không giật tít sai sự thật, không viết hoa toàn bộ.

## Thumbnail
- Tối đa 4 chữ, chữ to, tương phản mạnh với nền.
- Ưu tiên cận cảnh khuôn mặt hoặc chủ thể chính.

## Mô tả và tag
- Hai dòng đầu nói người xem nhận được gì.
- Luôn có hashtag thương hiệu: #…

## Nhạc
- Mood: …; tránh nhạc có lời khi trên hình có chữ.

## Điều cấm
- Không nhắc tên đối thủ; không nội dung nhạy cảm (chính trị, tôn giáo); không hứa điều video không có.
`,
  },
  {
    name: "Phong cách tiêu đề và thumbnail",
    purpose: "Cách đặt tiêu đề, mô tả và chữ trên thumbnail của nhóm",
    appliesTo: ["branding", "youtube-kit"],
    content: `# Phong cách tiêu đề và thumbnail

## Công thức tiêu đề hay dùng
- "[Từ khoá chính] — [điều bất ngờ / con số]"
- "Lần đầu [trải nghiệm] ở [địa điểm]"

## Giọng văn
- Thân thiện, như kể cho bạn bè; xưng "mình", gọi người xem là "bạn".
- Không dùng từ: "sốc", "không thể tin nổi", "bí mật động trời".

## Chữ trên thumbnail
- 2–4 chữ, viết hoa chữ cái đầu, không emoji.
- Màu chữ: trắng viền đen; nhấn bằng màu thương hiệu: #…

## Hashtag cố định
- #… #…
`,
  },
];
