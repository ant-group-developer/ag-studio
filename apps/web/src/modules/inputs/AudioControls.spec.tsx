import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { StudioHttpError } from "../../api/http";
import type { ProjectAudioView, VideoAudioView } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const MB = (n: number) => n * 1024 * 1024;
const listen = (path: string) => `/api/projects/p1/files/stream?path=${encodeURIComponent(path)}&t=tok`;
// jsdom plays nothing: playing and pausing only say so
HTMLMediaElement.prototype.play = vi.fn(function play(this: HTMLMediaElement) {
  Object.defineProperty(this, "paused", { value: false, configurable: true });
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
});
HTMLMediaElement.prototype.pause = vi.fn(function pause(this: HTMLMediaElement) {
  Object.defineProperty(this, "paused", { value: true, configurable: true });
  this.dispatchEvent(new Event("pause"));
});
/** The browser read a file's length from its metadata. */
function loaded(dialog: HTMLElement, path: string, seconds: number) {
  const el = [...dialog.querySelectorAll("audio")].find((a) => a.getAttribute("src")?.endsWith(listen(path)))!;
  Object.defineProperty(el, "duration", { value: seconds, configurable: true });
  fireEvent.loadedMetadata(el);
}
const ws = {
  getAudio: vi.fn(),
  musicFromFiles: vi.fn(),
  getVideoAudio: vi.fn(),
  videoMusicFromFiles: vi.fn(),
  videoMusicFromLibrary: vi.fn(),
  clearVideoMusic: vi.fn(),
  audioFromFile: vi.fn(),
  musicFromLibrary: vi.fn(),
  declineVoice: vi.fn(),
  clearAudio: vi.fn(),
  uploadSource: vi.fn(),
};
const studio = { listMusic: vi.fn() };
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
const { AudioCard, UseAudioButtons, VideoMusicCard } = await import("./AudioControls");

const audio = (over: Partial<ProjectAudioView> = {}): ProjectAudioView => ({
  voice: null, music: null, summary: { voice: "", music: "" }, libraryTrack: null, enabled: true,
  files: [{ path: "context/audio/giong.wav", name: "giong.wav", bytes: 2 * 1024 * 1024, sourceId: "s1", addedAt: "2026-10-12T00:00:00.000Z", listenUrl: listen("context/audio/giong.wav") }],
  ...over,
});
const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AntApp>{node}</AntApp></QueryClientProvider>,
);
const card = (o: { canEdit?: boolean; canProduce?: boolean } = {}) => wrap(<AudioCard projectId="p1" canEdit={o.canEdit ?? true} canProduce={o.canProduce ?? true} />);

