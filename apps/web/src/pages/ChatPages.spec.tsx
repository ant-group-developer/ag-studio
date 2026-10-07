import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { ChatThreadView, ChatTurn } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = {
  getMe: vi.fn().mockResolvedValue({ userId: "u", isAdmin: false }),
  getCanvaConnection: vi.fn().mockResolvedValue({ enabled: false, connected: false, displayName: null }),
  listTeams: vi.fn().mockResolvedValue({ items: [{ id: "team-1", name: "Du lịch", role: "producer" }], total: 1, page: 1, pageSize: 100 }),
  getOverview: vi.fn().mockResolvedValue({ items: [
    { id: "p1", teamId: "team-1", title: "Series Kyoto", updatedAt: "", step: "approve-branding", group: "waiting_you", episodes: [] },
    { id: "p2", teamId: "team-1", title: "Huế", updatedAt: "", step: "plan-episodes", group: "needs_attention", episodes: [] },
  ] }),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 3, waiting: 0, max: 20, source: "env" }),
  createDraft: vi.fn().mockResolvedValue({ productionId: "p-new", user: {}, assistant: {} }),
  getChatThread: vi.fn(),
  getProduction: vi.fn().mockResolvedValue({ id: "p1", teamId: "team-1", title: "Series Kyoto" }),
  sendChat: vi.fn().mockResolvedValue({}),
  approveChat: vi.fn().mockResolvedValue({ stageState: "SUCCEEDED", runState: "RUNNING" }),
  startProduction: vi.fn().mockResolvedValue({ runId: "r" }),
  getEpisode: vi.fn(),
  rerenderEpisode: vi.fn().mockResolvedValue({ runId: "r2", from: "render-final" }),
  getStepDocument: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => ({ getFolders: vi.fn().mockResolvedValue({ folders: [] }) }) }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));

const { ChatHomePage } = await import("./ChatHomePage");
const { ChatProductionPage } = await import("./ChatProductionPage");

