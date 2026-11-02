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
  thumbnailUrl: null, mediaId: null, peaks: [0.1, 0.9, 0.5, 0.3], downloadCount: 1234, ...over,
});
const ws = {
  agMusicStatus: vi.fn(),
  listAgMusicTracks: vi.fn(),
  agMusicFacets: vi.fn(),
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
  fireEvent.click(await screen.findByRole("button", { name: /Chọn từ AG Music/ }));
  return (await screen.findByText("Chọn nhạc từ AG Music", { selector: ".ws-mlib__title" })).closest<HTMLElement>(".ant-drawer-content")!;
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
    ws.agMusicFacets.mockResolvedValue({
      categories: { GENRE: [{ id: 1, name: "Lofi", count: 2 }, { id: 2, name: "Jazz", count: 0 }] }, artists: [{ id: 3, name: "Hà An", count: 2 }],
      instrumental: { true: 1, false: 1 }, voiceGenders: {}, releaseStatuses: {}, origins: {}, purposes: { SHORT: 1 },
    });
    ws.listAgMusicTracks.mockResolvedValue({ items: [track({}), track({ trackId: 8, code: null, type: "ASSET", name: "Gió đồng", mediaId: "m-8" })], total: 2, page: 0, size: 20 });
  });

  it("lists approved tracks by type and name, and copies a picked one into the library, ticked to add", async () => {
    ws.fetchFromAgMusic.mockResolvedValue({ id: "m-7", kind: "audio", name: "Mưa chiều.mp3", bytes: 5, createdAt: "", usedIn: [], previewUrl: "https://r2.test/7", origin: { system: "ag-music", trackId: 7 } });
    mount();
    const picker = await openPicker();
    expect(await within(picker).findByText("Mưa chiều")).toBeInTheDocument();
    expect(picker).toHaveTextContent("Bài hát · Hà An · Lofi · 92 BPM");
    // its length, its downloads and its waveform, as on ag-music
    expect(picker).toHaveTextContent("3:05");
    expect(picker).toHaveTextContent("1,234");
    expect(within(picker).getByRole("button", { name: "Nghe Mưa chiều từ chỗ này" })).toBeInTheDocument();
    // already fetched: said so, no button
    expect(picker).toHaveTextContent("Đã có trong thư viện");
    expect(within(picker).queryByRole("button", { name: "Thêm Gió đồng vào thư viện" })).toBeNull();

    fireEvent.click(within(picker).getByText("Kho nhạc giấy phép"));
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ type: "ASSET", page: 0, size: 20 }));
    fireEvent.change(within(picker).getByRole("searchbox", { name: "Tìm theo tên hoặc mã bài" }), { target: { value: "mưa" } });
    // asked once typing pauses, not on the key itself
    expect(ws.listAgMusicTracks).not.toHaveBeenLastCalledWith({ q: "mưa", type: "ASSET", page: 0, size: 20 });
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ q: "mưa", type: "ASSET", page: 0, size: 20 }));

    fireEvent.click(await within(picker).findByRole("button", { name: "Thêm Mưa chiều vào thư viện" }));
    await waitFor(() => expect(ws.fetchFromAgMusic).toHaveBeenCalledWith(7));
    await waitFor(() => expect(within(picker).queryByRole("button", { name: "Thêm Mưa chiều vào thư viện" })).toBeNull());
    // the drawer has it picked: one file to add to the project
    expect(screen.getAllByRole("button", { name: "Thêm 1 file vào dự án" })[0]).toBeEnabled();
  });

  it("filters as ag-music's sidebar does, with its counts, and sorts", async () => {
    mount();
    const picker = await openPicker();
    await within(picker).findByText("Mưa chiều");
    const genres = await within(picker).findByRole("group", { name: "Thể loại" });
    // a genre with no track left is not offered
    expect(within(genres).queryByText("Jazz")).toBeNull();
    fireEvent.click(within(genres).getByText("Lofi"));
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ categoryIds: [1], page: 0, size: 20 }));
    expect(ws.agMusicFacets).toHaveBeenLastCalledWith({ categoryIds: [1] });
    fireEvent.click(within(await within(picker).findByRole("group", { name: "Lời" })).getByText("Không lời"));
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ categoryIds: [1], instrumental: true, page: 0, size: 20 }));
    fireEvent.mouseDown(within(picker).getByRole("combobox", { name: "Sắp xếp" }));
    fireEvent.click(await screen.findByText("Tải nhiều nhất"));
    await waitFor(() => expect(ws.listAgMusicTracks).toHaveBeenLastCalledWith({ categoryIds: [1], instrumental: true, sort: "MOST_DOWNLOADED", page: 0, size: 20 }));
  });

  it("shows in My library the genre, theme... of a track from AG Music, and plays one sound at a time", async () => {
    const audio = (id: string, origin: object | null) => ({ id, kind: "audio", name: `${id}.mp3`, bytes: 2048, createdAt: id, usedIn: [], previewUrl: `https://r2.test/${id}`, origin });
    ws.listMedia.mockResolvedValue({ items: [
      audio("b", { system: "ag-music", trackId: 7, type: "ASSET", artists: ["Hà An"], bpm: 92,
        categories: [{ kind: "MOOD", name: "Chill" }, { kind: "GENRE", name: "Lofi" }, { kind: "THEME", name: "Mưa" }] }),
      audio("a", null),
    ], total: 2, bytes: 4096 });
    mount();
    const row = (await screen.findByText("b.mp3")).closest("li")!;
    expect(row).toHaveTextContent("AG Music · Kho nhạc giấy phép");
    expect(row).toHaveTextContent("Hà An · 92 BPM · 2 KB");
    // genre first, as ag-music's sidebar
    expect([...row.querySelectorAll(".ws-mrow__tag")].map((e) => e.textContent)).toEqual(["Lofi", "Mưa", "Chill"]);
    expect(within(row).getByText("Lofi")).toHaveAttribute("title", "Thể loại: Lofi");

    const [first, second] = [...document.querySelectorAll<HTMLAudioElement>(".ws-mrow__audio")];
    Object.defineProperty(first!, "paused", { value: false, configurable: true });
    const pause = vi.spyOn(first!, "pause").mockImplementation(() => {});
    fireEvent.play(second!);
    expect(pause).toHaveBeenCalledOnce();
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

  it("says in the page's language why a track cannot be copied", async () => {
    ws.fetchFromAgMusic.mockRejectedValue(new StudioHttpError(422, { code: "track_copyright_violation", message: "tiếng Việt từ API" }));
    mount();
    const picker = await openPicker();
    fireEvent.click(await within(picker).findByRole("button", { name: "Thêm Mưa chiều vào thư viện" }));
    expect(await screen.findByText("Bài vi phạm bản quyền, không dùng được.")).toBeInTheDocument();
  });

  it("offers ag-music only for audio, and only when Studio is wired to it", async () => {
    ws.agMusicStatus.mockResolvedValue({ enabled: false });
    mount();
    await waitFor(() => expect(ws.agMusicStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Chọn từ AG Music/ })).toBeNull();
  });
});