describe("voice and music card", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getAudio.mockResolvedValue(audio());
    ws.audioFromFile.mockResolvedValue(audio());
    ws.musicFromLibrary.mockResolvedValue(audio());
    ws.declineVoice.mockResolvedValue(audio());
    ws.clearAudio.mockResolvedValue(audio());
  });

  it("shows what is chosen for each, and declines narration or clears the voice", async () => {
    ws.getAudio.mockResolvedValue(audio({
      voice: { mode: "clone", origin: "own", duration_s: 12, source: { kind: "upload", filename: "giong.wav" } },
      music: { track: "library:music/abc.m4a", gain_db: -18, ducking: true },
      libraryTrack: { trackId: "m-sang", displayName: "Sáng sớm", moods: ["calm"], durationSeconds: 95 },
    }));
    card();
    const voice = await screen.findByRole("group", { name: "Giọng đọc" });
    expect(voice).toHaveTextContent("Giọng mẫu: giong.wav · 0:12 · Giọng của tôi");
    expect(screen.getByRole("group", { name: "Nhạc nền" })).toHaveTextContent("Kho nhạc: Sáng sớm · 1:35");
    fireEvent.click(within(voice).getByRole("button", { name: /Không lời dẫn/ }));
    await waitFor(() => expect(ws.declineVoice).toHaveBeenCalledWith("p1"));
    fireEvent.click(within(voice).getByRole("button", { name: /Bỏ chọn/ }));
    await waitFor(() => expect(ws.clearAudio).toHaveBeenCalledWith("p1", "voice"));
  });

  it("an editor uses the music buttons; the voice buttons stay disabled and say a producer is needed", async () => {
    card({ canProduce: false });
    const voice = await screen.findByRole("group", { name: "Giọng đọc" });
    expect(voice).toHaveTextContent("Chưa chọn");
    for (const name of [/Tải giọng mẫu/, /Chọn file đã tải/, /Không lời dẫn/]) expect(within(voice).getByRole("button", { name })).toBeDisabled();
    fireEvent.mouseEnter(within(voice).getByRole("button", { name: /Tải giọng mẫu/ }).parentElement!);
    expect(await screen.findByText("Cần vai producer")).toBeInTheDocument();
    const music = screen.getByRole("group", { name: "Nhạc nền" });
    expect(music).toHaveTextContent("Tự chọn theo mood");
    expect(music).toHaveTextContent("theo mood của kế hoạch dựng, rồi của branding");
    expect(within(music).getByRole("button", { name: /Tải nhạc/ })).toBeEnabled();
    expect(within(music).getByRole("button", { name: /Chọn từ kho nhạc/ })).toBeEnabled();
  });

  it("a viewer sees the choices but every button is disabled", async () => {
    card({ canEdit: false, canProduce: false });
    const music = await screen.findByRole("group", { name: "Nhạc nền" });
    for (const b of within(music).getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("without ffmpeg it says so up front, disables the file buttons and opens no dialog; the library still works", async () => {
    ws.getAudio.mockResolvedValue(audio({ enabled: false }));
    card();
    expect(await screen.findByText(/Máy Studio chưa có ffmpeg nên chưa nhận được file audio/)).toBeInTheDocument();
    const voice = screen.getByRole("group", { name: "Giọng đọc" });
    expect(within(voice).getByRole("button", { name: /Tải giọng mẫu/ })).toBeDisabled();
    expect(within(voice).getByRole("button", { name: /Chọn file đã tải/ })).toBeDisabled();
    fireEvent.click(within(voice).getByRole("button", { name: /Chọn file đã tải/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getByRole("group", { name: "Nhạc nền" })).getByRole("button", { name: /Chọn từ kho nhạc/ })).toBeEnabled();
  });

  it("a failed load shows the error and a retry, never vanishes", async () => {
    ws.getAudio.mockRejectedValueOnce(new StudioHttpError(500, { message: "Hỏng", code: "x" }));
    card();
    expect(await screen.findByRole("alert")).toHaveTextContent("Không tải được giọng đọc và nhạc nền: Hỏng");
    fireEvent.click(screen.getByRole("button", { name: /Thử lại/ }));
    expect(await screen.findByRole("group", { name: "Giọng đọc" })).toBeInTheDocument();
  });

  it("uploads a voice sample and, once its origin is given, uses it", async () => {
    ws.uploadSource.mockResolvedValue({ source: { ref: "context/audio/mau.wav" }, file: {} });
    card();
    await screen.findByRole("group", { name: "Giọng đọc" });
    fireEvent.change(screen.getByLabelText("Tải giọng mẫu", { selector: "input" }), { target: { files: [new File(["x"], "mau.wav", { type: "audio/wav" })] } });
    const dialog = await screen.findByRole("dialog", { name: "Dùng file này làm giọng đọc" });
    expect(ws.uploadSource).toHaveBeenCalledWith("p1", expect.any(File), undefined, { onProgress: expect.any(Function) });
    expect(within(dialog).getByRole("button", { name: "Giọng đọc" })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText("Giọng máy"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Giọng đọc" }));
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenCalledWith("p1", "voice", { path: "context/audio/mau.wav", origin: "synthetic", referenceText: null }));
  });

  it("uploads music and uses it at once; or picks a file already uploaded", async () => {
    ws.uploadSource.mockResolvedValue({ source: { ref: "context/audio/nhac.mp3" }, file: {} });
    card();
    await screen.findByRole("group", { name: "Nhạc nền" });
    fireEvent.change(screen.getByLabelText("Tải nhạc", { selector: "input" }), { target: { files: [new File(["x"], "nhac.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenCalledWith("p1", "music", { path: "context/audio/nhac.mp3" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Nhạc nền" })).getByRole("button", { name: /Chọn file đã tải/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" });
    expect(dialog).toHaveTextContent("2.0 MB · context/audio/giong.wav");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Chọn giong.wav" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dùng làm nhạc nền" }));
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenLastCalledWith("p1", "music", { path: "context/audio/giong.wav" }));
  });

  it("joins several uploaded files into the music: ticked in order, dragged into place with the keyboard, the total less the crossfades", async () => {
    const files = ["mot.mp3", "hai.mp3", "ba.mp3"].map((name, i) => ({
      path: `context/audio/${name}`, name, bytes: MB(1), sourceId: `s${i}`, addedAt: "2026-10-12T00:00:00.000Z", listenUrl: listen(`context/audio/${name}`),
    }));
    ws.getAudio.mockResolvedValue(audio({ files }));
    ws.musicFromFiles.mockResolvedValue(audio({ music: { track: "library:studio/projects/p1/music/x.m4a", gain_db: -18, ducking: true, duration_s: 412, parts: [{}, {}, {}], crossfade_s: 2 } }));
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Nhạc nền" })).getByRole("button", { name: /Chọn file đã tải/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" });
    expect(within(dialog).getByText(/Tích file bên trái/)).toBeInTheDocument();
    for (const n of ["mot.mp3", "hai.mp3", "ba.mp3"]) fireEvent.click(within(dialog).getByRole("checkbox", { name: `Chọn ${n}` }));
    const order = within(dialog).getByRole("list", { name: "Thứ tự phát" });
    const names = () => [...order.querySelectorAll(".ws-mpick__name")].map((e) => e.textContent);
    expect(names()).toEqual(["mot.mp3", "hai.mp3", "ba.mp3"]);
    // lengths come from each file's metadata; the total takes 2 s off for each of the two crossfades
    expect(within(dialog).getByText("3 bài · –:––")).toBeInTheDocument();
    loaded(dialog, "context/audio/mot.mp3", 151);
    loaded(dialog, "context/audio/hai.mp3", 185);
    loaded(dialog, "context/audio/ba.mp3", 160);
    expect(within(dialog).getByText("3 bài · 8:12")).toBeInTheDocument();
    expect(within(order).getAllByText("2:31")).toHaveLength(1);

    // the rows stand one under the other, 40 px apart, as a browser lays them out
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const item = this.closest(".ws-mpick__item");
      const i = item ? [...item.parentElement!.children].indexOf(item) : 0;
      return { x: 0, y: i * 40, top: i * 40, bottom: i * 40 + 36, left: 0, right: 300, width: 300, height: 36, toJSON: () => ({}) } as DOMRect;
    });
    const handle = within(order).getByRole("button", { name: "Kéo để đổi thứ tự: ba.mp3" });
    handle.focus();
    // dnd-kit listens for the moves from the next tick on: Space picks it up, two arrows up, Space drops it
    const press = async (target: Element | Document, code: string) => {
      fireEvent.keyDown(target, { key: code === "Space" ? " " : code, code });
      await act(() => new Promise((r) => setTimeout(r, 0)));
    };
    await press(handle, "Space");
    await press(document, "ArrowUp");
    await press(document, "ArrowUp");
    await press(document, "Space");
    await waitFor(() => expect(names()).toEqual(["ba.mp3", "mot.mp3", "hai.mp3"]));
    rect.mockRestore();

    fireEvent.click(within(dialog).getByRole("button", { name: "Bỏ mot.mp3" }));
    expect(names()).toEqual(["ba.mp3", "hai.mp3"]);
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Chuyển mờ giữa các bài (giây)" }), { target: { value: "3" } });
    expect(within(dialog).getByText("2 bài · 5:42")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ghép 2 bài làm nhạc nền" }));
    await waitFor(() => expect(ws.musicFromFiles).toHaveBeenCalledWith("p1", { paths: ["context/audio/ba.mp3", "context/audio/hai.mp3"], crossfadeS: 3 }));
  });

  it("listens to one file at a time, and finds files by name", async () => {
    const files = ["mot.mp3", "hai.mp3"].map((name, i) => ({
      path: `context/audio/${name}`, name, bytes: MB(1), sourceId: `s${i}`, addedAt: "2026-10-12T00:00:00.000Z", listenUrl: listen(`context/audio/${name}`),
    }));
    ws.getAudio.mockResolvedValue(audio({ files }));
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Nhạc nền" })).getByRole("button", { name: /Chọn file đã tải/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" });
    // played from the API's short link, nothing loaded but the length
    const players = [...dialog.querySelectorAll("audio")];
    expect(players.map((a) => [a.getAttribute("src")?.endsWith(listen(`context/audio/${a === players[0] ? "mot" : "hai"}.mp3`)), a.getAttribute("preload")]))
      .toEqual([[true, "metadata"], [true, "metadata"]]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Nghe thử mot.mp3" }));
    expect(await within(dialog).findByRole("button", { name: "Dừng mot.mp3" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Nghe thử hai.mp3" }));
    expect(await within(dialog).findByRole("button", { name: "Dừng hai.mp3" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Nghe thử mot.mp3" })).toHaveAttribute("aria-pressed", "false");
    expect(players[0]!.paused).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Dừng hai.mp3" }));
    expect(await within(dialog).findByRole("button", { name: "Nghe thử hai.mp3" })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tìm file…" }), { target: { value: "hai" } });
    expect(within(dialog).queryByRole("checkbox", { name: "Chọn mot.mp3" })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: "Chọn hai.mp3" })).toBeInTheDocument();
  });

  it("uploads more files from the open picker and ticks them after the others, without using any yet", async () => {
    ws.uploadSource.mockReset().mockResolvedValueOnce({ source: { ref: "context/audio/moi.mp3" }, file: {} });
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Nhạc nền" })).getByRole("button", { name: /Chọn file đã tải/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Chọn giong.wav" }));
    ws.getAudio.mockResolvedValue(audio({ files: [
      { path: "context/audio/moi.mp3", name: "moi.mp3", bytes: MB(1), sourceId: "s2", addedAt: "2026-10-13T00:00:00.000Z", listenUrl: listen("context/audio/moi.mp3") },
      ...audio().files,
    ] }));
    expect(within(dialog).getByRole("button", { name: /Tải thêm file/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tải nhạc", { selector: "input" }), { target: { files: [new File(["x"], "moi.mp3", { type: "audio/mpeg" })] } });
    const order = within(dialog).getByRole("list", { name: "Thứ tự phát" });
    await waitFor(() => expect([...order.querySelectorAll(".ws-mpick__name")].map((e) => e.textContent)).toEqual(["giong.wav", "moi.mp3"]));
    expect(ws.audioFromFile).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("checkbox", { name: "Chọn moi.mp3" })).toBeChecked();
  });

  it("uploads several files one by one, says which did not go and why, then asks which to use", async () => {
    ws.uploadSource.mockReset()
      .mockResolvedValueOnce({ source: { ref: "context/audio/a.mp3" }, file: {} })
      .mockRejectedValueOnce(new StudioHttpError(413, null))
      .mockResolvedValueOnce({ source: { ref: "context/audio/c.mp3" }, file: {} });
    card();
    await screen.findByRole("group", { name: "Nhạc nền" });
    const big = new File(["x"], "to.mp3", { type: "audio/mpeg" });
    Object.defineProperty(big, "size", { value: 101 * 1024 * 1024 });
    const files = ["a.mp3", "b.mp3", "c.mp3"].map((n) => new File(["x"], n, { type: "audio/mpeg" }));
    fireEvent.change(screen.getByLabelText("Tải nhạc", { selector: "input" }), { target: { files: [files[0], big, files[1], files[2]] } });
    expect(await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" })).toBeInTheDocument();
    expect(ws.uploadSource).toHaveBeenCalledTimes(3);
    expect(ws.audioFromFile).not.toHaveBeenCalled();
    expect(await screen.findByText("to.mp3: lớn hơn 100 MB, không tải được")).toBeInTheDocument();
    expect(screen.getByText(/b\.mp3 \(0\.0 MB\): máy chủ từ chối vì file quá lớn/)).toBeInTheDocument();
    expect(screen.getByText("Đã tải 2 file, chọn file dùng")).toBeInTheDocument();
  });

  it("picks a library track after listening, and goes back to picking by mood", async () => {
    ws.getAudio.mockResolvedValue(audio({ music: { track: "library:studio/projects/p1/music/x.m4a", gain_db: -18, ducking: true, duration_s: 61, source: { kind: "upload", filename: "rieng.mp3" } } }));
    studio.listMusic.mockResolvedValue({ tracks: [
      { trackId: "m-sang", displayName: "Sáng sớm", moods: ["calm", "ấm áp"], durationSeconds: 95, loopOk: true, origin: "own", originNote: "", active: true, track: "library:music/a.m4a", listenUrl: "https://r2.test/a.m4a" },
      { trackId: "m-cu", displayName: "Bài cũ", moods: ["sad"], durationSeconds: 30, loopOk: false, origin: "own", originNote: "", active: false, track: "library:music/b.m4a", listenUrl: "https://r2.test/b.m4a" },
    ] });
    card();
    const music = await screen.findByRole("group", { name: "Nhạc nền" });
    expect(music).toHaveTextContent("File riêng: rieng.mp3 · 1:01");
    fireEvent.click(within(music).getByRole("button", { name: /Chọn từ kho nhạc/ }));
    const dialog = await screen.findByRole("dialog", { name: "Kho nhạc" });
    expect(await within(dialog).findByText("Sáng sớm")).toBeInTheDocument();
    expect(within(dialog).queryByText("Bài cũ")).toBeNull();
    expect(within(dialog).getByLabelText("Nghe thử Sáng sớm")).toHaveAttribute("src", "https://r2.test/a.m4a");
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Tìm theo tên hoặc mood" }), { target: { value: "ấm" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Chọn Sáng sớm" }));
    await waitFor(() => expect(ws.musicFromLibrary).toHaveBeenCalledWith("p1", "m-sang"));
    fireEvent.click(within(music).getByRole("button", { name: /Tự chọn theo mood/ }));
    await waitFor(() => expect(ws.clearAudio).toHaveBeenCalledWith("p1", "music"));
  });
});

describe("buttons on an uploaded audio file", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => { vi.clearAllMocks(); ws.getAudio.mockResolvedValue(audio()); });

  it("a producer picks it as the voice, saying where it comes from", async () => {
    ws.audioFromFile.mockResolvedValue(audio());
    wrap(<UseAudioButtons projectId="p1" path="context/audio/giong.wav" canEdit canProduce />);
    fireEvent.click(await screen.findByRole("button", { name: /Giọng đọc/ }));
    const dialog = await screen.findByRole("dialog", { name: "Dùng file này làm giọng đọc" });
    fireEvent.click(within(dialog).getByLabelText("Giọng của tôi"));
    fireEvent.change(within(dialog).getByLabelText(/Lời trong file mẫu/), { target: { value: "Xin chào" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Giọng đọc" }));
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenCalledWith("p1", "voice", { path: "context/audio/giong.wav", origin: "own", referenceText: "Xin chào" }));
  });

  it("disabled while the Studio server has no ffmpeg", async () => {
    ws.getAudio.mockResolvedValue(audio({ enabled: false }));
    wrap(<UseAudioButtons projectId="p1" path="context/audio/giong.wav" canEdit canProduce />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Nhạc nền/ })).toBeDisabled());
  });
});

