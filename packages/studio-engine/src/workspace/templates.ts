/**
 * A new project's workspace (spec 2026-10-10 agent-workspace §3.1): CLAUDE.md about the channel (the agent reads it
 * every turn), the lessons file it imports, a short guide to the folders, and the marker the API and the worker
 * check to know they see the same disk.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./files.js";
import type { ProjectRecord } from "./project-db.js";

export const WORKSPACE_FOLDERS = ["context", "research", "channel", "videos", "threads", "skills", "memory", ".studio"] as const;

export function claudeMdTemplate(p: Pick<ProjectRecord, "name" | "channel_url" | "description" | "language" | "aspect">): string {
  return `# ${p.name}

> Đây là "trí nhớ" của dự án: agent đọc file này ở mọi lượt chat. Sửa trực tiếp hoặc nhắn agent sửa giúp.

## Kênh
- Kênh YouTube: ${p.channel_url ?? "(chưa có)"}
- Ngôn ngữ: ${p.language} · Khung hình: ${p.aspect}
- Mô tả: ${p.description.trim() || "(chưa có)"}

## Khán giả và giọng điệu
- (Ai xem kênh, họ muốn gì, kênh nói chuyện thế nào.)

## Quy tắc của kênh
- (Điều luôn làm và không bao giờ làm: độ dài video, nhịp dựng, chữ trên hình, nhạc, lời dẫn…)

## Tài liệu trong dự án
- \`context/\`: tài liệu tham khảo người dùng đưa vào.
- \`research/\`: số liệu và báo cáo nghiên cứu thị trường.
- \`channel/\`: chiến lược kênh, phong cách dựng, branding.
- \`videos/<id>/\`: mọi thứ của từng video (brief, chọn cảnh, kế hoạch dựng, gói YouTube…).

## Bài học
@memory/lessons.md
`;
}

const LESSONS = `# Bài học của dự án

<!-- Studio thêm vào đây khi bạn bấm "Lưu vào bài học dự án". Sửa hoặc xoá thoải mái. -->
`;

const CONTEXT_README = `# Tài liệu tham khảo

Đặt ở đây mọi thứ agent nên biết khi làm cho kênh: ghi chú, kịch bản mẫu, số liệu, ảnh tham khảo, PDF.
Agent đọc được mọi file chữ (md, txt, csv, json) và ảnh; PDF thì đọc được phần chữ.
`;

/** Creates the project's folder and files (idempotent: an existing file is never overwritten). Answers the folder. */
export function seedWorkspace(root: string, project: ProjectRecord, now = new Date().toISOString()): string {
  const dir = projectDir(root, project.id);
  for (const f of WORKSPACE_FOLDERS) mkdirSync(join(dir, f), { recursive: true });
  const files: [string, string][] = [
    ["CLAUDE.md", claudeMdTemplate(project)],
    [join("memory", "lessons.md"), LESSONS],
    [join("context", "README.md"), CONTEXT_README],
    [join(".studio", "workspace.json"), JSON.stringify({ project_id: project.id, team_id: project.team_id, created_at: now }, null, 2) + "\n"],
  ];
  for (const [rel, content] of files) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) writeFileSync(abs, content);
  }
  return dir;
}
