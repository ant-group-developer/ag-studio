import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { RenderView, TeamRoleName } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const done = new Date().toISOString();
const r = (over: Partial<RenderView>): RenderView => ({
  jobId: "j1", kind: "render_preview", revision: 3, durationS: 65, width: 1920, height: 1080, watermarked: true, sizeBytes: 12_582_912, note: "",
  finishedAt: done, url: "https://r2.test/a.mp4", ...over,
});
const ws = {
  getTimeline: vi.fn(),
  listRenders: vi.fn(),
  startRender: vi.fn().mockResolvedValue({}),
  fitTimeline: vi.fn().mockResolvedValue({}),
  cancelJob: vi.fn(),
  getAudio: vi.fn(),
  audioFromFile: vi.fn(),
  declineVoice: vi.fn(),
  clearAudio: vi.fn(),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
const { VideoPanel } = await import("./VideoPanel");
const { AudioSummary, UseAudioButtons } = await import("../inputs/AudioControls");

const ORDER: TeamRoleName[] = ["viewer", "editor", "producer", "owner"];
const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AntApp>{node}</AntApp></QueryClientProvider>,
);

describe("video preview tab", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getTimeline.mockResolvedValue({ latest: { revision: 3, label: "fit", approx_seconds: 64.6, clips: [{}, {}], texts: [], narration: { voice: "tts", lines: [{ line_id: "L001", text: "x" }] }, music: null, issues: [] }, revisions: [] });
    ws.listRenders.mockResolvedValue({ renders: [r({}), r({ jobId: "j2", kind: "export_premiere", durationS: null, url: null, urlHidden: "footage_scope" })], jobs: [] });
  });

  it("shows the timeline in short, plays the latest preview and lists renders (a hidden link says why)", async () => {
    wrap(<VideoPanel videoId="v1" atLeast={(n) => ORDER.indexOf("editor") >= ORDER.indexOf(n)} />);
    expect(await screen.findByText("bản 3 · fit · 2 clip · ≈ 1:05 · 1 câu lời dẫn")).toBeInTheDocument();
    expect(screen.getByLabelText("Trình phát bản render")).toHaveAttribute("src", "https://r2.test/a.mp4");
    const list = screen.getByRole("region", { name: "Bản render" });
    expect(list).toHaveTextContent("bản 3 · 1:05 · 12.0 MB · có watermark");
    expect(list).toHaveTextContent("bạn chưa có quyền xem footage này trên ag-go");
    expect(within(list).queryByRole("button", { name: /Render bản cuối/ })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Render xem trước/ }));
    await waitFor(() => expect(ws.startRender).toHaveBeenCalledWith("v1", { kind: "render_preview" }));
    fireEvent.click(screen.getByRole("button", { name: /Dựng lại từ kế hoạch/ }));
    await waitFor(() => expect(ws.fitTimeline).toHaveBeenCalledWith("v1"));
  });

  it("a producer renders the final after confirming", async () => {
    wrap(<VideoPanel videoId="v1" atLeast={(n) => ORDER.indexOf("producer") >= ORDER.indexOf(n)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Render bản cuối/ }));
    const ok = await screen.findAllByRole("button", { name: "Render bản cuối" });
    fireEvent.click(ok[ok.length - 1]!);
    await waitFor(() => expect(ws.startRender).toHaveBeenCalledWith("v1", { kind: "render_final" }));
  });
});

describe("project audio", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  it("a producer picks an uploaded file as the voice, saying where it comes from", async () => {
    ws.audioFromFile.mockResolvedValue({});
    wrap(<UseAudioButtons projectId="p1" path="context/audio/giong.wav" canEdit canProduce />);
    fireEvent.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    const dialog = await screen.findByRole("dialog", { name: "Dùng file này làm giọng đọc" });
    fireEvent.click(within(dialog).getByLabelText("Giọng của tôi"));
    fireEvent.change(within(dialog).getByLabelText(/Lời trong file mẫu/), { target: { value: "Xin chào" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Giọng đọc" }));
    await waitFor(() => expect(ws.audioFromFile).toHaveBeenCalledWith("p1", "voice", { path: "context/audio/giong.wav", origin: "own", referenceText: "Xin chào" }));
  });

  it("shows what is chosen and declines narration", async () => {
    ws.getAudio.mockResolvedValue({ voice: null, music: null, summary: { voice: "chưa chọn", music: "chưa chọn nhạc" } });
    ws.declineVoice.mockResolvedValue({});
    wrap(<AudioSummary projectId="p1" canProduce />);
    expect(await screen.findByText("chưa chọn nhạc")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Không lời dẫn" }));
    await waitFor(() => expect(ws.declineVoice).toHaveBeenCalledWith("p1"));
  });
});
