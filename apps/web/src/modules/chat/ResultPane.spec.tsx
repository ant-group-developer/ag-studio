import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ChatThreadView, ChatTurn } from "../../api/studio-client";

const client = { listEditorJobs: vi.fn().mockResolvedValue([]), getEditorJob: vi.fn(), getEpisode: vi.fn() };
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { ResultPane, intakeMissing, versionOf } = await import("./ResultPane");

const rnd = (count: number, keywords: string[]) => ({
  schema_version: "studio.rnd/v1", summary: "Series thư giãn", market: { opportunities: [], gaps: [], risks: [], competitors: [] }, own_channels: null,
  footage_fit: { summary: "50 phút dùng được", strong_themes: [], gaps: [] },
  direction: { description: "Mỗi tập một cung đường", goal: "Giữ người xem lâu", audience: "Người thích du lịch Nhật", tone: "Yên tĩnh", positioning: "Du lịch chậm",
    content_pillars: [{ name: "Cung đường", description: "Sáng tới chiều" }], episode_target_seconds: 1000, max_episodes: count, posting_schedule: "",
    keywords, episode_ideas: [], notes: "" },
});
let n = 0;
const turn = (over: Partial<ChatTurn>): ChatTurn => ({
  id: `t${++n}`, production_id: "p", episode_id: null, run_id: "r", scope: "gate", stage_key: "approve-rnd", turn: n, role: "assistant",
  text: "", mentions: [], context: null, proposal: null, action: null, status: "done", not_before: null, problems: [],
  llm_call_id: null, created_by: null, applied_at: null, created_at: "", updated_at: "", ...over,
});

const mount = (thread: ChatThreadView, props: { onPrimary?: () => void; canApprove?: boolean } = {}) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ResultPane productionId="p" thread={thread} onPrimary={props.onPrimary ?? vi.fn()} onMenu={vi.fn()} canApprove={props.canApprove ?? true} />
  </QueryClientProvider>,
);

describe("ResultPane", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("shows the R&D as Claude revised it: version 2, the old episode count struck out, new keywords marked, and Duyệt", () => {
    const onPrimary = vi.fn();
    const v2 = turn({ proposal: rnd(3, ["kyoto", "slow travel"]) });
    const thread: ChatThreadView = {
      turns: [turn({ role: "user", text: "Gộp tập 3 và 4" }), v2],
      scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "approve-rnd", scope: "gate" }, blocked: null,
      current: { turnId: v2.id, document: v2.proposal, draft: rnd(4, ["kyoto"]), pendingApply: false, problems: [] }, queueAhead: 0,
    };
    expect(versionOf(thread).n).toBe(2);
    mount(thread, { onPrimary });
    expect(screen.getByRole("heading", { name: "R&D" })).toBeInTheDocument();
    expect(screen.getByText("Bản 2 · 2 thay đổi")).toBeInTheDocument();
    expect(screen.getByText("4").tagName).toBe("DEL");
    expect(screen.getByText("3").tagName).toBe("INS");
    expect(screen.getByText("slow travel").tagName).toBe("INS");
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(onPrimary).toHaveBeenCalledWith("approve");
  });

  it("intake: Bắt đầu waits until the draft is complete, and a viewer cannot press it", () => {
    const draft = { title: "Series Kyoto", folder_ids: ["f1"], channels: [], keywords: [], aspect: null, language: "vi",
      hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: 900, max_episodes: null }, questions: [] };
    expect(intakeMissing(draft)).toEqual(["aspect", "research"]);
    const thread = (doc: unknown): ChatThreadView => ({
      turns: [turn({ scope: "intake", stage_key: "intake", role: "user", text: "Làm từ @[Kyoto 2025](folder:f1)", mentions: [{ kind: "folder", id: "f1", name: "Kyoto 2025" }] })],
      scope: { productionId: "p", episodeId: null, runId: null, stageKey: "intake", scope: "intake" }, blocked: null,
      current: { turnId: null, document: doc, draft: doc, pendingApply: false, problems: [] }, queueAhead: 0,
    });
    const { unmount } = mount(thread(draft));
    expect(screen.getByText("còn 2 thông tin")).toBeInTheDocument();
    expect(screen.getByText("Kyoto 2025")).toBeInTheDocument(); // the folder's name, not its id
    expect(screen.getByRole("button", { name: "Bắt đầu" })).toBeDisabled();
    unmount();
    const full = { ...draft, aspect: "16:9", keywords: ["kyoto vlog"] };
    const again = mount(thread(full));
    expect(screen.getByRole("button", { name: "Bắt đầu" })).toBeEnabled();
    again.unmount();
    mount(thread(full), { canApprove: false });
    expect(screen.getByRole("button", { name: "Bắt đầu" })).toBeDisabled();
  });

  it("a failed step lists its problems and offers Chạy lại; a running one says so", () => {
    const failed: ChatThreadView = {
      turns: [], scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "plan-episodes", scope: "failed" }, blocked: null,
      current: { turnId: null, document: null, draft: null, pendingApply: false, problems: [{ code: "duplicate_asset", message: "Tập 1 dùng clip Cửa Ngọ Môn hai lần" }] },
      queueAhead: 0,
    };
    const { unmount } = mount(failed);
    expect(screen.getByText("Tập 1 dùng clip Cửa Ngọ Môn hai lần")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chạy lại" })).toBeEnabled();
    unmount();
    mount({ turns: [], scope: null, blocked: { code: "busy", stage: "branding" }, current: null, queueAhead: 0 });
    expect(screen.getByText("Claude hoặc máy render đang làm bước Branding. Kết quả hiện ở đây khi xong.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duyệt" })).toBeNull();
  });
});
