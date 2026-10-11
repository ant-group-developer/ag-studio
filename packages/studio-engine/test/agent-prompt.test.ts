import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSystemPrompt, agentTurnPrompt, expandImports, type MessageRecord, type ProjectRecord, type ThreadRecord } from "../src/index.js";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "prompt-"));
  mkdirSync(join(dir, "memory"));
  mkdirSync(join(dir, "channel"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Kênh\nNhạc nhẹ.\n\n@memory/lessons.md\n@channel/rules.md\n@../secret.md\n@.claude/x.md\n");
  writeFileSync(join(dir, "memory", "lessons.md"), "- Mở đầu dưới 5 giây.\n@CLAUDE.md\n");
  writeFileSync(join(dir, "channel", "rules.md"), "- Không dùng chữ đỏ.\n");
  return dir;
}

describe("agent system prompt", () => {
  it("inlines what CLAUDE.md imports from the workspace, once, never from outside it", () => {
    const out = expandImports("# Kênh\n@memory/lessons.md\n@channel/rules.md\n@../secret.md\n@.claude/x.md\n", workspace());
    expect(out).toContain("- Mở đầu dưới 5 giây.");
    expect(out).toContain("- Không dùng chữ đỏ.");
    expect(out).toContain("@../secret.md");
    expect(out).toContain("@.claude/x.md");
  });

  it("is Studio's rules, then the channel's CLAUDE.md; a thread may leave the lessons out", () => {
    const dir = workspace();
    const all = agentSystemPrompt(dir);
    expect(all.startsWith("# Bạn là agent của AG Studio")).toBe(true);
    expect(all).toContain("<project_claude_md>\n# Kênh\nNhạc nhẹ.");
    expect(all).toContain("Mở đầu dưới 5 giây.");
    const without = agentSystemPrompt(dir, { useLessons: false });
    expect(without).not.toContain("Mở đầu dưới 5 giây.");
    expect(without).toContain("(luồng này không dùng memory/lessons.md)");
    expect(without).toContain("Không dùng chữ đỏ.");
  });

  it("calls the footage library by ag-go's own name, AG Go by default", () => {
    const dir = workspace();
    const named = agentSystemPrompt(dir, { siteName: "Kho Footage" });
    expect(named).toContain('kho video của công ty, tên là "Kho Footage"');
    expect(named).not.toMatch(/ag-go/i);
    expect(agentSystemPrompt(dir)).toContain('tên là "AG Go"');
  });
});

describe("turn prompt", () => {
  const project = { name: "Du lịch chậm", channel_url: "@dlc", language: "vi", aspect: "16:9" } as ProjectRecord;
  const thread = { id: "t1", kind: "video", title: "Hội An" } as ThreadRecord;
  const msg = (role: "user" | "system", text: string, attachments?: string[]) => ({ role, text, attachments: attachments ? JSON.stringify(attachments) : null }) as MessageRecord;

  it("leads with the context, then what was said since the last turn", () => {
    const out = agentTurnPrompt({
      project, thread, video: { id: "v1", idx: 3, title: "Hội An", status: "draft" } as never,
      refs: [{ ref_thread_id: "t0", mode: "summary", title: "Huế", video_id: "v0" }, { ref_thread_id: "t9", mode: "full", title: "Ý tưởng", video_id: null }],
      messages: [msg("user", "Viết brief", ["context/notes.md"]), msg("system", "Render xem trước xong")],
      resumed: true, recap: true, extra: ["Bước gợi ý: brief"], now: "2026-10-10T08:00:00.000Z",
    });
    expect(out.startsWith("<studio_context>\nDự án: Du lịch chậm (@dlc)")).toBe(true);
    expect(out).toContain("Video của luồng: #3 \"Hội An\" (id v1) — thư mục videos/v1/");
    expect(out).toContain("- \"Huế\": tóm tắt videos/v0/SUMMARY.md");
    expect(out).toContain("- \"Ý tưởng\": toàn bộ lịch sử .studio/history/t9.md");
    expect(out).toContain("Bước gợi ý: brief");
    expect(out).toContain("phiên mới của một luồng đã có");
    expect(out).toContain("Lượt trước bị ngắt");
    expect(out).toContain("Viết brief\n\nĐính kèm: `context/notes.md`\n\n---\n\n[Studio] Render xem trước xong");
  });
});
