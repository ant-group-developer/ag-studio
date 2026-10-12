import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { QueueItem, StudioQueueView } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const base = {
  phase: null, detail: null, notBefore: null, progress: null, etaSeconds: null, node: null, parentId: null, threadId: null, threadTitle: null,
  videoId: null, jobKind: null, projectId: "p1", projectName: "Du lịch chậm", teamId: "t1",
} as const;
const turn: QueueItem = { ...base, id: "m1", kind: "agent_turn", status: "running", title: "agent", startedAt: "2026-10-06T10:29:00.000Z", cancellable: true, threadId: "th1", threadTitle: "Kênh" };
const job: QueueItem = {
  ...base, id: "j1", kind: "job", status: "running", title: "Render xem trước", detail: "Farm · GPU-02 · đang render", progress: 0.4, etaSeconds: 90,
  node: "GPU-02", startedAt: "2026-10-06T10:28:00.000Z", cancellable: true, jobKind: "render_preview", videoId: "v1",
};
const queue: StudioQueueView = {
  claude: { running: 1, waiting: 0, max: 20, source: "env" },
  items: [turn, job],
  hidden: 2,
  machines: [{ id: "n1", name: "GPU-02", online: true, kinds: ["studio.render_final"], gpus: [{ name: "RTX", vram_mb: 12288, nvenc: true }], running_jobs: 1, last_seen_at: null }],
  farm: { ok: true },
};

const client = {
  getMe: vi.fn(),
  getQueue: vi.fn(),
  listTeams: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 1, waiting: 0, max: 20, source: "env" }),
  setClaudeMaxConcurrent: vi.fn().mockResolvedValue({ running: 1, waiting: 0, max: 12, source: "settings" }),
};
const ws = { cancelJob: vi.fn().mockResolvedValue({}), cancelTurn: vi.fn().mockResolvedValue({}) };
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));
const { QueuePage } = await import("./QueuePage");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={["/queue"]}>
          <Routes>
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/p/:projectId/*" element={<p>project page</p>} />
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

  it("lists what runs in each project: who, where, how far, the machine, time left; the rest only counted", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Hàng đợi" })).toBeInTheDocument();
    const running = screen.getByRole("region", { name: "Đang chạy" });
    expect(await within(running).findByText("Du lịch chậm · Kênh")).toBeInTheDocument();
    expect(within(running).getByText(/Farm · GPU-02 · đang render · 40%/)).toBeInTheDocument();
    expect(within(running).getByText(/2:00 · còn ≈ 1:30/)).toBeInTheDocument();
    expect(within(running).getByText("và 2 việc của dự án khác")).toBeInTheDocument();
    expect(screen.getByText("GPU-02")).toBeInTheDocument();
    expect(screen.getByText("đang bật · 1 job đang chạy")).toBeInTheDocument();
    expect(screen.getByText(/STUDIO_CLAUDE_MAX_CONCURRENT/)).toBeInTheDocument();
  });

  it("stops a job and a turn from the list", async () => {
    mount();
    const running = await screen.findByRole("region", { name: "Đang chạy" });
    const stops = await within(running).findAllByRole("button", { name: "Dừng" });
    fireEvent.click(stops[1]!);
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j1"));
    fireEvent.click(stops[0]!);
    await waitFor(() => expect(ws.cancelTurn).toHaveBeenCalledWith("th1", "m1"));
  });

  it("an admin names the AI and sets the cap; the farm out of reach says so", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    client.getQueue.mockResolvedValue({ ...queue, items: [], hidden: 0, machines: null, farm: { ok: false, error: "ECONNREFUSED" } });
    mount();
    expect(await screen.findByLabelText("Tên hiển thị")).toBeInTheDocument();
    expect(await screen.findByLabelText("Số lượt chạy cùng lúc")).toBeInTheDocument();
    expect(screen.getByText("Không có việc nào đang chạy trong các dự án bạn thấy.")).toBeInTheDocument();
    expect(screen.getByText("Không đọc được danh sách máy farm: ECONNREFUSED")).toBeInTheDocument();
  });

  it("only an admin sees that YouTube blocks the Studio server", async () => {
    const youtube = { blockedAt: "2026-10-06T09:00:00.000Z", until: "2026-10-06T15:00:00.000Z", where: "studio" as const };
    client.getQueue.mockResolvedValue({ ...queue, youtube });
    mount();
    await screen.findByRole("region", { name: "Đang chạy" });
    expect(screen.queryByText(/YouTube đang chặn tải từ máy chủ Studio/)).toBeNull();
  });

  it("an admin is told when YouTube blocks the Studio server, with the API key hint", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    client.getQueue.mockResolvedValue({ ...queue, youtube: { blockedAt: "2026-10-06T09:00:00.000Z", until: "2026-10-06T15:00:00.000Z", where: "studio" } });
    mount();
    const alert = await screen.findByText(/^YouTube đang chặn tải từ máy chủ Studio từ/);
    expect(alert.textContent).toMatch(/tải video mẫu sẽ lỗi/);
    expect(screen.getByText(/Đặt YOUTUBE_API_KEY cho worker/)).toBeInTheDocument();
  });

  it("blocked but farm machines fetch reference videos: the admin is told they go through the farm; the farm blocked too is said apart", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    const block = { blockedAt: "2026-10-06T09:00:00.000Z", until: "2026-10-06T15:00:00.000Z" };
    client.getQueue.mockResolvedValue({ ...queue, youtube: { ...block, where: "studio" }, youtubeFarm: null, referenceFetchers: ["PC-01", "PC-02"] });
    mount();
    const alert = await screen.findByText(/^YouTube đang chặn tải từ máy chủ Studio từ/);
    expect(alert.textContent).toMatch(/Video mẫu được tải qua máy farm thay \(PC-01, PC-02\)/);
    expect(alert.textContent).not.toMatch(/tải video mẫu sẽ lỗi/);
  });

  it("the farm machines blocked too: the server warning comes back and the farm's block is said", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    const block = { blockedAt: "2026-10-06T09:00:00.000Z", until: "2026-10-06T15:00:00.000Z" };
    client.getQueue.mockResolvedValue({ ...queue, youtube: { ...block, where: "studio" }, youtubeFarm: { ...block, where: "farm" }, referenceFetchers: ["PC-01"] });
    mount();
    expect((await screen.findByText(/^YouTube đang chặn tải từ máy chủ Studio từ/)).textContent).toMatch(/tải video mẫu sẽ lỗi/);
    expect(screen.getByText(/^YouTube cũng đang chặn tải từ các máy farm/)).toBeInTheDocument();
  });
});
