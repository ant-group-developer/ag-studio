/**
 * vitest tests for ThumbnailPanel: tab grouping, select (PUT), delete (deletable only), the word editor's
 * debounced preview + compose, and the Canva buttons (hidden when disabled, open + pull back when enabled).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { describe, expect, it, vi, beforeEach } from "vitest";
import i18n from "../../i18n/config";
import type { ThumbnailList, ThumbnailView } from "../../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

function mkThumb(overrides: Partial<ThumbnailView> & { id: string }): ThumbnailView {
  return {
    kind: "suggestion",
    tS: null,
    assetId: "a-1",
    parentId: null,
    text: "Hello",
    style: null,
    width: 1280,
    height: 720,
    sizeBytes: 1000,
    createdBy: "system",
    createdAt: "2026-01-01T00:00:00Z",
    url: "https://r2.test/t.jpg",
    downloadUrl: "https://r2.test/t.jpg?dl=1",
    deletable: false,
    drawable: true,
    inCanva: false,
    ...overrides,
  };
}

const sug = mkThumb({ id: "s-1", kind: "suggestion" });
const frameSystem = mkThumb({ id: "f-1", kind: "frame", tS: 65, createdBy: "system" });
const frameCaptured = mkThumb({ id: "f-2", kind: "frame", tS: 10, createdBy: "user-1", deletable: true });
const composed = mkThumb({ id: "c-1", kind: "composed", createdBy: "user-1", deletable: true, drawable: false });

function baseList(overrides: Partial<ThumbnailList> = {}): ThumbnailList {
  return {
    items: [sug, frameSystem, frameCaptured, composed],
    selectedId: "s-1",
    canDraw: true,
    canCutFrames: false,
    framesPending: false,
    framesError: null,
    footageHidden: false,
    ...overrides,
  };
}

const mockClient = {
  listThumbnails: vi.fn(),
  getCanvaConnection: vi.fn(),
  getProductionBranding: vi.fn(),
  selectThumbnail: vi.fn(),
  deleteThumbnail: vi.fn(),
  startCutFrames: vi.fn(),
  uploadThumbnail: vi.fn(),
  previewThumbnail: vi.fn(),
  composeThumbnail: vi.fn(),
  openThumbnailInCanva: vi.fn(),
  pullCanvaThumbnail: vi.fn(),
  authorizeCanva: vi.fn(),
};

vi.mock("../../api/studio-client", async (orig) => ({
  ...(await orig<object>()),
  useStudioClient: () => mockClient,
}));

const { ThumbnailPanel } = await import("./ThumbnailPanel");

function renderPanel(canEdit = true) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <ThumbnailPanel productionId="p1" episodeId="e1" youtubeKit={null} canEdit={canEdit} />
      </AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.listThumbnails.mockResolvedValue(baseList());
  mockClient.getCanvaConnection.mockResolvedValue({ enabled: false, connected: false, displayName: null });
  mockClient.getProductionBranding.mockResolvedValue({ document: null, updatedAt: "", updatedBy: "" });
});

describe("ThumbnailPanel", () => {
  it("groups pictures into Gợi ý / Khung hình / Của tôi correctly", async () => {
    await i18n.changeLanguage("vi");
    renderPanel();

    // "Gợi ý" is the default tab
    expect(await screen.findByRole("button", { name: "s-1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Khung hình" }));
    expect(await screen.findByRole("button", { name: "f-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "f-2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "c-1" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Của tôi" }));
    // A person-captured frame counts as "made by a person": shown here too, alongside composed pictures.
    expect(await screen.findByRole("button", { name: "f-2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "c-1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "f-1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "s-1" })).toBeNull();
  });

  it("picking a tile and 'Dùng làm thumbnail' calls PUT selected", async () => {
    await i18n.changeLanguage("vi");
    mockClient.selectThumbnail.mockResolvedValue(baseList({ selectedId: "s-1" }));
    renderPanel();

    // s-1 is already selected (disabled "Dùng làm thumbnail"); f-1 is not — pick that one instead.
    fireEvent.click(await screen.findByRole("tab", { name: "Khung hình" }));
    fireEvent.click(await screen.findByRole("button", { name: "f-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Dùng làm thumbnail" }));
    await waitFor(() => expect(mockClient.selectThumbnail).toHaveBeenCalledWith("p1", "e1", "f-1"));
  });

  it("only shows 'Xoá' for a deletable picture", async () => {
    await i18n.changeLanguage("vi");
    renderPanel();

    // f-1 is a system frame: not deletable
    fireEvent.click(await screen.findByRole("tab", { name: "Khung hình" }));
    fireEvent.click(await screen.findByRole("button", { name: "f-1" }));
    expect(screen.queryByRole("button", { name: "Xoá" })).toBeNull();

    // c-1 (composed, by a person) is deletable
    fireEvent.click(screen.getByRole("tab", { name: "Của tôi" }));
    fireEvent.click(await screen.findByRole("button", { name: "c-1" }));
    const del = await screen.findByRole("button", { name: "Xoá" });
    fireEvent.click(del);
    mockClient.deleteThumbnail.mockResolvedValue(baseList({ items: [sug, frameSystem, frameCaptured] }));
    fireEvent.click(await screen.findByRole("button", { name: "OK" }, { timeout: 5000 }));
    await waitFor(() => expect(mockClient.deleteThumbnail).toHaveBeenCalledWith("p1", "e1", "c-1"), { timeout: 5000 });
  }, 10000);

  it("debounces the live preview and offers 'Dùng làm thumbnail' after compose", async () => {
    await i18n.changeLanguage("vi");
    mockClient.previewThumbnail.mockResolvedValue({ dataUrl: "data:image/jpeg;base64,aaa" });
    mockClient.composeThumbnail.mockResolvedValue(mkThumb({ id: "c-2", kind: "composed", createdBy: "user-1", deletable: true }));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "s-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Thêm chữ" }));
    await waitFor(() => expect(mockClient.previewThumbnail).toHaveBeenCalledWith("p1", "e1", "s-1", "Hello", expect.any(Object)), { timeout: 5000 });

    const textarea = screen.getByDisplayValue("Hello");
    fireEvent.change(textarea, { target: { value: "Chu moi" } });

    // The preview only fires again ~400ms after the last edit (debounced), not on every keystroke.
    await waitFor(
      () => expect(mockClient.previewThumbnail).toHaveBeenLastCalledWith("p1", "e1", "s-1", "Chu moi", expect.any(Object)),
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(mockClient.composeThumbnail).toHaveBeenCalledWith("p1", "e1", "s-1", "Chu moi", expect.any(Object)), { timeout: 5000 });
    expect(await screen.findByText("Dùng ảnh này làm thumbnail")).toBeTruthy();
  }, 10000);

  it("hides every Canva button when the integration is disabled", async () => {
    await i18n.changeLanguage("vi");
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "s-1" }));
    expect(screen.queryByRole("button", { name: /Canva/ })).toBeNull();
  });

  it("opens Canva for the picture in use and pulls a new version back", async () => {
    await i18n.changeLanguage("vi");
    mockClient.getCanvaConnection.mockResolvedValue({ enabled: true, connected: true, displayName: "ACME" });
    mockClient.listThumbnails.mockResolvedValue(baseList({ items: [{ ...sug, inCanva: true }, frameSystem, frameCaptured, composed] }));
    mockClient.openThumbnailInCanva.mockResolvedValue({ designId: "d-1", editUrl: "https://canva.test/edit/d-1" });
    mockClient.pullCanvaThumbnail.mockResolvedValue(mkThumb({ id: "canva-1", kind: "canva", createdBy: "user-1", deletable: true, parentId: "s-1" }));
    const fakeWindow = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(fakeWindow as unknown as Window);

    renderPanel();

    const openBtn = await screen.findByRole("button", { name: /Mở trong Canva/ });
    fireEvent.click(openBtn);
    await waitFor(() => expect(mockClient.openThumbnailInCanva).toHaveBeenCalledWith("p1", "e1", "s-1"));
    expect(fakeWindow.location.href).toBe("https://canva.test/edit/d-1");

    const pullBtn = await screen.findByRole("button", { name: /Lấy bản từ Canva/ });
    fireEvent.click(pullBtn);
    await waitFor(() => expect(mockClient.pullCanvaThumbnail).toHaveBeenCalledWith("p1", "e1", "s-1"));
  });
});
