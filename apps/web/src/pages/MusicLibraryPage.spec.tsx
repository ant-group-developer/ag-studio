import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { MusicTrackView } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const track = (trackId: string, displayName: string, moods: string[], active = true): MusicTrackView => ({
  trackId, displayName, moods, durationSeconds: 125, loopOk: trackId === "am-ap", origin: "royalty_free", originNote: "Pixabay", active,
  track: `library:music/${trackId}.m4a`, listenUrl: `https://bucket/${trackId}.m4a`,
});

const client = {
  getMe: vi.fn(),
  getOverview: vi.fn().mockResolvedValue({ items: [] }),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 0, waiting: 0, max: 20, source: "env" }),
  getQueue: vi.fn().mockResolvedValue({ claude: { running: 0, waiting: 0, max: 20, hidden: 0, items: [] }, renders: [], hiddenRenders: 0, farm: { ok: true } }),
  listMusic: vi.fn(),
  addMusic: vi.fn(),
  updateMusic: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));
const { MusicLibraryPage } = await import("./MusicLibraryPage");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={["/music"]}>
          <Routes><Route path="/music" element={<MusicLibraryPage />} /></Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("MusicLibraryPage", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    client.listMusic.mockResolvedValue({ tracks: [track("am-ap", "Sáng sớm", ["ấm áp", "calm"]), track("cu", "Bài cũ", ["sad"], false)] });
  });

  it("everyone listens to the tracks with their moods; only an admin gets the upload form and the buttons", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: false });
    mount();
    const row = await screen.findByRole("listitem", { name: "Sáng sớm" });
    expect(within(row).getByText("2:05 · Miễn phí bản quyền — Pixabay · lặp được")).toBeInTheDocument();
    expect(within(row).getByText("ấm áp")).toBeInTheDocument();
    expect(within(row).getByLabelText("Nghe Sáng sớm")).toHaveAttribute("src", "https://bucket/am-ap.m4a");
    expect(screen.queryByRole("button", { name: "Tải lên" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Ngừng dùng" })).toBeNull();
  });

  it("an admin retires a track, brings one back, and uploads one with its moods and origin", async () => {
    client.getMe.mockResolvedValue({ userId: "a", isAdmin: true });
    client.updateMusic.mockResolvedValue(track("am-ap", "Sáng sớm", ["calm"], false));
    client.addMusic.mockResolvedValue(track("moi", "Chợ đêm", ["upbeat"]));
    mount();
    const row = await screen.findByRole("listitem", { name: "Sáng sớm" });
    fireEvent.click(within(row).getByRole("button", { name: "Ngừng dùng" }));
    await waitFor(() => expect(client.updateMusic).toHaveBeenCalledWith("am-ap", { active: false }));
    fireEvent.click(within(screen.getByRole("listitem", { name: "Bài cũ" })).getByRole("button", { name: "Dùng lại" }));
    await waitFor(() => expect(client.updateMusic).toHaveBeenCalledWith("cu", { active: true }));

    const upload = screen.getByRole("button", { name: "Tải lên" });
    expect(upload).toBeDisabled();
    const file = new File(["RIFF"], "cho-dem.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("File nhạc"), { target: { files: [file] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Tên bài" }), { target: { value: "Chợ đêm" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ghi chú nguồn gốc" }), { target: { value: "Pixabay" } });
    const moods = screen.getAllByRole("combobox", { name: "Mood" })[0]!;
    fireEvent.change(moods, { target: { value: "upbeat" } });
    fireEvent.keyDown(moods, { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Lặp lại liền mạch" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tải lên" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Tải lên" }));
    await waitFor(() => expect(client.addMusic).toHaveBeenCalledWith({
      file, displayName: "Chợ đêm", moods: ["upbeat"], origin: "royalty_free", originNote: "Pixabay", loopOk: true,
    }));
  }, 30_000);
});