describe("a video's own music", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  const view = (over: Partial<VideoAudioView> = {}): VideoAudioView => ({
    music: null, uses: "project", summary: "", libraryTrack: null, enabled: true, files: audio().files, revision: null, ...over,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getAudio.mockResolvedValue(audio({ music: { track: "library:music/sang.m4a", gain_db: -18, ducking: true }, libraryTrack: { trackId: "m-sang", displayName: "Sáng sớm", moods: [], durationSeconds: 95 } }));
  });

  it("says it plays the project's music; its own joined files replace it and the timeline follows; back to the project's", async () => {
    ws.getVideoAudio.mockResolvedValue(view());
    ws.videoMusicFromFiles.mockResolvedValue(view({ uses: "video", revision: 4 }));
    ws.clearVideoMusic.mockResolvedValue(view({ revision: 5 }));
    wrap(<VideoMusicCard projectId="p1" videoId="v1" canEdit />);
    const card = await screen.findByRole("group", { name: "Nhạc của video này" });
    await waitFor(() => expect(card).toHaveTextContent("Dùng nhạc dự án · Kho nhạc: Sáng sớm"));
    expect(within(card).queryByRole("button", { name: /Dùng nhạc dự án/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Chọn file đã tải/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn file làm nhạc nền" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Chọn giong.wav" }));
    ws.getVideoAudio.mockResolvedValue(view({ uses: "video", music: { track: "library:studio/projects/p1/music/x.m4a", gain_db: -18, ducking: true, duration_s: 200, parts: [{}, {}], crossfade_s: 0 } }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dùng làm nhạc nền" }));
    await waitFor(() => expect(ws.videoMusicFromFiles).toHaveBeenCalledWith("v1", { paths: ["context/audio/giong.wav"] }));
    expect(await screen.findByText("Đã đặt nhạc cho video, timeline lên bản 4")).toBeInTheDocument();
    expect(ws.audioFromFile).not.toHaveBeenCalled();
    await waitFor(() => expect(card).toHaveTextContent("Nhạc riêng · Ghép 2 bài · 3:20 · nối thẳng"));
    fireEvent.click(within(card).getByRole("button", { name: /Dùng nhạc dự án/ }));
    await waitFor(() => expect(ws.clearVideoMusic).toHaveBeenCalledWith("v1"));
  });
});
