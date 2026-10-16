import { describe, expect, it } from "vitest";
import type { AgentPart } from "@harness/adapter-agent-cli";
import { finalAnswer, thinAnswer } from "../src/agent/answer.js";

const text = (t: string): AgentPart => ({ kind: "text", text: t });
const tool = (name: string, result?: string): AgentPart => ({ kind: "tool", id: name, name, input: {}, started_at: "2026-10-15T00:00:00Z", ...(result ? { result } : {}) });
const LONG = "Đã viết kế hoạch dựng vào videos/v1/edit-plan.md: 14 cảnh, mở bằng cảnh chùa lúc bình minh, nhạc nhẹ, dài khoảng 8 phút. Còn chờ bạn duyệt đoạn kết.";

describe("the answer a turn leaves", () => {
  it("is the text after the last step; reply chips are not a step", () => {
    expect(finalAnswer([text("Đọc trước. "), tool("Read"), text("Xong rồi."), tool("mcp__studio__suggest_replies")])).toBe("Xong rồi.");
    expect(finalAnswer([tool("Write")])).toBe("");
  });

  it("is thin when the turn wrote files or started a job and said under 120 characters of it", () => {
    expect(thinAnswer([tool("Write"), text("Bạn chọn bản nào?"), tool("mcp__studio__suggest_replies")], ["videos/v1/edit-plan.md"])).toBe(true);
    expect(thinAnswer([tool("mcp__studio__render_preview", '{"job_id":"j1","status":"queued"}'), text("Đang render.")], [])).toBe(true);
    expect(thinAnswer([tool("Write"), text(LONG)], ["videos/v1/edit-plan.md"])).toBe(false);
    // a question that changed nothing is not thin
    expect(thinAnswer([tool("Read"), text("Bạn muốn video dài bao lâu?")], [])).toBe(false);
  });
});
