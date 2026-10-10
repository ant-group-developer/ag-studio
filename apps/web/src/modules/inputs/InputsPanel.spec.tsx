import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { StudioHttpError } from "../../api/http";
import type { JobView, SourceItem } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const A1 = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const A2 = "1c8b6d45-6e2f-4e5d-8b62-4e3b2f1d8e22";
const src = (over: Partial<SourceItem>): SourceItem => ({
  id: `s-${Math.random()}`, projectId: "p1", videoId: null, kind: "upload", ref: "", mediaType: "document", label: "", meta: {}, addedBy: "u",
  addedAt: "", asset: null, ...over,
});
const started = new Date(Date.now() - 75_000).toISOString();
const job = (over: Partial<JobView>): JobView => ({
  id: "j1", projectId: "p1", videoId: "v1", threadId: "t1", kind: "prepare_asset", status: "running", title: "Chuẩn bị Hoa Lư 03.mp4", request: {},
  result: null, error: null, phase: "Farm · GPU-02 · whisper · đọc lời thoại", progress: 0.4, etaSeconds: 90, nodeId: "GPU-02", cancelRequested: false,
  createdBy: "u", createdAt: started, startedAt: started, finishedAt: null, ...over,
});

const ws = {
  listSources: vi.fn(),
  listJobs: vi.fn(),
  addSource: vi.fn(),
  removeSource: vi.fn().mockResolvedValue(undefined),
  uploadSource: vi.fn(),
  searchFootage: vi.fn(),
  prepareInputs: vi.fn().mockResolvedValue({ assets: {} }),
  cancelJob: vi.fn().mockResolvedValue(job({ cancelRequested: true })),
};
const agGo = {
  getProjects: vi.fn().mockResolvedValue({ items: [{ id: "agp-2", name: "Ninh Bình mùa lúa", folderPath: "Miền Bắc/Ninh Bình", videoCount: 12, imageCount: 3, mediaCount: 15 }], page: 1, pageSize: 30, total: 1, totalPages: 1 }),
  getProjectMedia: vi.fn(),
  getFolders: vi.fn(),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGo }));

const { InputsPanel } = await import("./InputsPanel");

function mount(videoId?: string, onOpenFile = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <InputsPanel projectId="p1" {...(videoId ? { videoId } : {})} canEdit onOpenFile={onOpenFile} />
      </AntApp>
    </QueryClientProvider>,
  );
  return onOpenFile;
}

describe("Inputs tab", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.listSources.mockResolvedValue({ sources: [
      src({ kind: "ag_go_project", ref: "agp-1", mediaType: "mixed", label: "Ninh Bình", meta: { videos: 42 } }),
      src({ kind: "ag_go_asset", ref: A1, videoId: "v1", mediaType: "video", label: "Hoa Lư 03.mp4", meta: { durationMs: 72_400 },
        asset: { state: "ready", folder: `inputs/${A1}/`, readme: `inputs/${A1}/README.md`, shots: 12, duration_s: 72.4, transcript: true } }),
      src({ kind: "ag_go_asset", ref: A2, videoId: "v1", mediaType: "video", label: "Tràng An 01.mp4", asset: { state: "failed", error: "ag-go không trả được video" } }),
      src({ kind: "upload", ref: "context/uploads/Ghi chú.md", mediaType: "document", label: "Ghi chú.md" }),
    ] });
    ws.listJobs.mockResolvedValue({ jobs: [job({})] });
  });

  it("shows who runs each job, what it does, how far, time spent and left, and stops it", async () => {
    mount("v1");
    const card = await screen.findByRole("group", { name: "Chuẩn bị Hoa Lư 03.mp4" });
    expect(card).toHaveTextContent("Farm · máy GPU-02");
    expect(card).toHaveTextContent("Farm · GPU-02 · whisper · đọc lời thoại");
    expect(card).toHaveTextContent(/đã 1:1\d/);
    expect(card).toHaveTextContent("còn ≈ 1:30");
    fireEvent.click(within(card).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j1"));
  });

  it("lists the ag-go projects, this video's ag-go videos with their preparation, and uploads", async () => {
    const open = mount("v1");
    const footage = await screen.findByRole("region", { name: "Video ag-go của video này" });
    expect(footage).toHaveTextContent("Hoa Lư 03.mp4");
    expect(footage).toHaveTextContent("1:12 · 12 cảnh · có lời thoại");
    fireEvent.click(within(footage).getByRole("button", { name: "Mở" }));
    expect(open).toHaveBeenCalledWith(`inputs/${A1}/README.md`);
    expect(footage).toHaveTextContent("ag-go không trả được video");
    fireEvent.click(within(footage).getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(ws.prepareInputs).toHaveBeenCalledWith("p1", [A2], false));
    expect(screen.getByRole("region", { name: "Project ag-go" })).toHaveTextContent("Ninh Bình42 video");
    fireEvent.click(within(screen.getByRole("region", { name: "Tài liệu, ảnh, audio" })).getByRole("button", { name: "Ghi chú.md" }));
    expect(open).toHaveBeenCalledWith("context/uploads/Ghi chú.md");
  });

  it("adds an ag-go project from the person's own ag-go projects; says when the owner cannot see it", async () => {
    ws.addSource.mockRejectedValueOnce(new StudioHttpError(422, { message: "x", code: "owner_cannot_access" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn project ag-go" });
    expect(await within(dialog).findByText("Ninh Bình mùa lúa")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Miền Bắc/Ninh Bình · 12 video · 3 ảnh");
    fireEvent.click(within(dialog).getByRole("button", { name: "Thêm" }));
    await waitFor(() => expect(ws.addSource).toHaveBeenCalledWith("p1", { kind: "ag_go_project", ref: "agp-2", label: "Ninh Bình mùa lúa" }));
    expect(await screen.findByText("Chủ dự án không thấy video nào trong project ag-go này")).toBeInTheDocument();
  });

  it("picks ag-go videos for the video in the order ticked, adds and prepares them", async () => {
    ws.searchFootage.mockResolvedValue({ total: 2, nextCursor: null, items: [
      { assetId: "a-3", name: "Bái Đính.mp4", durationMs: 30_000, hasSpeech: false, summaryVi: "Chùa trên núi", prepared: { state: "not_prepared" } },
      { assetId: "a-4", name: "Tam Cốc.mp4", durationMs: 45_000, hasSpeech: true, prepared: { state: "not_prepared" } },
    ] });
    ws.addSource.mockResolvedValue({ source: src({}) });
    mount("v1");
    fireEvent.click(await screen.findByRole("button", { name: "Chọn video" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn video ag-go cho video này" });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Tam Cốc.mp4" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Bái Đính.mp4" }));
    expect(dialog).toHaveTextContent("Thứ tự dùng: Tam Cốc.mp4, Bái Đính.mp4");
    fireEvent.click(within(dialog).getByRole("button", { name: "Thêm và chuẩn bị 2 video" }));
    await waitFor(() => expect(ws.addSource).toHaveBeenCalledTimes(2));
    expect(ws.addSource.mock.calls.map((c) => c[1].ref)).toEqual(["a-4", "a-3"]);
    expect(ws.addSource.mock.calls[0]![1]).toMatchObject({ kind: "ag_go_asset", videoId: "v1", prepare: true, meta: { durationMs: 45_000 } });
  });

  it("uploads files into the project", async () => {
    ws.uploadSource.mockResolvedValue({ source: src({}), file: {} });
    mount();
    const input = await screen.findByLabelText("Tải lên", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["# x"], "brief.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(ws.uploadSource).toHaveBeenCalledWith("p1", expect.any(File), undefined));
  });
});
