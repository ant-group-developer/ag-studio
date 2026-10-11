import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const started = new Date(Date.now() - 20_000).toISOString();
const ws = {
  estimateResearch: vi.fn(),
  runResearch: vi.fn(),
  listResearch: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue({}),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
const { ResearchPanel } = await import("./ResearchPanel");

function mount(onOpenFile = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><ResearchPanel projectId="p1" canRun onOpenFile={onOpenFile} /></AntApp>
    </QueryClientProvider>,
  );
  return onOpenFile;
}

describe("Research tab", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.estimateResearch.mockImplementation(async (_p: string, c: { kind: string; max?: number }) => ({
      request: c, title: "x", units: c.kind === "trending" ? 1 : 101, large: (c.max ?? 0) > 100, source: "youtube_api",
    }));
    ws.runResearch.mockResolvedValue({ id: "j1" });
    ws.listResearch.mockResolvedValue({ files: [
      { path: "research/2026-10-10-chu-de-pho-co.md", title: 'Video xem nhiều: "phố cổ" (VN, 90 ngày)', modifiedAt: new Date().toISOString(), size: 10,
        crawl: { kind: "topic", fetchedAt: "", source: "youtube_api", videos: 30, channels: 0, quotaUnits: 101 } },
      { path: "research/report.md", title: "Báo cáo thị trường", modifiedAt: new Date().toISOString(), size: 10, crawl: null },
    ] });
    ws.listJobs.mockResolvedValue({ jobs: [{
      id: "j0", projectId: "p1", videoId: null, threadId: null, kind: "research", status: "running", title: "Xu hướng YouTube VN", request: {}, result: null, error: null,
      phase: "Đang lấy video xu hướng (0/30)", progress: 0, etaSeconds: 5, nodeId: null, cancelRequested: false, createdBy: "u", createdAt: started, startedAt: started, finishedAt: null,
    }] });
  });

  it("shows what a topic crawl costs, then runs it with what was asked", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Chủ đề"), { target: { value: "phố cổ Hội An" } });
    expect(await screen.findByText("≈ 101 đơn vị hạn mức YouTube API (mặc định 10.000/ngày).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Chạy/ }));
    await waitFor(() => expect(ws.runResearch).toHaveBeenCalledWith("p1", { kind: "topic", q: "phố cổ Hội An", region: "VN", days: 90, order: "viewCount", max: 30 }));
  });

  it("trending needs no topic; a large crawl is flagged", async () => {
    mount();
    fireEvent.click(screen.getByText("Xu hướng"));
    expect(await screen.findByText("≈ 1 đơn vị hạn mức YouTube API (mặc định 10.000/ngày).")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Số video"), { target: { value: "150" } });
    expect(await screen.findByText(/Crawl lớn/)).toBeInTheDocument();
  });

  it("lists running crawls with Stop and the research documents to open", async () => {
    const open = mount();
    const card = await screen.findByRole("group", { name: "Xu hướng YouTube VN" });
    fireEvent.click(within(card).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j0"));
    const docs = screen.getByRole("region", { name: "Tài liệu nghiên cứu" });
    expect(docs).toHaveTextContent("30 video · API, 101 đơn vị");
    fireEvent.click(within(docs).getByRole("button", { name: "Báo cáo thị trường" }));
    expect(open).toHaveBeenCalledWith("research/report.md");
  });
});
