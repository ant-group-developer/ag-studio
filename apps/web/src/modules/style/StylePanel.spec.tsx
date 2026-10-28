import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { VideoLookView } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const CHANNEL = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m", font: "Be Vietnam Pro" } as const;
const NONE = { text_look: null, look: null, color_match: null };
const view = (over: Partial<VideoLookView> = {}): VideoLookView => ({
  own: NONE, plan: { ...NONE, look: "vivid" }, channel: { ...NONE, text_look: CHANNEL },
  effective: { text_look: CHANNEL, look: "vivid", color_match: false, from: { text_look: "channel", look: "plan", color_match: "default" } },
  choices: { fonts: [{ name: "Arial", scripts: ["vietnamese"] }, { name: "Be Vietnam Pro", scripts: ["vietnamese"] }, { name: "Montserrat", scripts: [] }, { name: "Jua", scripts: ["korean"] }], sizes: ["s", "m", "l"], looks: ["none", "natural", "vivid", "warm", "cinematic"] },
  revision: null, ...over,
});
const ws = {
  getVideoLook: vi.fn(),
  setVideoLook: vi.fn(),
  listFiles: vi.fn(),
  listSources: vi.fn().mockResolvedValue({ sources: [] }),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../inputs/ag-go-projects/ProjectGridView", () => ({ useThumbnailUrl: () => undefined }));
const { StylePanel } = await import("./StylePanel");

function mount(video?: { id: string; title: string }) {
  const handlers = { onOpenFile: vi.fn(), onPrompt: vi.fn(), onReferences: vi.fn() };
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
    ws.setVideoLook.mockImplementation(async (_v: string, own: VideoLookView["own"]) => view({
      own, effective: { text_look: own.text_look ?? CHANNEL, look: own.look ?? "vivid", color_match: own.color_match ?? false, from: { text_look: own.text_look ? "video" : "channel", look: own.look ? "video" : "plan", color_match: "default" } },
      revision: 4,
    }));
    ws.listFiles.mockResolvedValue({ entries: [{ path: "channel/style.md", kind: "file", size: 1, mtime: "", access: "write" }, { path: "channel/branding.md", kind: "file", size: 1, mtime: "", access: "write" }] });
  });

  it("shows where the video's words and picture come from, and saves only what was changed", async () => {
    mount({ id: "v1", title: "Tràng An buổi sáng" });
    const text = await screen.findByRole("region", { name: "Chữ trên video" });
    expect(within(text).getByText("Theo Branding")).toBeInTheDocument();
    await waitFor(() => expect(within(text).getByText("Tràng An buổi sáng")).toHaveStyle({ fontFamily: '"Be Vietnam Pro", Arial, sans-serif' }));
    expect(screen.getByRole("region", { name: "Tông màu" })).toHaveTextContent("Theo kế hoạch dựng");
    expect(screen.getByRole("button", { name: "Lưu cho video này" })).toBeDisabled();
    // the tones show as frames to pick
    expect(within(screen.getByRole("radiogroup", { name: "Tông màu" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Giữ nguyên", "Tự nhiên", "Rực rỡ", "Ấm áp", "Điện ảnh"]);
    expect(screen.getByRole("radio", { name: "Rực rỡ" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(text).getByText("Lớn"));
    expect(within(text).queryByText("Theo Branding")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lưu cho video này" }));
    // the words become the video's own; the picture keeps following the plan
    await waitFor(() => expect(ws.setVideoLook).toHaveBeenCalledWith("v1", { text_look: { ...CHANNEL, size: "l" }, look: null, color_match: null }));
    expect(await screen.findByText("Đã lưu vào timeline. Bản xem trước tiếp theo sẽ có chữ và màu mới.")).toBeInTheDocument();
    expect(await within(text).findByText("Riêng video này")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dùng lại mặc định của kênh" }));
    await waitFor(() => expect(ws.setVideoLook).toHaveBeenLastCalledWith("v1", NONE));
  });

  it("on the channel's page sends the font to each video, and opens the edit style, the references and the agent", async () => {
    const h = mount();
    expect(await screen.findByText(/chọn riêng cho từng video/)).toBeInTheDocument();
    expect(ws.getVideoLook).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /Xem phong cách dựng/ }));
    expect(h.onOpenFile).toHaveBeenCalledWith("channel/style.md");
    fireEvent.click(screen.getByRole("button", { name: /Video tham khảo/ }));
    expect(h.onReferences).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /học phong cách/ }));
    expect(h.onPrompt).toHaveBeenCalledWith(expect.stringContaining("channel/style.md"));
  });
});
