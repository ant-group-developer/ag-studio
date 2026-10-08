import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { StudioQueueView } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const where = { productionId: "p1", productionTitle: "Series Kyoto", episodeId: "e1", episodeIdx: 1, episodeTitle: "Rừng tre" };
const queue: StudioQueueView = {
  claude: {
    running: 3, waiting: 1, max: 20, hidden: 2,
    items: [
      { ...where, episodeId: null, episodeIdx: null, episodeTitle: null, source: "chat", waiting: false, step: "approve-rnd", since: "2026-10-06T10:29:18.000Z" },
      { ...where, source: "stage", waiting: false, step: "youtube-kit", since: "2026-10-06T10:28:45.000Z" },
      { ...where, episodeId: null, episodeIdx: null, episodeTitle: null, source: "chat", waiting: true, step: "approve-branding", since: null },
    ],
  },
  renders: [
    { ...where, farmJobId: "f1", kind: "final", machine: "nvenc", status: "leased", progress: 62, progressStage: null, attempt: 1, createdAt: "2026-10-06T10:20:00.000Z", stuck: false },
    { ...where, farmJobId: "f2", kind: "final", machine: "gpu", status: "queued", progress: null, progressStage: null, attempt: 1, createdAt: "2026-10-06T10:00:00.000Z", stuck: true },
  ],
  hiddenRenders: 1,
  farm: { ok: true },
};

const client = {
  getMe: vi.fn(),
  getQueue: vi.fn(),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 3, waiting: 1, max: 20, source: "env" }),
  setClaudeMaxConcurrent: vi.fn().mockResolvedValue({ running: 3, waiting: 1, max: 12, source: "settings" }),
  getOverview: vi.fn().mockResolvedValue({ items: [
    { id: "p1", teamId: "t", title: "Series Kyoto", updatedAt: "", step: null, group: "waiting_you", episodes: [
      { id: "e2", idx: 2, title: "Chùa", status: "waiting_approval", step: "approve-timeline", group: "waiting_you" },
      { id: "e1", idx: 1, title: "Rừng tre", status: "producing", step: "render-final", group: "running" },
    ] },
    { id: "p2", teamId: "t", title: "Huế", updatedAt: "", step: "plan-episodes", group: "needs_attention", episodes: [] },
  ] }),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));
const { QueuePage } = await import("./QueuePage");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={["/queue"]}>
          <Routes>
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/v/:productionId" element={<p>video page</p>} />
            <Route path="/v/:productionId/e/:episodeId" element={<p>episode page</p>} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("QueuePage", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date("2026-10-06T10:30:00.000Z"), toFake: ["Date"] });
    client.getQueue.mockResolvedValue(queue);
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: false });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("lists Claude calls, render jobs with their machine type, and what waits for you", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Hàng đợi" })).toBeInTheDocument();
    const claude = screen.getByRole("region", { name: "Lượt Claude" });
    expect(await within(claude).findByText("3 / 20 lượt đang chạy · 1 lượt chờ")).toBeInTheDocument();
    expect(within(claude).getByText("Series Kyoto · R&D")).toBeInTheDocument();
    expect(within(claude).getByText("0:42 · bạn yêu cầu")).toBeInTheDocument();
    expect(within(claude).getByText("Series Kyoto · Tập 1 · YouTube kit")).toBeInTheDocument();
    expect(within(claude).getByText("1:15 · tự động")).toBeInTheDocument();
    expect(within(claude).getByText("chờ lượt · bạn yêu cầu")).toBeInTheDocument();
    expect(within(claude).getByText("và 2 lượt của video khác")).toBeInTheDocument();

    const renders = screen.getByRole("region", { name: "Render" });
    expect(within(renders).getAllByText("Series Kyoto · Tập 1 · bản cuối")).toHaveLength(2);
    expect(within(renders).getByText("farm · máy có NVENC · đang chạy · 62%")).toBeInTheDocument();
    expect(within(renders).getByText("farm · máy có GPU · chờ máy · 30 phút")).toBeInTheDocument();
    expect(within(renders).getByText("Chưa máy nào nhận sau 10 phút; có thể không có máy hợp yêu cầu.")).toBeInTheDocument();
    expect(within(renders).getByText("và 1 job của video khác")).toBeInTheDocument();

    const waiting = screen.getByRole("region", { name: "Chờ bạn duyệt" });
    expect(await within(waiting).findByRole("link", { name: "Huế · Kế hoạch tập" })).toHaveAttribute("href", "/v/p2");
    fireEvent.click(within(waiting).getByRole("link", { name: "Series Kyoto · Tập 2 · Timeline" }));
    expect(await screen.findByText("episode page")).toBeInTheDocument();
  });

  it("lists the farm's machines and names the node a job runs on or is pinned to", async () => {
    client.getQueue.mockResolvedValue({
      ...queue,
      renders: [
        { ...queue.renders[0]!, node: { id: "n1", name: "render-01" }, pinned: null },
        { ...queue.renders[1]!, node: null, pinned: { id: "n2", name: "render-02" } },
      ],
      machines: [
        { id: "n1", name: "render-01", online: true, kinds: ["studio.render_final"], gpus: [{ name: "RTX 3060", vram_mb: 12288, nvenc: true }], running_jobs: 1, last_seen_at: null },
        { id: "n2", name: "render-02", online: false, kinds: ["studio.render_final"], gpus: [], running_jobs: 0, last_seen_at: null },
      ],
    });
    mount();
    const renders = screen.getByRole("region", { name: "Render" });
    expect(await within(renders).findByText("farm · máy có NVENC · đang chạy · trên render-01 · 62%")).toBeInTheDocument();
    expect(within(renders).getByText("farm · ghim render-02 · chờ máy · 30 phút")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Máy trên farm" })).toBeInTheDocument();
    expect(screen.getByText("render-01")).toBeInTheDocument();
    expect(screen.getByText("đang bật · 1 job đang chạy")).toBeInTheDocument();
    expect(screen.getByText("đang tắt · 0 job đang chạy")).toBeInTheDocument();
  });

  it("the farm out of reach is said; no machine is listed, only what the types mean", async () => {
    client.getQueue.mockResolvedValue({ ...queue, renders: [], hiddenRenders: 0, farm: { ok: false, error: "connect ECONNREFUSED" } });
    mount();
    expect(await screen.findByText("Không đọc được hàng đợi farm: connect ECONNREFUSED")).toBeInTheDocument();
    expect(screen.getByText("Farm chưa liệt kê máy nào (hub cũ hoặc chưa máy nào bật).")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Kiểu máy render" })).toBeInTheDocument();
    expect(screen.getByText("Máy có NVENC")).toBeInTheDocument();
  });

  it("an admin sets the Claude cap here; anyone else only reads it", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    mount();
    const input = await screen.findByLabelText("Số lượt chạy cùng lúc");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(client.setClaudeMaxConcurrent).toHaveBeenCalledWith(12));
  });

  it("the header chips count Claude calls and render jobs, and lead here", async () => {
    mount();
    expect(await screen.findByRole("link", { name: "Claude: 3/20 lượt đang chạy · 1 lượt chờ" })).toHaveAttribute("href", "/queue");
    expect(await screen.findByRole("link", { name: "Render: 2 job" })).toHaveAttribute("href", "/queue");
    expect(screen.getByRole("link", { name: "Hàng đợi" })).toHaveAttribute("href", "/queue");
  });
});