function mount(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<ChatHomePage />} />
            <Route path="/v/:productionId" element={<ChatProductionPage />} />
            <Route path="/v/:productionId/e/:episodeId" element={<ChatProductionPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

let n = 0;
const turn = (over: Partial<ChatTurn>): ChatTurn => ({
  id: `t${++n}`, production_id: "p1", episode_id: null, run_id: "r", scope: "gate", stage_key: "approve-branding", turn: n, role: "assistant",
  text: "", mentions: [], context: null, proposal: null, action: null, status: "done", not_before: null, problems: [],
  llm_call_id: null, created_by: null, applied_at: null, created_at: "", updated_at: "", ...over,
});

describe("chat pages", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("home: one message makes a video in the team and opens it; what waits for you is listed", async () => {
    mount("/");
    expect(await screen.findByText("Đang chờ bạn duyệt")).toBeInTheDocument();
    expect(screen.getByText("Cần xử lý")).toBeInTheDocument();
    const box = screen.getByLabelText("Yêu cầu cho Claude");
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: "Làm series vlog Kyoto", selectionStart: 21 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(client.createDraft).toHaveBeenCalledWith("team-1", "Làm series vlog Kyoto"));
    expect(await screen.findByRole("heading", { name: "Series Kyoto" })).toBeInTheDocument();
  });

  it("a gate: Duyệt approves the version on show; the chat goes to Claude", async () => {
    const v2 = turn({ text: "Đã đổi chữ to hơn", action: "revise", proposal: { series_name: "A quiet summer" } });
    const thread: ChatThreadView = {
      turns: [turn({ role: "user", text: "Chữ to hơn" }), v2],
      scope: { productionId: "p1", episodeId: null, runId: "r", stageKey: "approve-branding", scope: "gate" }, blocked: null,
      current: { turnId: v2.id, document: v2.proposal, draft: { series_name: "Quiet" }, pendingApply: false, problems: [] }, queueAhead: 0,
    };
    client.getChatThread.mockResolvedValue(thread);
    mount("/v/p1");
    expect(await screen.findByText("Đã đổi chữ to hơn")).toBeInTheDocument();
    expect(screen.getByText("3 · Branding").closest("li")).toHaveClass("chat-steps__now");
    expect(screen.getByText(/✓ R&D/).closest("li")).toHaveClass("chat-steps__done");
    fireEvent.click(await screen.findByRole("button", { name: "Duyệt" }));
    await waitFor(() => expect(client.approveChat).toHaveBeenCalledWith("p1", { stageKey: "approve-branding", episodeId: undefined, turnId: v2.id }));
    const box = screen.getByLabelText("Yêu cầu cho Claude");
    fireEvent.change(box, { target: { value: "Bỏ màu cam", selectionStart: 10 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(client.sendChat).toHaveBeenCalledWith("p1", "Bỏ màu cam", undefined));
  });

  it("while Claude or a render works, nothing can be sent", async () => {
    client.getChatThread.mockResolvedValue({ turns: [], scope: null, blocked: { code: "busy", stage: "rnd" }, current: null, queueAhead: 0 });
    mount("/v/p1");
    const box = await screen.findByPlaceholderText("Claude hoặc máy render đang làm bước này, chờ xong rồi nhắn…");
    expect(box).toBeDisabled();
  });

  it("the YouTube kit: the card approves and renders on the machine type, starting on the episode's default", async () => {
    const ok = turn({ episode_id: "e1", stage_key: "approve-youtube-kit", text: "Kit ổn rồi.", action: "suggest_approve" });
    client.getChatThread.mockResolvedValue({
      turns: [ok], scope: { productionId: "p1", episodeId: "e1", runId: "r", stageKey: "approve-youtube-kit", scope: "gate" }, blocked: null,
      current: { turnId: null, document: null, draft: null, pendingApply: false, problems: [] }, queueAhead: 0,
    } satisfies ChatThreadView);
    client.getEpisode.mockResolvedValue({ id: "e1", idx: 1, title: "Rừng tre", status: "waiting_approval",
      render: { machine: null, defaultMachine: "gpu", restartFrom: null, job: null, farmStatus: null } });
    mount("/v/p1/e/e1");
    expect(await screen.findByText("Duyệt YouTube kit và render bản cuối?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Máy có GPU/ })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Duyệt và render" }));
    await waitFor(() => expect(client.approveChat).toHaveBeenCalledWith("p1", { stageKey: "approve-youtube-kit", episodeId: "e1", turnId: null, renderMachine: "gpu" }));
  });

  it("⋯ → Render bản cuối…: only the render runs again, on the machine type picked", async () => {
    client.getChatThread.mockResolvedValue({
      turns: [], scope: { productionId: "p1", episodeId: "e1", runId: "r", stageKey: "timeline", scope: "timeline" }, blocked: null,
      current: null, queueAhead: 0,
    } satisfies ChatThreadView);
    client.getEpisode.mockResolvedValue({ id: "e1", idx: 1, title: "Rừng tre", status: "ready", progress: null, finalVideoUrl: null, exportFiles: [],
      render: { machine: "nvenc", defaultMachine: "nvenc", restartFrom: "render-final", job: null, farmStatus: null } });
    mount("/v/p1/e/e1");
    await screen.findByRole("heading", { name: "Tập 1 · Rừng tre" });
    fireEvent.click(screen.getByRole("button", { name: "Thêm thao tác" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Render bản cuối…" }));
    expect(await screen.findByText("Chỉ render lại, giữ timeline và YouTube kit đã duyệt.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Máy có GPU/ }));
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(client.rerenderEpisode).toHaveBeenCalledWith("p1", "e1", "gpu"));
  });

  it("the step chips of an episode whose run ended ready are all done", async () => {
    client.getChatThread.mockResolvedValue({
      turns: [], scope: { productionId: "p1", episodeId: "e1", runId: "r", stageKey: "timeline", scope: "timeline" }, blocked: null,
      current: null, queueAhead: 0,
    } satisfies ChatThreadView);
    const render = { machine: null, defaultMachine: "any", restartFrom: "render-final", job: null, farmStatus: null };
    client.getEpisode.mockResolvedValue({ id: "e1", idx: 1, title: "Rừng tre", status: "ready", currentStage: null, run: { state: "SUCCEEDED" }, progress: null, finalVideoUrl: null, exportFiles: [], render });
    mount("/v/p1/e/e1");
    expect((await screen.findByText(/✓ Xuất file/)).closest("li")).toHaveClass("chat-steps__done");
    expect(screen.getByText(/✓ Timeline/).closest("li")).toHaveClass("chat-steps__done");
  });

  it("an episode whose render failed shows Render as the step it is at", async () => {
    client.getChatThread.mockResolvedValue({
      turns: [], scope: { productionId: "p1", episodeId: "e1", runId: "r", stageKey: "timeline", scope: "timeline" }, blocked: null,
      current: null, queueAhead: 0,
    } satisfies ChatThreadView);
    const render = { machine: "gpu", defaultMachine: "gpu", restartFrom: "render-final", job: null, farmStatus: null };
    client.getEpisode.mockResolvedValue({ id: "e1", idx: 1, title: "Rừng tre", status: "failed", currentStage: "render-final", run: { state: "FAILED" }, progress: null, finalVideoUrl: null, exportFiles: [], render });
    mount("/v/p1/e/e1");
    await waitFor(() => expect(screen.getByText("4 · Render").closest("li")).toHaveClass("chat-steps__now"));
    expect(screen.getByText(/✓ YouTube kit/).closest("li")).toHaveClass("chat-steps__done");
  });

  it("a step passed opens its document on the right, from its chip or its divider; back returns to the step at hand", async () => {
    client.getStepDocument.mockResolvedValue({
      kind: "rnd", gate: "approve-rnd", state: "approved", inUse: false,
      document: { schema_version: "studio.rnd/v1", summary: "R&D đã duyệt", direction: {} },
      edit: { inPlace: true, inPlaceCode: null, reopen: true, reopenCode: null, replacesEpisodes: false, reruns: ["approve-rnd"] },
    });
    client.getChatThread.mockResolvedValue({
      turns: [turn({ stage_key: "approve-rnd", text: "R&D xong" }), turn({ stage_key: "approve-branding", text: "Branding đây" })],
      scope: { productionId: "p1", episodeId: null, runId: "r", stageKey: "approve-branding", scope: "gate" }, blocked: null,
      current: { turnId: null, document: { series_name: "Quiet" }, draft: { series_name: "Quiet" }, pendingApply: false, problems: [] }, queueAhead: 0,
    } satisfies ChatThreadView);
    mount("/v/p1");
    fireEvent.click(await screen.findByRole("button", { name: "Xem R&D" }));
    expect(await screen.findByText("R&D đã duyệt")).toBeInTheDocument();
    expect(client.getStepDocument).toHaveBeenCalledWith("p1", "rnd", undefined);
    expect(screen.getByRole("button", { name: "Xem R&D" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Về bước hiện tại" }));
    expect(await screen.findByRole("heading", { name: "Branding" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "xem tài liệu" }));
    expect(await screen.findByText("R&D đã duyệt")).toBeInTheDocument();
  }, 20_000);
});
