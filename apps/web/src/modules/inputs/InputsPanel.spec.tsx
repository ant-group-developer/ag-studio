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
  agGoAccess: vi.fn(),
  removeSource: vi.fn().mockResolvedValue(undefined),
  uploadSource: vi.fn(),
  uploadFootage: vi.fn(),
  searchFootage: vi.fn(),
  getFootageFacets: vi.fn(),
  prepareInputs: vi.fn().mockResolvedValue({ assets: {} }),
  cancelJob: vi.fn().mockResolvedValue(job({ cancelRequested: true })),
  listVideos: vi.fn(),
  getAudio: vi.fn(),
  audioFromFile: vi.fn(),
  musicFromLibrary: vi.fn(),
  declineVoice: vi.fn(),
  clearAudio: vi.fn(),
};
const agGo = {
  getProjects: vi.fn().mockResolvedValue({ items: [
    { id: "agp-1", name: "Ninh Bình (đã có)", videoCount: 4, imageCount: 0, mediaCount: 4 },
    { id: "agp-2", name: "Ninh Bình mùa lúa", folderId: "f-1", folderName: "Ninh Bình", folderPath: "Miền Bắc / Ninh Bình", categoryId: "cat-1", categoryName: "Du lịch", videoCount: 12, imageCount: 3, mediaCount: 15 },
    { id: "agp-3", name: "Chưa quay", videoCount: 0, imageCount: 2, mediaCount: 2 },
    { id: "agp-4", name: "Tràng An", videoCount: 5, imageCount: 0, mediaCount: 5 },
  ], page: 1, pageSize: 24, total: 4, totalPages: 1 }),
  getAssetPreviewUrl: vi.fn().mockRejectedValue(new Error("no thumbnail")),
  findProvinces: vi.fn().mockResolvedValue([]),
  getProject: vi.fn(),
  getProjectMedia: vi.fn(),
  getFolders: vi.fn(),
  getCategories: vi.fn().mockResolvedValue([{ id: "cat-1", name: "Du lịch" }, { id: "cat-2", name: "Ẩm thực" }]),
  getTags: vi.fn().mockResolvedValue([{ id: "tag-1", name: "lúa" }]),
  getFolderTree: vi.fn().mockResolvedValue([{ id: "f-1", parentId: null, name: "Ninh Bình", pathText: "Miền Bắc/Ninh Bình", depth: 1 }]),
  getCountries: vi.fn().mockResolvedValue([{ id: "vn", name: "Việt Nam" }]),
  getProvinces: vi.fn().mockResolvedValue([{ id: "nb", countryId: "vn", name: "Ninh Bình" }]),
  getProjectOwners: vi.fn().mockResolvedValue([{ id: "u-1", projectCount: 4, user: { id: "u-1", name: "Lan" } }]),
};
/** Whether the person may add each ag-go project, as Studio answers (`POST ag-go-access`). */
let access: Record<string, string> = {};
const answerAccess = async (_p: string, ids: string[]) => ({
  items: ids.map((projectId) => ({ projectId, state: access[projectId] ?? "not_visible", analyzedVideos: 4, usableVideos: 3 })),
});
const facets = {
  projects: [{ value: "agp-1", label: "Ninh Bình", count: 2 }], categories: [], provinces: [], authors: [], resolutions: [{ value: "4k", count: 1 }],
  orientations: [{ value: "landscape", count: 2 }], timesOfDay: [], genres: [], tags: [{ value: "sông", count: 2 }, { value: "chùa", count: 1 }],
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGo }));

const { InputsPanel } = await import("./InputsPanel");

function mount(videoId?: string, onOpenFile = vi.fn(), canEdit = true) {
  const r = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <InputsPanel projectId="p1" {...(videoId ? { videoId } : {})} canEdit={canEdit} onOpenFile={onOpenFile} />
      </AntApp>
    </QueryClientProvider>,
  );
  Object.assign(onOpenFile, { unmount: r.unmount });
  return onOpenFile;
}
/** The detail drawer of an ag-go project, by its title (antd gives every drawer the same label id in tests). */
async function detailDrawer(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name, { selector: ".agp-detail__title" })).closest<HTMLElement>(".ant-drawer-content")!;
}
/** Switches the Inputs tab to its "Documents, images, audio" sub-section. */
async function toFiles() {
  fireEvent.click(await screen.findByText(/^Tài liệu, ảnh, audio ·/));
}

