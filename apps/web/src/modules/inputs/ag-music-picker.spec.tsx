import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { StudioHttpError } from "../../api/http";
import type { AgMusicTrack } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const track = (over: Partial<AgMusicTrack>): AgMusicTrack => ({
  trackId: 7, code: "S-7", type: "SONG", name: "Mưa chiều", artists: ["Hà An"], categories: ["Lofi"], durationMs: 185_000, bpm: 92,
  thumbnailUrl: null, mediaId: null, ...over,
});
const ws = {
  agMusicStatus: vi.fn(),
  listAgMusicTracks: vi.fn(),
  agMusicListen: vi.fn(),
  fetchFromAgMusic: vi.fn(),
  listMedia: vi.fn(),
  addFromMedia: vi.fn(),
  uploadMedia: vi.fn(),
  deleteMedia: vi.fn(),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));

const { MediaLibraryDrawer } = await import("./media-library");

/** The picker's dialog (antd gives the drawer and the modal inside it the same label id in tests). */
async function openPicker(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: /Từ ag-music/ }));
  return (await screen.findByText("Chọn nhạc từ ag-music")).closest<HTMLElement>(".ant-modal-content")!;
}

function mount(use: "audio" | "footage" = "audio") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MediaLibraryDrawer open projectId="p1" use={use} videos={[]} inProject={new Set()} onClose={() => {}} />
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("music from ag-music in My library", { timeout: 30_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.agMusicStatus.mockResolvedValue({ enabled: true });
    ws.listMedia.mockResolvedValue({ items: [], total: 0, bytes: 0 });
    ws.listAgMusicTracks.mockResolvedValue({ items: [track({}), track({ trackId: 8, code: null, type: "ASSET", name: "Gió đồng", mediaId: "m-8" })], total: 2, page: 0, size: 20 });
  });

  it("lists approved tracks by type and name, and copies a picked one into the library, ticked to add", async () => {
    ws.fetchFromAgMusic.mockResolvedValue({ id: "m-7", kind: "audio", name: "Mưa chiều.mp3", bytes: 5, createdAt: "", usedIn: [], previewUrl: "https://r2.test/7", origin: { system: "ag-music", trackId: 7 } });
    mount();
    const picker = await openPicker();
    expect(await within(picker).findByText("Mưa chiều")).toBeInTheDocument();
    expect(picker).toHaveTextContent("Bài chính · Hà An · Lofi · 3:05 · 92 BPM");
    // already fetched: said so, no button
    expect(picker).toHaveTextContent("Đã có trong thư viện");
    expect(within(picker).queryByRole("button", { name: "Thêm Gió đồng vào thư viện" })).toBeNull();

    fireEvent.click(within(picker).getByText("Nhạc asset"));
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ type: "ASSET", page: 0, size: 20 }));
    fireEvent.change(within(picker).getByRole("searchbox", { name: "Tìm theo tên hoặc mã bài" }), { target: { value: "mưa" } });
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ q: "mưa", type: "ASSET", page: 0, size: 20 }));

    fireEvent.click(within(picker).getByRole("button", { name: "Thêm Mưa chiều vào thư viện" }));
    await waitFor(() => expect(ws.fetchFromAgMusic).toHaveBeenCalledWith(7));
    await waitFor(() => expect(within(picker).queryByRole("button", { name: "Thêm Mưa chiều vào thư viện" })).toBeNull());
    // the drawer has it picked: one file to add to the project
    expect(screen.getAllByRole("button", { name: "Thêm 1 file vào dự án" })[0]).toBeEnabled();
  });

  it("asks for a link to listen only when played", async () => {
    ws.agMusicListen.mockResolvedValue({ url: "https://storage.test/listen-7", expiresAt: "x" });
    mount();
    const picker = await openPicker();
    fireEvent.click(await within(picker).findByRole("button", { name: "Nghe thử Mưa chiều" }));
    await waitFor(() => expect(ws.agMusicListen).toHaveBeenCalledWith(7));
    await waitFor(() => expect(document.querySelector('audio[src="https://storage.test/listen-7"]')).not.toBeNull());
  });

  it("says when the person cannot see ag-music's tracks", async () => {
    ws.listAgMusicTracks.mockRejectedValue(new StudioHttpError(403, { code: "ag_music_forbidden", message: "x" }));
    mount();
    await openPicker();
    expect(await screen.findByText(/Bạn chưa có quyền xem bài hát ở ag-music/)).toBeInTheDocument();
  });

  it("offers ag-music only for audio, and only when Studio is wired to it", async () => {
    ws.agMusicStatus.mockResolvedValue({ enabled: false });
    mount();
    await waitFor(() => expect(ws.agMusicStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Từ ag-music/ })).toBeNull();
  });
});
