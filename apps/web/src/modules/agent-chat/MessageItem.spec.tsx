import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { AgentPart, ChatMessage } from "../../api/workspace-client";
import { chatRows, JobNotes, MessageItem, splitTurn, spokenDuration } from "./MessageItem";

const T0 = Date.parse("2026-10-12T00:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const tool = (id: string, name: string, input: unknown, ended = true): AgentPart =>
  ({ kind: "tool", id, name, input, started_at: iso(1), ...(ended ? { ended_at: iso(2) } : {}) });
const text = (t: string): AgentPart => ({ kind: "text", text: t });
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: `m${Math.random()}`, threadId: "t", seq: 2, role: "assistant", status: "done", text: "", parts: [], phase: null, attachments: [], trigger: "user",
  notBefore: null, error: null, cancelRequested: false, costUsd: null, createdBy: "u", actorRole: "editor", startedAt: iso(0), finishedAt: iso(80),
  createdAt: iso(0), updatedAt: iso(80), ...over,
});

describe("a turn's work", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("says how long it took in words", () => {
    const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
    expect(spokenDuration(t, 45)).toBe("45 giây");
    expect(spokenDuration(t, 80)).toBe("1 phút 20 giây");
    expect(spokenDuration(t, 120)).toBe("2 phút");
    expect(spokenDuration(t, 3900)).toBe("1 giờ 5 phút");
  });

  it("splits the steps from the final answer: the text after the last step; reply chips are not steps", () => {
    const parts = [text("Đọc trước."), tool("a", "Read", { file_path: "x.md" }), text("Xong rồi."), tool("s", "mcp__studio__suggest_replies", { options: ["Tiếp"] })];
    const { work, answer, steps } = splitTurn(parts);
    expect(steps).toBe(1);
    expect(answer).toEqual([text("Xong rồi.")]);
    expect(work.map((p) => (p.kind === "tool" ? p.id : p.text))).toEqual(["Đọc trước.", "a", "s"]);
  });

  it("a finished turn: one folded line with the steps and time over the answer; it unfolds and remembers", async () => {
    const m = msg({ parts: [text("Mình đọc ghi chú."), tool("a", "Read", { file_path: "context/notes.md" }), tool("b", "Write", { file_path: "channel/plan.md" }), text("Đã viết kế hoạch.")] });
    const { unmount } = render(<MessageItem message={m} onOpenFile={vi.fn()} />);
    expect(screen.getByText("Đã viết kế hoạch.")).toBeInTheDocument();
    expect(screen.queryByText("Mình đọc ghi chú.")).toBeNull();
    const line = screen.getByRole("button", { name: "Đã làm 2 bước · 1 phút 20 giây" });
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Mình đọc ghi chú.")).toBeInTheDocument();
    expect(screen.getByText("đọc file")).toBeInTheDocument();
    expect(screen.getByText("ghi file")).toBeInTheDocument();
    unmount();
    // back to the same chat: still open
    render(<MessageItem message={m} />);
    expect(screen.getByRole("button", { name: /Đã làm 2 bước/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("a turn out of time that goes on says so; one that stopped there says how to go on", () => {
    const { rerender } = render(<MessageItem message={msg({ parts: [text("Đang chọn cảnh.")], error: "timeout" })} />);
    expect(screen.getByText("Hết thời gian của một lượt; Claude làm tiếp ở lượt sau, giữ những gì đã làm.")).toBeInTheDocument();
    rerender(<MessageItem message={msg({ status: "failed", parts: [text("Đang chọn cảnh.")], error: "timeout" })} />);
    expect(screen.getByText("Lượt này lỗi: quá thời gian của một lượt; nhắn “tiếp tục” để làm tiếp")).toBeInTheDocument();
  });

  it("the files a finished turn changed show under its answer; an older turn or a running one shows none", () => {
    const changedFiles = [{ path: "channel/plan.md", change: "modified" as const, version_id: "v2", before_version_id: "v1", added: 3, removed: 1 }];
    const { rerender } = render(<MessageItem projectId="p1" message={msg({ parts: [text("Xong.")], changedFiles })} onOpenFile={vi.fn()} />);
    expect(screen.getByRole("region", { name: "1 file đã thay đổi" })).toHaveTextContent("channel/plan.md");
    rerender(<MessageItem projectId="p1" message={msg({ parts: [text("Xong.")], changedFiles: null })} />);
    expect(screen.queryByRole("region", { name: /file đã thay đổi/ })).toBeNull();
    rerender(<MessageItem projectId="p1" message={msg({ status: "running", parts: [text("Đang làm.")], changedFiles })} />);
    expect(screen.queryByRole("region", { name: /file đã thay đổi/ })).toBeNull();
  });

  it("an answer without steps shows as it is, with no fold", () => {
    render(<MessageItem message={msg({ parts: [text("Chào bạn.")] })} />);
    expect(screen.getByText("Chào bạn.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Đã làm/ })).toBeNull();
  });

  it("a running turn: the live line names the running step, unfolds to the steps so far and stops", () => {
    const onStop = vi.fn();
    const m = msg({
      status: "running", finishedAt: null, startedAt: new Date(Date.now() - 65_000).toISOString(),
      phase: { kind: "tool", tool: "mcp__studio__video_create", detail: null },
      parts: [tool("a", "Read", { file_path: "context/notes.md" }), tool("b", "mcp__studio__video_create", { title: "Hội An đêm" }, false)],
    });
    render(<MessageItem message={m} onStop={onStop} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("đang tạo video · Hội An đêm");
    expect(status).toHaveTextContent(/1:0\d · 2 công cụ/);
    expect(screen.queryByText("đọc file")).toBeNull();
    fireEvent.click(within(status).getByRole("button", { name: "Xem các bước" }));
    expect(screen.getByText("đọc file")).toBeInTheDocument();
    expect(screen.getByText("tạo video")).toBeInTheDocument();
    fireEvent.click(within(status).getByRole("button", { name: /Dừng/ }));
    expect(onStop).toHaveBeenCalled();
  });
});

describe("notes of finished jobs", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  const note = (text: string) => msg({ role: "system", trigger: "job", text });

  it("two or more in a row fold into one row; one alone, or notes split by a message, stay as they are", () => {
    const a = note("Đã chuẩn bị **A.MOV** (0:10): 1 cảnh."), b = note("Đã chuẩn bị **B.MOV** (0:12): 2 cảnh."), c = note("Không làm xong: Chuẩn bị C — hỏng");
    const turn = msg({ text: "Còn chờ." }), lone = note("Đã chuẩn bị **D.MOV**.");
    const other = msg({ role: "system", trigger: "action", text: "Đã xác nhận." });
    const rows = chatRows([a, b, c, turn, lone, other]);
    expect(rows.map((r) => r.kind)).toEqual(["jobNotes", "message", "message", "message"]);
    expect(rows[0]).toEqual({ kind: "jobNotes", messages: [a, b, c] });
  });

  it("says what they were in one line and unfolds to each note", () => {
    render(<JobNotes messages={[note("Đã chuẩn bị **A.MOV**."), note("Đã chuẩn bị **B.MOV**."), note("Không làm xong: Chuẩn bị C — hỏng"), note("Đã dừng: Chuẩn bị E.")]} />);
    const line = screen.getByRole("button", { name: "Đã chuẩn bị 2 video · 1 việc không xong · 1 việc nền khác" });
    expect(screen.queryByText("A.MOV")).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("A.MOV")).toBeInTheDocument();
    expect(screen.getByText(/Không làm xong: Chuẩn bị C/)).toBeInTheDocument();
  });
});
