import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ChatThreadView, ChatTurn } from "../../api/studio-client";
import { ChatThread } from "./ChatThread";

let n = 0;
const turn = (over: Partial<ChatTurn>): ChatTurn => ({
  id: `t${++n}`, production_id: "p", episode_id: null, run_id: "r", scope: "gate", stage_key: "approve-rnd", turn: n, role: "assistant",
  text: "", mentions: [], context: null, proposal: null, action: null, status: "done", not_before: null, problems: [],
  llm_call_id: null, created_by: null, applied_at: null, created_at: "", updated_at: "", ...over,
});
const view = (turns: ChatTurn[], over: Partial<ChatThreadView> = {}): ChatThreadView => ({
  turns, scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "approve-rnd", scope: "gate" }, blocked: null,
  current: { turnId: null, document: {}, draft: {}, pendingApply: false, problems: [] }, queueAhead: 0, ...over,
});

describe("ChatThread", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("shows messages under a divider per step, earlier steps folded, and the approve card on the newest reply", () => {
    const onCard = vi.fn();
    const ok = turn({ text: "Bấm Duyệt để chuyển sang bước sau.", action: "suggest_approve" });
    render(<ChatThread onCard={onCard} thread={view([
      turn({ role: "user", stage_key: "intake", scope: "intake", text: "Làm series từ @[Kyoto 2025](folder:f1)" }),
      turn({ stage_key: "approve-trend-report", text: "Đã bỏ kyoto food" }),
      turn({ role: "system", stage_key: "approve-trend-report", text: "Đã duyệt." }),
      turn({ role: "user", text: "Gộp tập 3 và 4" }),
      ok,
    ])} />);
    expect(screen.getByText("@Kyoto 2025")).toHaveClass("chat-mention");
    expect(screen.getByText(/Bước 1 · Nghiên cứu thị trường · đã duyệt/)).toBeInTheDocument();
    expect(screen.queryByText("Đã bỏ kyoto food")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "xem lại" }));
    expect(screen.getByText("Đã bỏ kyoto food")).toBeInTheDocument();
    expect(screen.getByText(/Bước 2 · R&D · chờ bạn/)).toBeInTheDocument();
    expect(screen.getByText("Duyệt R&D và chuyển sang bước sau?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(onCard).toHaveBeenCalledWith("approve", ok);
  });

  it("shows the divider of the step the production is at before anyone wrote in it", () => {
    render(<ChatThread onCard={vi.fn()} thread={view([])} />);
    expect(screen.getByText(/Bước 2 · R&D · chờ bạn/)).toBeInTheDocument();
  });

  it("says what Claude is doing: replying, waiting for a slot, waiting for the plan limit", () => {
    const { rerender } = render(<ChatThread onCard={vi.fn()} thread={view([turn({ role: "user", text: "a" }), turn({ status: "pending" })], { queueAhead: 3 })} />);
    expect(screen.getByText("Đang chờ lượt (3 lượt trước)")).toBeInTheDocument();
    rerender(<ChatThread onCard={vi.fn()} thread={view([turn({ status: "running" })])} />);
    expect(screen.getByText("Claude đang trả lời…")).toBeInTheDocument();
    rerender(<ChatThread onCard={vi.fn()} thread={view([turn({ status: "rate_limited", not_before: new Date(2026, 9, 6, 15, 5).toISOString() })])} />);
    expect(screen.getByText("Gói Claude hết hạn mức, tự thử lại lúc 15:05")).toBeInTheDocument();
  });

  it("shows why a proposal was dropped, offers a retry on a failed step and quick answers in the intake", () => {
    const onCard = vi.fn();
    const onQuick = vi.fn();
    const { rerender } = render(<ChatThread onCard={onCard} thread={view(
      [turn({ stage_key: "plan-episodes", scope: "failed", text: "Tập 1 dùng một clip hai lần", problems: [{ code: "duplicate_asset", message: "Tập 1 dùng a01 hai lần" }] })],
      { scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "plan-episodes", scope: "failed" } },
    )} />);
    expect(screen.getByText("Tập 1 dùng a01 hai lần")).toBeInTheDocument();
    expect(screen.getByText(/Kế hoạch tập · cần xử lý/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chạy lại" }));
    expect(onCard).toHaveBeenCalledWith("retry", expect.objectContaining({ stage_key: "plan-episodes" }));

    const ask = turn({ scope: "intake", stage_key: "intake", text: "Video ngang hay dọc?", action: "revise", proposal: { questions: [{ field: "aspect", question: "?", options: ["Ngang 16:9", "Dọc 9:16"] }] } });
    rerender(<ChatThread onCard={onCard} onQuickAnswer={onQuick} thread={view([ask], { scope: { productionId: "p", episodeId: null, runId: null, stageKey: "intake", scope: "intake" } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Dọc 9:16" }));
    expect(onQuick).toHaveBeenCalledWith("Dọc 9:16");
  });

  it("asks to apply a timeline proposal before anything else", () => {
    const onCard = vi.fn();
    const prop = turn({ stage_key: "approve-timeline", episode_id: "e", text: "Đã thêm chữ", action: "revise", proposal: { ops: [] } });
    render(<ChatThread episode onCard={onCard} thread={view([prop], {
      scope: { productionId: "p", episodeId: "e", runId: "r", stageKey: "approve-timeline", scope: "gate" },
      current: { turnId: prop.id, document: {}, draft: null, pendingApply: true, problems: [] },
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Áp dụng" }));
    expect(onCard).toHaveBeenCalledWith("apply", prop);
  });

  it("approving the YouTube kit starts the final render: the card asks for the machine type", () => {
    const onCard = vi.fn();
    const ok = turn({ stage_key: "approve-youtube-kit", episode_id: "e", text: "Kit ổn rồi.", action: "suggest_approve" });
    render(<ChatThread episode renderDefault="nvenc" onCard={onCard} thread={view([ok], {
      scope: { productionId: "p", episodeId: "e", runId: "r", stageKey: "approve-youtube-kit", scope: "gate" },
    })} />);
    expect(screen.getByText("Duyệt YouTube kit và render bản cuối?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Máy có NVENC/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Máy có GPU/ }));
    fireEvent.click(screen.getByRole("button", { name: "Duyệt và render" }));
    expect(onCard).toHaveBeenCalledWith("approve", ok, { renderMachine: "gpu" });
  });

  it("the approve card of any other gate has no machine type", () => {
    render(<ChatThread onCard={vi.fn()} thread={view([turn({ action: "suggest_approve" })])} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
