import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { StudioHttpError } from "../../api/http";
import type { ProjectAudioView } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const ws = {
  getAudio: vi.fn(),
  audioFromFile: vi.fn(),
  musicFromLibrary: vi.fn(),
  declineVoice: vi.fn(),
  clearAudio: vi.fn(),
  uploadSource: vi.fn(),
};
const studio = { listMusic: vi.fn() };
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
const { AudioCard, UseAudioButtons } = await import("./AudioControls");

const audio = (over: Partial<ProjectAudioView> = {}): ProjectAudioView => ({
  voice: null, music: null, summary: { voice: "", music: "" }, libraryTrack: null, enabled: true,
  files: [{ path: "context/audio/giong.wav", name: "giong.wav", bytes: 2 * 1024 * 1024, sourceId: "s1", addedAt: "2026-10-12T00:00:00.000Z" }],
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Chọn giong.wav" }));
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenLastCalledWith("p1", "music", { path: "context/audio/giong.wav" }));
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
