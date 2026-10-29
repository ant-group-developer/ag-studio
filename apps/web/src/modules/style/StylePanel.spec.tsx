import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ProjectLookView, VideoLookView } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const CHANNEL = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m", font: "Be Vietnam Pro" } as const;
const NONE = { text_look: null, look: null, color_match: null };
const CHOICES: VideoLookView["choices"] = {
  fonts: [{ name: "Arial", scripts: ["vietnamese"] }, { name: "Be Vietnam Pro", scripts: ["vietnamese"] }, { name: "Montserrat", scripts: [] }, { name: "Jua", scripts: ["korean"] }],
  sizes: ["s", "m", "l"], looks: ["none", "natural", "vivid", "warm", "cinematic"],
};
const view = (over: Partial<VideoLookView> = {}): VideoLookView => ({
  own: NONE, project: NONE, plan: { ...NONE, look: "vivid" }, channel: { ...NONE, text_look: CHANNEL },
  effective: { text_look: CHANNEL, look: "vivid", color_match: false, from: { text_look: "channel", look: "plan", color_match: "default" } },
  choices: CHOICES, revision: null, ...over,
});
const projectView = (over: Partial<ProjectLookView> = {}): ProjectLookView => ({
  own: NONE, channel: { ...NONE, text_look: CHANNEL },
  videos: [{ id: "v1", idx: 1, title: "Hoa Lư", ownLook: false }, { id: "v2", idx: 2, title: "Tràng An", ownLook: true }],
  choices: CHOICES, ...over,
});
const ws = {
  getVideoLook: vi.fn(),
  setVideoLook: vi.fn(),
  getProjectLook: vi.fn(),
  setProjectLook: vi.fn(),
  listFiles: vi.fn(),
  listSources: vi.fn().mockResolvedValue({ sources: [] }),
  listVideos: vi.fn().mockResolvedValue({ videos: [] }),
  removeSource: vi.fn().mockResolvedValue(undefined),
  uploadSource: vi.fn(),
  listMedia: vi.fn().mockResolvedValue({ items: [], total: 0, bytes: 0 }),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../inputs/ag-go-projects/ProjectGridView", () => ({ useThumbnailUrl: () => undefined }));
const { StylePanel } = await import("./StylePanel");

function mount(video?: { id: string; idx: number; title: string }) {
  const handlers = { onOpenFile: vi.fn(), onPrompt: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><StylePanel projectId="p1" video={video} canEdit {...handlers} /></AntApp>
    </QueryClientProvider>,
  );
  return handlers;
}

describe("Style tab", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getVideoLook.mockResolvedValue(view());
    ws.getProjectLook.mockResolvedValue(projectView());
    ws.setVideoLook.mockImplementation(async (_v: string, own: VideoLookView["own"]) => view({
      own, effective: { text_look: own.text_look ?? CHANNEL, look: own.look ?? "vivid", color_match: own.color_match ?? false, from: { text_look: own.text_look ? "video" : "channel", look: own.look ? "video" : "plan", color_match: "default" } },
      revision: 4,
    }));
    ws.setProjectLook.mockImplementation(async (_p: string, own: ProjectLookView["own"], o: { everyVideo?: boolean }) => projectView({
      own, ...(o.everyVideo ? { videos: projectView().videos.map((v) => ({ ...v, ownLook: false })), cleared: ["v2"], timelines: 2 } : {}),
    }));
    ws.listFiles.mockResolvedValue({ entries: [{ path: "channel/style.md", kind: "file", size: 1, mtime: "", access: "write" }, { path: "channel/branding.md", kind: "file", size: 1, mtime: "", access: "write" }] });
  });

  it("in a video: says it follows the project, where each part comes from, and saves only what was changed for the video", async () => {
    mount({ id: "v1", idx: 1, title: "Tràng An buổi sáng" });
    const card = await screen.findByRole("region", { name: "Chữ và tông màu" });
    expect(await screen.findByText("Video #1 đang theo phong cách dự án. Đổi ở đây sẽ chỉ áp cho video này.")).toBeInTheDocument();
    expect(within(card).getByText("Theo Branding")).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByText("Tràng An buổi sáng")).toHaveStyle({ fontFamily: '"Be Vietnam Pro", Arial, sans-serif' }));
    expect(card).toHaveTextContent("Theo kế hoạch dựng");
    expect(screen.getByRole("button", { name: "Lưu cho video #1" })).toBeDisabled();
    // the tones show as frames to pick
    expect(within(screen.getByRole("radiogroup", { name: "Tông màu" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Giữ nguyên", "Tự nhiên", "Rực rỡ", "Ấm áp", "Điện ảnh"]);
    expect(screen.getByRole("radio", { name: "Rực rỡ" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(card).getByText("Lớn"));
    expect(within(card).queryByText("Theo Branding")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lưu cho video #1" }));
    // the words become the video's own; the picture keeps following the plan
    await waitFor(() => expect(ws.setVideoLook).toHaveBeenCalledWith("v1", { text_look: { ...CHANNEL, size: "l" }, look: null, color_match: null }));
    expect(await screen.findByText("Đã lưu vào timeline. Bản xem trước tiếp theo sẽ có chữ và màu mới.")).toBeInTheDocument();
    expect(await screen.findByText("Video #1 dùng phong cách riêng. Phong cách dự án không áp cho video này.")).toBeInTheDocument();
    // back to the project's style
    fireEvent.click(screen.getByText("Theo dự án"));
    await waitFor(() => expect(ws.setVideoLook).toHaveBeenLastCalledWith("v1", NONE));
  });

  it("in a video: applies what it shows to every video after saying whose own style is replaced", async () => {
    mount({ id: "v1", idx: 1, title: "Hoa Lư" });
    await screen.findByRole("region", { name: "Chữ và tông màu" });
    fireEvent.click(screen.getByRole("radio", { name: "Ấm áp" }));
    fireEvent.click(screen.getByRole("button", { name: "Áp cho mọi video…" }));
    const dialog = await screen.findByRole("dialog", { name: "Áp phong cách này cho mọi video?" });
    expect(dialog).toHaveTextContent("#1 Hoa Lưđang theo dự án");
    expect(dialog).toHaveTextContent("#2 Tràng Anphong cách riêng sẽ bị thay");
    fireEvent.click(within(dialog).getByRole("button", { name: "Áp cho 2 video" }));
    await waitFor(() => expect(ws.setProjectLook).toHaveBeenCalledWith("p1", { text_look: CHANNEL, look: "warm", color_match: false }, { everyVideo: true }));
    expect(await screen.findByText("Đã áp cho 2 video.")).toBeInTheDocument();
  });

  it("on the project page: edits the project's style for every video, and opens the edit style and the agent", async () => {
    const h = mount();
    const card = await screen.findByRole("region", { name: "Chữ và tông màu" });
    expect(ws.getVideoLook).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Phong cách chung của dự án · Áp cho mọi video chưa chọn riêng (1/2 video). Đang dùng phong cách riêng: #2.");
    fireEvent.click(within(card).getByText("Lớn"));
    fireEvent.click(screen.getByRole("button", { name: "Lưu cho cả dự án" }));
    await waitFor(() => expect(ws.setProjectLook).toHaveBeenCalledWith("p1", { text_look: { ...CHANNEL, size: "l" }, look: null, color_match: null }, { everyVideo: false }));
    expect(await screen.findByText("Đã lưu phong cách dự án.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Xem phong cách dựng/ }));
    expect(h.onOpenFile).toHaveBeenCalledWith("channel/style.md");
    fireEvent.click(screen.getByRole("button", { name: /học phong cách/ }));
    expect(h.onPrompt).toHaveBeenCalledWith(expect.stringContaining("channel/style.md"));
  });

  it("lists the reference videos, adds them from the computer or the library, and removes one", async () => {
    ws.listSources.mockResolvedValue({ sources: [
      { id: "s1", projectId: "p1", videoId: null, kind: "upload", ref: "context/references/Kênh mẫu.mp4", mediaType: "video", label: "Kênh mẫu.mp4", meta: { reference: true }, addedBy: "u", addedAt: "", asset: null, mediaId: "m-1" },
      { id: "s2", projectId: "p1", videoId: null, kind: "upload", ref: "context/uploads/a.md", mediaType: "document", label: "a.md", meta: {}, addedBy: "u", addedAt: "", asset: null },
    ] });
    ws.uploadSource.mockResolvedValue({ source: {} });
    const h = mount();
    const refs = await screen.findByRole("region", { name: "Video tham khảo" });
    expect(await within(refs).findByText("Kênh mẫu.mp4")).toBeInTheDocument();
    expect(refs).not.toHaveTextContent("a.md");
    fireEvent.click(within(refs).getByRole("button", { name: "Kênh mẫu.mp4" }));
    expect(h.onOpenFile).toHaveBeenCalledWith("context/references/Kênh mẫu.mp4");
    const input = within(refs).getByLabelText("Tải từ máy", { selector: "input" });
    expect(input).toHaveAttribute("accept", expect.stringContaining(".mp4"));
    fireEvent.change(input, { target: { files: [new File(["v"], "mau.mp4", { type: "video/mp4" })] } });
    await waitFor(() => expect(ws.uploadSource).toHaveBeenCalledWith("p1", expect.any(File), undefined, { reference: true, onProgress: expect.any(Function) }));
    // once the upload is through, the button says what it adds again
    fireEvent.click(await within(refs).findByRole("button", { name: "Thêm video mẫu" }));
    fireEvent.click(await screen.findByText("Từ thư viện của tôi", { selector: ".ws-sec__menuitem > span" }));
    expect(await screen.findByRole("dialog", { name: /Thư viện của tôi/ })).toBeInTheDocument();
    await waitFor(() => expect(ws.listMedia).toHaveBeenCalledWith({ kind: "video", limit: 120 }));
    fireEvent.click(within(refs).getByRole("button", { name: "Bỏ Kênh mẫu.mp4" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bỏ" }));
    await waitFor(() => expect(ws.removeSource).toHaveBeenCalledWith("p1", "s1"));
  });
});