describe("Inputs tab", { timeout: 40_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    ws.getFootageFacets.mockResolvedValue(facets);
    access = { "agp-1": "addable", "agp-2": "addable", "agp-3": "no_videos", "agp-4": "addable" };
    ws.agGoAccess.mockImplementation(answerAccess);
    ws.listSources.mockResolvedValue({ sources: [
      src({ kind: "ag_go_project", ref: "agp-1", mediaType: "mixed", label: "Ninh Bình", meta: { videos: 42 } }),
      src({ kind: "ag_go_asset", ref: A1, videoId: "v1", mediaType: "video", label: "Hoa Lư 03.mp4", meta: { durationMs: 72_400 },
        asset: { state: "ready", folder: `inputs/${A1}/`, readme: `inputs/${A1}/README.md`, shots: 12, duration_s: 72.4, transcript: true } }),
      src({ kind: "ag_go_asset", ref: A2, videoId: "v1", mediaType: "video", label: "Tràng An 01.mp4", asset: { state: "failed", error: "ag-go không trả được video" } }),
      src({ kind: "upload", ref: "context/uploads/Ghi chú.md", mediaType: "document", label: "Ghi chú.md" }),
    ] });
    ws.getAudio.mockResolvedValue({ voice: null, music: null, summary: { voice: "", music: "" }, libraryTrack: null, enabled: true, files: [] });
    ws.listJobs.mockResolvedValue({ jobs: [job({})] });
    ws.listVideos.mockResolvedValue({ videos: [] });
  });

  it("shows the jobs in one line that unfolds to who runs each job, what it does, how far, time spent and left, and stops it", async () => {
    mount("v1");
    const line = await screen.findByRole("button", { name: /1 việc nền/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line).toHaveTextContent("1 đang chạy · 0 đang chờ");
    expect(line).toHaveTextContent("40% xong · còn ≈ 1:30");
    expect(screen.queryByRole("group", { name: "Chuẩn bị Hoa Lư 03.mp4" })).toBeNull();
    fireEvent.click(line);
    const card = await screen.findByRole("group", { name: "Chuẩn bị Hoa Lư 03.mp4" });
    expect(card).toHaveTextContent("Farm · máy GPU-02");
    expect(card).toHaveTextContent("Farm · GPU-02 · whisper · đọc lời thoại");
    expect(card).toHaveTextContent(/đã \d+:\d\d/);
    expect(card).toHaveTextContent("còn ≈ 1:30");
    fireEvent.click(within(card).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j1"));
  });

  it("puts the project's voice and music first, above the jobs and the lists", async () => {
    mount("v1");
    const audio = await screen.findByRole("region", { name: "Giọng đọc và nhạc nền" });
    await screen.findByRole("group", { name: "Giọng đọc" });
    expect(screen.getAllByRole("region")[0]).toBe(audio);
    expect(ws.getAudio).toHaveBeenCalledWith("p1");
  });

  it("never shows an asset id where a video's name should be", async () => {
    ws.listSources.mockResolvedValue({ sources: [src({ kind: "ag_go_asset", ref: A2, videoId: "v1", mediaType: "video", label: A2 })] });
    ws.listJobs.mockResolvedValue({ jobs: [job({ title: `Chuẩn bị ${A2}` })] });
    mount("v1");
    fireEvent.click(await screen.findByRole("button", { name: /1 việc nền/ }));
    expect(await screen.findByRole("group", { name: "Chuẩn bị video chưa có tên" })).toBeInTheDocument();
    expect(screen.getAllByText("video chưa có tên").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(A2);
  });

  it("lists the ag-go projects, this video's ag-go videos with their preparation, and uploads", async () => {
    const open = mount("v1");
    const footage = await screen.findByRole("region", { name: "Footage của video này" });
    expect(footage).toHaveTextContent("Hoa Lư 03.mp4");
    expect(footage).toHaveTextContent("1:12 · 12 cảnh · có lời thoại");
    fireEvent.click(within(footage).getByRole("button", { name: "Mở" }));
    expect(open).toHaveBeenCalledWith(`inputs/${A1}/README.md`);
    expect(footage).toHaveTextContent("ag-go không trả được video");
    fireEvent.click(within(footage).getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(ws.prepareInputs).toHaveBeenCalledWith("p1", [A2], false));
    expect(screen.getByRole("region", { name: "Project AG Go" })).toHaveTextContent("Ninh Bình42 video");
    expect(screen.queryByRole("region", { name: "Tài liệu, ảnh, audio" })).toBeNull();
    await toFiles();
    fireEvent.click(within(screen.getByRole("region", { name: "Tài liệu, ảnh, audio" })).getByRole("button", { name: "Ghi chú.md" }));
    expect(open).toHaveBeenCalledWith("context/uploads/Ghi chú.md");
  });

  it("picks several ag-go projects in a full-screen drawer like ag-go's, adds them together and says which failed", async () => {
    ws.addSource.mockResolvedValueOnce({ source: {} }).mockRejectedValueOnce(new StudioHttpError(422, { message: "x", code: "ag_go_view_only" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const drawer = await screen.findByRole("dialog", { name: /Chọn project AG Go/ });
    expect(await within(drawer).findByText("Ninh Bình mùa lúa")).toBeInTheDocument();
    // each card of the page says whether the person may add it, asked as them
    await waitFor(() => expect(within(drawer).getByTestId("agp-card-agp-2")).toHaveTextContent("Thêm được"));
    expect(ws.agGoAccess).toHaveBeenCalledWith("p1", ["agp-1", "agp-2", "agp-3", "agp-4"]);
    expect(within(drawer).getByTestId("agp-card-agp-1")).toHaveTextContent("Đã thêm");
    expect(within(drawer).getByTestId("agp-card-agp-3")).toHaveTextContent("Chưa có video đã phân tích");
    expect(within(drawer).getByRole("checkbox", { name: "Ninh Bình (đã có)" })).toBeDisabled();
    expect(within(drawer).getByRole("checkbox", { name: "Chưa quay" })).toBeDisabled();
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "Ninh Bình mùa lúa" }));
    fireEvent.click(within(drawer).getByTestId("agp-card-agp-4"));
    expect(within(drawer).getByText("Đã chọn 2 dự án")).toBeInTheDocument();
    access["agp-4"] = "view_only";
    fireEvent.click(within(drawer).getAllByRole("button", { name: /Thêm 2 dự án/ })[0]!);
    await waitFor(() => expect(ws.addSource).toHaveBeenCalledTimes(2));
    expect(ws.addSource.mock.calls).toEqual([
      ["p1", { kind: "ag_go_project", ref: "agp-2", label: "Ninh Bình mùa lúa" }],
      ["p1", { kind: "ag_go_project", ref: "agp-4", label: "Tràng An" }],
    ]);
    const warning = await screen.findByText("1 dự án không thêm được", { selector: ".ant-modal-confirm-title" });
    const content = warning.closest(".ant-modal-content")!;
    expect(content).toHaveTextContent("Tràng An: Bạn chỉ xem được bản có watermark: cần quyền tải bản gốc của project này trên AG Go để thêm.");
    // refused for its state: unticked, and its card says it once asked again
    expect(within(drawer).queryByText("Đã chọn 1 dự án")).toBeNull();
    await waitFor(() => expect(within(drawer).getByTestId("agp-card-agp-4")).toHaveTextContent("Chỉ xem (watermark)"));
    expect(within(drawer).getByRole("checkbox", { name: "Tràng An" })).toBeDisabled();
  });

  it("a project that failed for another reason stays ticked, with its error, to try again", async () => {
    ws.addSource.mockRejectedValueOnce(new StudioHttpError(503, { message: "Studio đang bận" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const drawer = await screen.findByRole("dialog", { name: /Chọn project AG Go/ });
    const box = await within(drawer).findByRole("checkbox", { name: "Ninh Bình mùa lúa" });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    fireEvent.click(within(drawer).getAllByRole("button", { name: /Thêm 1 dự án/ })[0]!);
    const warning = await screen.findByText("1 dự án không thêm được", { selector: ".ant-modal-confirm-title" });
    expect(warning.closest(".ant-modal-content")).toHaveTextContent("Ninh Bình mùa lúa: Studio đang bận");
    expect(within(drawer).getByText("Đã chọn 1 dự án")).toBeInTheDocument();
  });

  it("opens a project in Studio: what ag-go says of it, its images and videos as the person sees them, and adds it from there", async () => {
    access["agp-2"] = "view_only";
    agGo.getProject.mockResolvedValue({ id: "agp-2", name: "Ninh Bình mùa lúa", videoCount: 12, imageCount: 3, mediaCount: 15, description: "Lúa chín ở Tam Cốc", tags: ["lúa", "đồng"], folderPath: "Miền Bắc / Ninh Bình" });
    agGo.getProjectMedia.mockResolvedValue({ items: [
      { id: "m1", assetId: "a-1", caption: "Đồng lúa.mp4", thumbnailUrl: "https://r2.test/t1.jpg", previewUrl: "https://r2.test/p1-wm.mp4", watermarkVariant: "720p_wm", durationSeconds: 65, width: 1280, height: 720, asset: { assetType: "video" } },
      { id: "m2", assetId: "a-2", caption: "Cổng chùa.jpg", thumbnailUrl: "https://r2.test/t2.jpg", previewUrl: null, durationSeconds: null, width: 800, height: 600, asset: { assetType: "image" } },
    ], nextCursor: null });
    ws.addSource.mockResolvedValue({ source: {} });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const drawer = await screen.findByRole("dialog", { name: /Chọn project AG Go/ });
    await waitFor(() => expect(within(drawer).getByTestId("agp-card-agp-2")).toHaveTextContent("Chỉ xem (watermark)"));
    expect(within(drawer).getByRole("checkbox", { name: "Ninh Bình mùa lúa" })).toBeDisabled();
    fireEvent.click(within(drawer).getByRole("button", { name: "Xem chi tiết Ninh Bình mùa lúa" }));
    const detail = await detailDrawer("Ninh Bình mùa lúa");
    expect(await within(detail).findByText("Lúa chín ở Tam Cốc")).toBeInTheDocument();
    expect(detail).toHaveTextContent("Miền Bắc / Ninh Bình");
    expect(detail).toHaveTextContent("3 ảnh · 12 video");
    expect(detail).toHaveTextContent("3/4 video đã phân tích dùng được");
    expect(detail).toHaveTextContent("cần quyền tải bản gốc của project này");
    expect(agGo.getProjectMedia).toHaveBeenCalledWith("agp-2", { limit: 48 });
    expect(within(detail).getByRole("button", { name: "Thêm vào dự án" })).toBeDisabled();
    // a video plays in place, from the preview the person may see
    fireEvent.click(await within(detail).findByRole("button", { name: "Phát Đồng lúa.mp4" }));
    const player = await screen.findByLabelText("Phát Đồng lúa.mp4", { selector: "video" });
    expect(player).toHaveAttribute("src", "https://r2.test/p1-wm.mp4");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    // a project the person may add is added from its detail
    access["agp-2"] = "addable";
    fireEvent.click(within(drawer).getByRole("button", { name: "Xem chi tiết Tràng An" }));
    const other = await detailDrawer("Tràng An");
    const add = within(other).getByRole("button", { name: "Thêm vào dự án" });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(ws.addSource).toHaveBeenCalledWith("p1", { kind: "ag_go_project", ref: "agp-4", label: "Tràng An" }));
  });

  it("asks before removing an ag-go project whose videos are still used, then removes it anyway", async () => {
    ws.removeSource.mockRejectedValueOnce(new StudioHttpError(409, { message: "x", code: "project_in_use", assets: 2, videos: ["Tràng An", "Hoa Lư"] }));
    mount();
    const projects = await screen.findByRole("region", { name: "Project AG Go" });
    fireEvent.click(within(projects).getByRole("button", { name: "Bỏ Ninh Bình" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bỏ" }));
    await waitFor(() => expect(ws.removeSource).toHaveBeenCalledWith("p1", expect.any(String), {}));
    const title = await screen.findByText("Vẫn gỡ Ninh Bình?", { selector: ".ant-modal-confirm-title" });
    const content = title.closest(".ant-modal-content") as HTMLElement;
    expect(content).toHaveTextContent("2 video đang dùng thuộc project này");
    expect(content).toHaveTextContent("Dùng trong: Tràng An, Hoa Lư");
    fireEvent.click(within(content).getByRole("button", { name: "Vẫn gỡ" }));
    await waitFor(() => expect(ws.removeSource).toHaveBeenLastCalledWith("p1", ws.removeSource.mock.calls[0]![1], { force: true }));
  });

  it("filters, searches, sorts and pages ag-go projects as ag-go does, in a list or a grid", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm project" }));
    const drawer = await screen.findByRole("dialog", { name: /Chọn project AG Go/ });
    await within(drawer).findByText("Ninh Bình mùa lúa");
    expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 24, sortBy: "updatedAt", sortOrder: "desc" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Bộ lọc" }));
    const filters = await waitFor(() => { const el = document.querySelector<HTMLElement>(".ant-drawer-left .ant-drawer-content"); if (!el) throw new Error("no filters drawer"); return el; });
    fireEvent.click(await within(filters).findByText("Du lịch"));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ categoryIds: ["cat-1"], page: 1 })));
    expect(within(filters).getByText("1 bộ lọc đang áp dụng")).toBeInTheDocument();
    fireEvent.click(within(filters).getByRole("button", { name: "Xóa bộ lọc" }));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.not.objectContaining({ categoryIds: expect.anything() })));
    const search = within(drawer).getByRole("combobox", { name: "Tìm dự án, thư mục, danh mục, tag, địa điểm..." });
    fireEvent.change(search, { target: { value: "lúa" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "lúa" })));
    fireEvent.click(within(drawer).getByRole("button", { name: /Ngày cập nhật/ }));
    fireEvent.click(await screen.findByText("Tăng dần"));
    await waitFor(() => expect(agGo.getProjects).toHaveBeenLastCalledWith(expect.objectContaining({ sortOrder: "asc" })));
    fireEvent.click(within(drawer).getByTitle("Dạng danh sách"));
    expect((await within(drawer).findAllByRole("table")).length).toBeGreaterThan(0);
    expect(within(drawer).getByRole("columnheader", { name: "Số lượng file" })).toBeInTheDocument();
    expect(localStorage.getItem("studio.agp.viewMode")).toBe("list");
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

  it("uploads videos and photos from the computer as footage of the video, prepared at once, and lists them with the ag-go ones", async () => {
    ws.uploadFootage.mockResolvedValue({ source: src({}), prepare: { state: "queued", job_id: "j9", phase: null, progress: null } });
    ws.listSources.mockResolvedValue({ sources: [
      src({ kind: "upload_asset", ref: A1, videoId: "v1", mediaType: "image", label: "đỉnh Múa.jpg",
        asset: { state: "ready", folder: `inputs/${A1}/`, readme: `inputs/${A1}/README.md`, shots: 1, duration_s: 6, transcript: false } }),
      src({ kind: "upload_asset", ref: A2, videoId: "v1", mediaType: "video", label: "Hang Múa.mov", asset: { state: "preparing", job_id: "j9", phase: null, progress: 0.3 } }),
    ] });
    mount("v1");
    const footage = await screen.findByRole("region", { name: "Footage của video này" });
    expect(footage).toHaveTextContent("ảnh tải từ máy · 0:06 · 1 cảnh");
    expect(footage).toHaveTextContent("video tải từ máy");
    expect(footage).toHaveTextContent("Đang chuẩn bị 30%");
    const input = within(footage).getByLabelText("Tải từ máy", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["v"], "Hang Múa.mov", { type: "video/quicktime" })] } });
    await waitFor(() => expect(ws.uploadFootage).toHaveBeenCalledWith("p1", expect.any(File), "v1", expect.any(Function)));
    expect(await screen.findByText("Đã tải lên 1 footage, đang chuẩn bị")).toBeTruthy();
  });

  it("uploads files into the project", async () => {
    ws.uploadSource.mockResolvedValue({ source: src({}), file: {} });
    mount();
    await toFiles();
    const input = await screen.findByLabelText("Tải lên", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["# x"], "brief.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(ws.uploadSource).toHaveBeenCalledWith("p1", expect.any(File), undefined, { onProgress: expect.any(Function) }));
  });

  it("uploads reference videos apart from the documents, to learn an edit style from", async () => {
    ws.listSources.mockResolvedValue({ sources: [
      src({ kind: "upload", ref: "context/uploads/Ghi chú.md", mediaType: "document", label: "Ghi chú.md" }),
      src({ kind: "upload", ref: "context/references/Kênh mẫu.mp4", mediaType: "video", label: "Kênh mẫu.mp4", meta: { reference: true } }),
    ] });
    ws.uploadSource.mockResolvedValue({ source: src({}), file: {} });
    mount();
    await toFiles();
    const refs = await screen.findByRole("region", { name: "Video tham khảo (học phong cách dựng)" });
    expect(await within(refs).findByText("Kênh mẫu.mp4")).toBeInTheDocument();
    expect(within(refs).queryByText("Ghi chú.md")).toBeNull();
    expect(screen.getByRole("region", { name: "Tài liệu, ảnh, audio" })).not.toHaveTextContent("Kênh mẫu.mp4");
    const input = within(refs).getByLabelText("Tải video mẫu", { selector: "input" });
    expect(input).toHaveAttribute("accept", expect.stringContaining(".mp4"));
    fireEvent.change(input, { target: { files: [new File(["v"], "mau.mp4", { type: "video/mp4" })] } });
    await waitFor(() => expect(ws.uploadSource).toHaveBeenCalledWith("p1", expect.any(File), undefined, { reference: true, onProgress: expect.any(Function) }));
  });

  it("remembers the sub-section shown, with a count on each", async () => {
    const first = mount();
    expect(await screen.findByText("Footage · 2")).toBeInTheDocument();
    expect(screen.getByText("Tài liệu, ảnh, audio · 1")).toBeInTheDocument();
    await toFiles();
    expect(localStorage.getItem("studio.inputs.section")).toBe("files");
    (first as unknown as { unmount: () => void }).unmount();
    mount();
    expect(await screen.findByRole("region", { name: "Tài liệu, ảnh, audio" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Project AG Go" })).toBeNull();
  });

  it("with many projects: a search box, five shown and the rest on demand", async () => {
    const names = ["Hà Giang", "Sa Pa", "Mộc Châu", "Hạ Long", "Cát Bà", "Tam Cốc", "Bái Đính"];
    ws.listSources.mockResolvedValue({ sources: names.map((n, i) => src({ kind: "ag_go_project", ref: `agp-${i}`, mediaType: "mixed", label: n, meta: { videos: i } })) });
    mount();
    const region = await screen.findByRole("region", { name: "Project AG Go" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(within(region).getByRole("button", { name: "Xem tất cả (7)" }));
    expect(within(region).getAllByRole("listitem")).toHaveLength(7);
    fireEvent.change(within(region).getByRole("searchbox", { name: "Tìm project" }), { target: { value: "tam" } });
    expect(within(region).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Tam Cốc5 video"]);
  });

  it("on the project page: a summary, videos grouped by Studio video (each once), search, a state filter and bulk prepare/retry", async () => {
    const asset = (ref: string, label: string, videoId: string | null, asset: SourceItem["asset"]) => src({ kind: "ag_go_asset", ref, label, videoId, mediaType: "video", asset });
    const ready = { state: "ready" as const, folder: "", readme: "inputs/r/README.md", shots: 3, duration_s: 10, transcript: false };
    ws.listVideos.mockResolvedValue({ videos: [
      { id: "v2", projectId: "p1", idx: 2, title: "Tràng An", status: "draft", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null },
      { id: "v1", projectId: "p1", idx: 1, title: "Hoa Lư", status: "draft", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null },
    ] });
    ws.listSources.mockResolvedValue({
      sources: [
        asset("a1", "Hoa Lư 01.mp4", "v1", ready),
        asset("a2", "Hoa Lư 02.mp4", "v1", { state: "failed", error: "hỏng" }),
        asset("a2", "Hoa Lư 02.mp4", "v1", { state: "failed", error: "hỏng" }),
        asset("a3", "Tràng An 01.mp4", "v2", { state: "not_prepared" }),
        asset("a1", "Hoa Lư 01.mp4", "v2", ready),
        asset("a4", "Bến thuyền.mp4", "v2", { state: "queued", job_id: "j", phase: null, progress: null }),
      ],
      counts: { videos: 4, ready: 1, preparing: 1, failed: 1, notPrepared: 1 },
    });
    mount();
    expect(await screen.findByLabelText("Tình trạng video AG Go")).toHaveTextContent("4 video · 1 sẵn sàng · 1 đang chuẩn bị · 1 lỗi · 1 chưa chuẩn bị");
    const region = screen.getByRole("region", { name: "Footage của các video" });
    const heads = await within(region).findAllByRole("button", { expanded: false });
    expect(heads.map((h) => h.textContent)).toEqual(["1. Hoa Lư2 videoLỗi", "2. Tràng An3 videoĐang chuẩn bị"]);
    expect(within(region).queryByText("Hoa Lư 02.mp4")).toBeNull();
    fireEvent.click(heads[0]!);
    expect(within(region).getAllByText("Hoa Lư 02.mp4")).toHaveLength(1);
    fireEvent.change(within(region).getByRole("searchbox", { name: "Tìm video theo tên" }), { target: { value: "bến" } });
    expect(within(region).getByText("Bến thuyền.mp4")).toBeInTheDocument();
    expect(within(region).queryByText("Hoa Lư 02.mp4")).toBeNull();
    fireEvent.change(within(region).getByRole("searchbox", { name: "Tìm video theo tên" }), { target: { value: "" } });
    // the summary filters the list to the failed ones
    fireEvent.click(screen.getByRole("button", { name: "1 lỗi" }));
    await waitFor(() => expect(within(region).getAllByRole("button", { expanded: true })).toHaveLength(1));
    expect(within(region).getByText("Hoa Lư 02.mp4")).toBeInTheDocument();
    expect(within(region).queryByText("Tràng An 01.mp4")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Chuẩn bị các video chưa chuẩn bị (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chuẩn bị" }, { timeout: 3000 }));
    await waitFor(() => expect(ws.prepareInputs).toHaveBeenCalledWith("p1", ["a3"]));
    fireEvent.click(within(region).getByRole("button", { name: /Thử lại các video lỗi \(1\)/ }));
    const retry = await screen.findAllByRole("button", { name: "Thử lại" });
    fireEvent.click(retry[retry.length - 1]!);
    await waitFor(() => expect(ws.prepareInputs).toHaveBeenCalledWith("p1", ["a2"]));
  });

  it("on the project page uploads footage from the computer into the video picked, or straight into a video's group", async () => {
    ws.uploadFootage.mockResolvedValue({ source: src({}), prepare: { state: "queued", job_id: "j9", phase: null, progress: null } });
    ws.listVideos.mockResolvedValue({ videos: [
      { id: "v2", projectId: "p1", idx: 2, title: "Tràng An", status: "draft", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null },
      { id: "v1", projectId: "p1", idx: 1, title: "Hoa Lư", status: "draft", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null },
    ] });
    ws.listSources.mockResolvedValue({ sources: [src({ kind: "ag_go_asset", ref: "a1", label: "Hoa Lư 01.mp4", videoId: "v1", mediaType: "video", asset: { state: "not_prepared" } })] });
    mount();
    const region = await screen.findByRole("region", { name: "Footage của các video" });
    const file = new File(["x"], "Bái Đính.mp4", { type: "video/mp4" });
    fireEvent.change(within(region).getByLabelText("Tải từ máy", { selector: "input" }), { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Bái Đính.mp4");
    // the newest video is picked first
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Chọn video" }));
    fireEvent.click(await screen.findByTitle("#1 Hoa Lư"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Tải lên" }));
    await waitFor(() => expect(ws.uploadFootage).toHaveBeenCalledWith("p1", file, "v1", expect.any(Function)));
    // an open video's group takes footage straight in (the only group shows open)
    fireEvent.click(within(region).getByRole("button", { name: "Tải từ máy vào video này" }));
    fireEvent.change(within(region).getByLabelText("Tải từ máy vào video này", { selector: "input" }), { target: { files: [file] } });
    await waitFor(() => expect(ws.uploadFootage).toHaveBeenCalledTimes(2));
    expect(ws.uploadFootage).toHaveBeenLastCalledWith("p1", file, "v1", expect.any(Function));
  });

  it("shows 30 videos at a time and no bulk buttons to a viewer", async () => {
    ws.listSources.mockResolvedValue({ sources: Array.from({ length: 35 }, (_, i) => src({
      kind: "ag_go_asset", ref: `a${i}`, label: `Clip ${i}.mp4`, videoId: "v1", mediaType: "video", asset: { state: "not_prepared" },
    })) });
    mount("v1", vi.fn(), false);
    const region = await screen.findByRole("region", { name: "Footage của video này" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(30);
    expect(within(region).queryByRole("button", { name: /Chuẩn bị các video/ })).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Xem thêm (5)" }));
    expect(within(region).getAllByRole("listitem")).toHaveLength(35);
  });
});

describe("jobs of a chat", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  it("shows the jobs this chat started above the message box in one line that unfolds, and stops one", async () => {
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
    const line = await screen.findByRole("button", { name: /1 việc nền/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line).toHaveTextContent("1 đang chạy · 0 đang chờ");
    expect(line).toHaveTextContent("30% xong · còn ≈ 0:40");
    expect(screen.queryByRole("group")).toBeNull();
    fireEvent.click(line);
    const card = await screen.findByRole("group", { name: "Chuẩn bị Tam Cốc.mp4" });
    expect(card).toHaveTextContent("Studio (ffmpeg trên máy chủ)");
    expect(card).toHaveTextContent("Đang dò cảnh (0:30 / 1:12)");
    expect(screen.queryByText("Việc của luồng khác")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Dừng" }));
    await waitFor(() => expect(ws.cancelJob).toHaveBeenCalledWith("p1", "j9"));
  });

  it("many jobs: one summary line; unfolded, every card with the running ones first", async () => {
    const row = (i: number, status: "running" | "waiting") => ({
      id: `j${i}`, kind: "job", status, title: `Chuẩn bị clip ${i}.mp4`, phase: null, detail: null, startedAt: started, notBefore: null, progress: null,
      etaSeconds: null, node: null, cancellable: true, parentId: null, threadId: "t1", threadTitle: "Tràng An", videoId: "v1", jobKind: "prepare_asset",
    });
    Object.assign(ws, { getActivity: vi.fn().mockResolvedValue({ activity: [row(1, "waiting"), row(2, "running"), row(3, "waiting"), row(4, "waiting")] }) });
    const { ThreadJobs } = await import("./ThreadJobs");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AntApp><ThreadJobs projectId="p1" threadId="t1" canStop /></AntApp>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("4 việc nền")).toBeInTheDocument();
    expect(screen.getByText("1 đang chạy · 3 đang chờ")).toBeInTheDocument();
    expect(screen.getByText("0% xong")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /4 việc nền/ }));
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")))
      .toEqual(["Chuẩn bị clip 2.mp4", "Chuẩn bị clip 1.mp4", "Chuẩn bị clip 3.mp4", "Chuẩn bị clip 4.mp4"]);
    expect(screen.queryByRole("button", { name: /Xem tất cả/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /4 việc nền/ }));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
