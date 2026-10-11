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
  getFootageFacets: vi.fn(),
  prepareInputs: vi.fn().mockResolvedValue({ assets: {} }),
  cancelJob: vi.fn().mockResolvedValue(job({ cancelRequested: true })),
};
const agGo = {
  getProjects: vi.fn().mockResolvedValue({ items: [{ id: "agp-2", name: "Ninh Bình mùa lúa", folderPath: "Miền Bắc/Ninh Bình", videoCount: 12, imageCount: 3, mediaCount: 15 }], page: 1, pageSize: 30, total: 1, totalPages: 1 }),
  getProjectMedia: vi.fn(),
  getFolders: vi.fn(),
  getCategories: vi.fn().mockResolvedValue([{ id: "cat-1", name: "Du lịch" }, { id: "cat-2", name: "Ẩm thực" }]),
  getTags: vi.fn().mockResolvedValue([{ id: "tag-1", name: "lúa" }]),
  getFolderTree: vi.fn().mockResolvedValue([{ id: "f-1", parentId: null, name: "Ninh Bình", pathText: "Miền Bắc/Ninh Bình", depth: 1 }]),
  getCountries: vi.fn().mockResolvedValue([{ id: "vn", name: "Việt Nam" }]),
  getProvinces: vi.fn().mockResolvedValue([{ id: "nb", countryId: "vn", name: "Ninh Bình" }]),
  getProjectOwners: vi.fn().mockResolvedValue([{ id: "u-1", projectCount: 4, user: { id: "u-1", name: "Lan" } }]),
};
const facets = {
  projects: [{ value: "agp-1", label: "Ninh Bình", count: 2 }], categories: [], provinces: [], authors: [], resolutions: [{ value: "4k", count: 1 }],
  orientations: [{ value: "landscape", count: 2 }], timesOfDay: [], genres: [], tags: [{ value: "sông", count: 2 }, { value: "chùa", count: 1 }],
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

describe("Inputs tab", { timeout: 40_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    ws.getFootageFacets.mockResolvedValue(facets);
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
    const footage = await screen.findByRole("region", { name: "Video AG Go của video này" });
    expect(footage).toHaveTextContent("Hoa Lư 03.mp4");
    expect(footage).toHaveTextContent("1:12 · 12 cảnh · có lời thoại");
    fireEvent.click(within(footage).getByRole("button", { name: "Mở" }));
    expect(open).toHaveBeenCalledWith(`inputs/${A1}/README.md`);
    expect(footage).toHaveTextContent("ag-go không trả được video");
    fireEvent.click(within(footage).getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(ws.prepareInputs).toHaveBeenCalledWith("p1", [A2], false));
    expect(screen.getByRole("region", { name: "Project AG Go" })).toHaveTextContent("Ninh Bình42 video");
    fireEvent.click(within(screen.getByRole("region", { name: "Tài liệu, ảnh, audio" })).getByRole("button", { name: "Ghi chú.md" }));
    expect(open).toHaveBeenCalledWith("context/uploads/Ghi chú.md");
  });

  it("adds an ag-go project from the person's own ag-go projects; says when the owner cannot see it", async () => {
    ws.addSource.mockRejectedValueOnce(new StudioHttpError(422, { message: "x", code: "owner_cannot_access" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn project AG Go" });
    expect(await within(dialog).findByText("Ninh Bình mùa lúa")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Miền Bắc/Ninh Bình");
    expect(dialog).toHaveTextContent("12 video · 3 ảnh");
    fireEvent.click(within(dialog).getByRole("button", { name: "Thêm" }));
    await waitFor(() => expect(ws.addSource).toHaveBeenCalledWith("p1", { kind: "ag_go_project", ref: "agp-2", label: "Ninh Bình mùa lúa" }));
    expect(await screen.findByText("Chủ dự án không thấy video nào trong project AG Go này")).toBeInTheDocument();
  });

  it("filters, sorts and pages ag-go projects as ag-go does; a grid shows the same projects", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn project AG Go" });
    await within(dialog).findByText("Ninh Bình mùa lúa");
    expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 20, sortBy: "updatedAt", sortOrder: "desc" }));
    fireEvent.click(await within(dialog).findByText("Du lịch"));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ categoryIds: ["cat-1"], page: 1 })));
    fireEvent.click(within(dialog).getByRole("button", { name: "Giảm dần" }));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ sortOrder: "asc" })));
    fireEvent.click(within(dialog).getByRole("button", { name: "Xoá lọc" }));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ categoryIds: [] })));
    fireEvent.click(within(dialog).getByText("Lưới"));
    expect(within(dialog).queryByRole("table")).toBeNull();
    expect(within(dialog).getByText("Ninh Bình mùa lúa")).toBeInTheDocument();
    expect(localStorage.getItem("studio.picker.projects.viewMode")).toBe("grid");
  });

  it("filters the video picker with ag-go's facets and keeps the tick order across the table and the grid", async () => {
    ws.searchFootage.mockResolvedValue({ total: 2, nextCursor: null, items: [
      { assetId: "a-3", name: "Bái Đính.mp4", durationMs: 30_000, prepared: { state: "not_prepared" } },
      { assetId: "a-4", name: "Tam Cốc.mp4", durationMs: 45_000, prepared: { state: "not_prepared" } },
    ] });
    mount("v1");
    fireEvent.click(await screen.findByRole("button", { name: "Chọn video" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn video AG Go cho video này" });
    await waitFor(() => expect(ws.searchFootage).toHaveBeenLastCalledWith("p1", { usability: "usable", sortBy: "relevance", sortOrder: "desc", page: 1, limit: 40 }));
    expect(ws.getFootageFacets).toHaveBeenLastCalledWith("p1", { usability: "usable" });
    fireEvent.click(await within(dialog).findByLabelText("Tam Cốc.mp4"));
    fireEvent.click(within(dialog).getByText("Lưới"));
    fireEvent.click(within(dialog).getByLabelText("Bái Đính.mp4"));
    expect(dialog).toHaveTextContent("Thứ tự dùng: Tam Cốc.mp4, Bái Đính.mp4");
    fireEvent.click(within(dialog).getByText("Tag"));
    const tags = await within(dialog).findByRole("group", { name: "Tag" });
    expect(tags).toHaveTextContent("sông2");
    fireEvent.click(within(tags).getByText("sông"));
    await waitFor(() => expect(ws.searchFootage).toHaveBeenLastCalledWith("p1", expect.objectContaining({ tags: ["sông"], page: 1 })));
    expect(ws.getFootageFacets).toHaveBeenLastCalledWith("p1", { usability: "usable", tags: ["sông"] });
  });

  it("picks ag-go videos for the video in the order ticked, adds and prepares them", async () => {
    ws.searchFootage.mockResolvedValue({ total: 2, nextCursor: null, items: [
      { assetId: "a-3", name: "Bái Đính.mp4", durationMs: 30_000, hasSpeech: false, summaryVi: "Chùa trên núi", prepared: { state: "not_prepared" } },
      { assetId: "a-4", name: "Tam Cốc.mp4", durationMs: 45_000, hasSpeech: true, prepared: { state: "not_prepared" } },
    ] });
    ws.addSource.mockResolvedValue({ source: src({}) });
    mount("v1");
    fireEvent.click(await screen.findByRole("button", { name: "Chọn video" }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn video AG Go cho video này" });
    fireEvent.click(await within(dialog).findByLabelText("Tam Cốc.mp4"));
    fireEvent.click(within(dialog).getByLabelText("Bái Đính.mp4"));
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

describe("jobs of a chat", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  it("shows the jobs this chat started above the message box, and stops one", async () => {
    const getActivity = vi.fn().mockResolvedValue({ activity: [
      { id: "j9", kind: "job", status: "running", title: "Chuẩn bị Tam Cốc.mp4", phase: null, detail: "Đang dò cảnh (0:30 / 1:12)", startedAt: started, notBefore: null,
        progress: 0.3, etaSeconds: 40, node: null, cancellable: true, parentId: null, threadId: "t1", threadTitle: "Tràng An", videoId: "v1", jobKind: "prepare_asset" },
      { id: "j8", kind: "job", status: "running", title: "Việc của luồng khác", phase: null, detail: null, startedAt: started, notBefore: null,
        progress: null, etaSeconds: null, node: null, cancellable: true, parentId: null, threadId: "t2", threadTitle: "Khác", videoId: null, jobKind: "prepare_asset" },
    ] });
    Object.assign(ws, { getActivity });
    const { ThreadJobs } = await import("./ThreadJobs");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AntApp><ThreadJobs projectId="p1" threadId="t1" canStop /></AntApp>
      </QueryClientProvider>,
    );
    const card = await screen.findByRole("group", { name: "Chuẩn bị Tam Cốc.mp4" });
    expect(card).toHaveTextContent("Studio (ffmpeg trên máy chủ)");
    expect(card).toHaveTextContent("Đang dò cảnh (0:30 / 1:12)");
    expect(screen.queryByText("Việc của luồng khác")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j9"));
  });
});
