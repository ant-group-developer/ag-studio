import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ChatThreadView, ChatTurn } from "../../api/studio-client";

const client = {
  listEditorJobs: vi.fn().mockResolvedValue([]), getEditorJob: vi.fn(), getEpisode: vi.fn(),
  getProductionAudio: vi.fn().mockResolvedValue({ voice: null, music: null }),
  giveProductionAudio: vi.fn(), declineNarration: vi.fn(), removeProductionAudio: vi.fn(),
};
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

const mount = (thread: ChatThreadView, props: { onPrimary?: () => void; onMenu?: () => void; canApprove?: boolean; episodeId?: string; canRenderFinal?: boolean; workflow?: string } = {}) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ResultPane productionId="p" episodeId={props.episodeId} thread={thread} onPrimary={props.onPrimary ?? vi.fn()} onMenu={props.onMenu ?? vi.fn()} canApprove={props.canApprove ?? true}
      renderDefault="any" canRenderFinal={props.canRenderFinal} workflow={props.workflow} />
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
    const full = { ...draft, aspect: "16:9", keywords: ["kyoto vlog"], channels: [{ url: "@meitime", role: "reference" }] };
    const again = mount(thread(full));
    expect(screen.getByRole("button", { name: "Bắt đầu" })).toBeEnabled();
    expect(screen.getByText("đủ thông tin")).toHaveClass("chat-badge--done");
    expect(screen.getByText(/— tham khảo/)).toBeInTheDocument();
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

  it("Duyệt on the YouTube kit asks for the machine type of the final render before anything is sent", async () => {
    const onPrimary = vi.fn();
    const kit = { schema_version: "studio.youtube-kit/v1", titles: ["A", "B", "C"], description: "Mô tả", tags: ["kyoto"], hashtags: ["#kyoto"], thumbnails: [], chapters: [] };
    mount({
      turns: [], scope: { productionId: "p", episodeId: "e", runId: "r", stageKey: "approve-youtube-kit", scope: "gate" }, blocked: null,
      current: { turnId: null, document: kit, draft: kit, pendingApply: false, problems: [] }, queueAhead: 0,
    }, { onPrimary, episodeId: "e" });
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(onPrimary).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("radio", { name: /Máy có NVENC/ }));
    fireEvent.click(screen.getByRole("button", { name: "Duyệt và render" }));
    expect(onPrimary).toHaveBeenCalledWith("approve", { renderMachine: "nvenc" });
  });

  it("⋯ of an episode offers the final render, not while the episode is producing", async () => {
    const onMenu = vi.fn();
    const busy: ChatThreadView = { turns: [], scope: null, blocked: { code: "busy", stage: "render-final" }, current: null, queueAhead: 0 };
    const { unmount } = mount(busy, { episodeId: "e", onMenu, canRenderFinal: false });
    fireEvent.click(screen.getByRole("button", { name: "Thêm thao tác" }));
    expect(await screen.findByRole("menuitem", { name: "Render bản cuối…" })).toHaveAttribute("aria-disabled", "true");
    unmount();
    mount(busy, { episodeId: "e", onMenu, canRenderFinal: true });
    fireEvent.click(screen.getByRole("button", { name: "Thêm thao tác" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Render bản cuối…" }));
    expect(onMenu).toHaveBeenCalledWith("finalRender");
  });

  it("an episode whose run ended shows its render, not the timeline; a render that failed says why and offers Render lại", async () => {
    client.getEpisode.mockResolvedValue({ status: "failed", render: null, progress: null, finalVideoUrl: null, exportFiles: [] });
    const onMenu = vi.fn();
    const timeline = { schema_version: "studio.timeline/v4", clips: [], texts: [] };
    const failed: ChatThreadView = {
      turns: [], scope: { productionId: "p", episodeId: "e", runId: "r", stageKey: "timeline", scope: "timeline" }, blocked: null,
      current: { turnId: null, document: timeline, draft: timeline, pendingApply: false, problems: [] }, queueAhead: 0,
      stopped: { stage: "render-final", problems: [{ code: "transient", message: "farm job failed: fetch failed" }] },
    };
    const { unmount } = mount(failed, { episodeId: "e", onMenu, canRenderFinal: true, workflow: "ag-studio-episode-cut@1.0.0" });
    expect(screen.getByRole("heading", { name: "Render" })).toBeInTheDocument();
    expect(screen.getByText("cần xử lý")).toBeInTheDocument();
    expect(screen.getByText("farm job failed: fetch failed")).toBeInTheDocument();
    expect(await screen.findByText("Chưa có file xuất.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Render lại" }));
    expect(onMenu).toHaveBeenCalledWith("finalRender");
    unmount();

    // rendered: the files, no error, no main button
    mount({ ...failed, stopped: null }, { episodeId: "e", onMenu, canRenderFinal: true, workflow: "ag-studio-episode-cut@1.0.0" });
    expect(screen.getByRole("heading", { name: "Render" })).toBeInTheDocument();
    expect(screen.queryByText("farm job failed: fetch failed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Render lại" })).toBeNull();
  });

  it("⋯ of a shot-cut episode runs it again from a gate, and exports to Premiere (phase 4)", async () => {
    const onMenu = vi.fn();
    const done: ChatThreadView = { turns: [], scope: null, blocked: { code: "nothing_to_chat", stage: null }, current: null, queueAhead: 0 };
    const { unmount } = mount(done, { episodeId: "e", onMenu, workflow: "ag-studio-episode-cut@1.0.0" });
    fireEvent.click(screen.getByRole("button", { name: "Thêm thao tác" }));
    expect(await screen.findByRole("menuitem", { name: "Chạy lại từ kế hoạch dựng…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Xuất project Premiere" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Chạy lại từ chọn cảnh…" }));
    expect(onMenu).toHaveBeenCalledWith("rerunSurvey");
    unmount();
    mount(done, { episodeId: "e", onMenu, workflow: "ag-studio-episode@1.3.0" });
    fireEvent.click(screen.getByRole("button", { name: "Thêm thao tác" }));
    expect(await screen.findByRole("menuitem", { name: "Xuất project Premiere" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Chạy lại từ chọn cảnh…" })).toBeNull();
  });

  it("an episode waiting for a voice asks for one, offers to drop narration, and never says it is working", async () => {
    const thread: ChatThreadView = { turns: [], scope: null, blocked: { code: "needs_voice", stage: "tts" }, current: null, queueAhead: 0 };
    mount(thread, { episodeId: "e", workflow: "ag-studio-episode-cut@1.0.0" });
    expect(screen.getByText("cần giọng đọc")).toBeInTheDocument();
    expect(screen.queryByText(/đang làm bước/)).not.toBeInTheDocument();
    expect(screen.getByText(/series chưa có giọng đọc/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bỏ lời dẫn" })).toBeInTheDocument();
    await waitFor(() => expect(client.getProductionAudio).toHaveBeenCalledWith("p"));

    // the voice picker is open: Lưu waits for a link, whose voice it is, and the person's word
    const save = screen.getByRole("button", { name: "Lưu" });
    fireEvent.change(screen.getByPlaceholderText(/^https:/), { target: { value: "https://drive.google.com/file/d/abc/view" } });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Giọng của tôi"));
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Tôi có quyền dùng giọng này để làm video."));
    expect(save).toBeEnabled();
    client.giveProductionAudio.mockResolvedValue({ voice: null, music: null, resumedEpisodes: ["e"] });
    fireEvent.click(save);
    await waitFor(() => expect(client.giveProductionAudio).toHaveBeenCalledWith("p", "voice", { url: "https://drive.google.com/file/d/abc/view", origin: "own", confirm: true }));
  });

  it("a machine step that stopped says why and runs again", () => {
    const onPrimary = vi.fn();
    const thread: ChatThreadView = {
      turns: [], scope: null, current: null, queueAhead: 0,
      blocked: { code: "stage_failed", stage: "transcribe", problems: [{ code: "transient", message: "farm job failed: no python" }] },
    };
    mount(thread, { onPrimary, episodeId: "e", workflow: "ag-studio-episode-cut@1.0.0" });
    expect(screen.getByText("cần xử lý")).toBeInTheDocument();
    expect(screen.getByText("farm job failed: no python")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chạy lại" }));
    expect(onPrimary).toHaveBeenCalledWith("rerunStep");
  });
});
