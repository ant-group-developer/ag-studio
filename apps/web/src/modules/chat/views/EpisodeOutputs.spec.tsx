import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/config";
import type { EpisodeRender } from "../../../api/studio-client";

const client = { getEpisode: vi.fn() };
vi.mock("../../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { EpisodeOutputs } = await import("./EpisodeOutputs");

const NOW = new Date("2026-10-06T10:30:00.000Z");
const job = (createdAt: string) => ({ farmJobId: "f1", runId: "r", machine: "nvenc" as const, createdAt });
const episode = (r: Partial<EpisodeRender>, over: Record<string, unknown> = {}) => ({
  id: "e1", status: "producing", progress: null, finalVideoUrl: null, exportFiles: [],
  render: { machine: "nvenc", defaultMachine: "nvenc", restartFrom: null, job: null, farmStatus: null, ...r }, ...over,
});
const mount = () => render(<QueryClientProvider client={new QueryClient()}><EpisodeOutputs productionId="p" episodeId="e1" /></QueryClientProvider>);

describe("EpisodeOutputs: the final render's machine", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  afterEach(() => { vi.useRealTimers(); });

  it("rendering: on the farm, which type, how far", async () => {
    client.getEpisode.mockResolvedValue(episode({ job: job("2026-10-06T10:20:00.000Z"), farmStatus: { status: "leased", progress: 62 } }, { progress: 62 }));
    mount();
    expect(await screen.findByText("Farm · máy có NVENC · 62%")).toBeInTheDocument();
  });

  it("queued: waiting for a fitting machine, and a warning once no machine took it for 10 minutes", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    client.getEpisode.mockResolvedValue(episode({ job: job("2026-10-06T10:18:00.000Z"), farmStatus: { status: "queued", progress: null } }));
    mount();
    expect(await screen.findByText("Đang chờ máy phù hợp · 12 phút")).toBeInTheDocument();
    expect(screen.getByText(/Chưa máy nào nhận job/)).toBeInTheDocument();
  });

  it("done: says which type it was rendered on", async () => {
    client.getEpisode.mockResolvedValue(episode({ restartFrom: "render-final", job: job("2026-10-06T10:00:00.000Z") }, { status: "ready" }));
    mount();
    expect(await screen.findByText("Render trên: máy có NVENC")).toBeInTheDocument();
  });
});

describe("EpisodeOutputs: the files, shown where they can be", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const file = (kind: string, name: string) => ({ kind, name, url: `https://r2.test/${name}`, downloadUrl: `https://r2.test/${name}?dl=1`, sizeBytes: 10 });
  const youtube = {
    schema_version: "studio.youtube/v1", title: "Ninh Bình Chậm #1", alt_titles: ["Đi tàu về Ninh Bình"], description: "Ruộng lúa vàng. Đi chậm thôi.",
    chapters: [{ start_s: 0, title: "Mở đầu" }, { start_s: 70, title: "Ga Hà Nội" }], tags: ["vlog du lịch", "Ninh Bình"], hashtags: ["#ninhbinh"], playlist: null,
  };
  const timeline = {
    schema_version: "studio.timeline/v3", production_id: "p", episode_id: "e1", canvas: { width: 1920, height: 1080 }, fps: 30, language: "vi",
    clips: [{ clip_id: "C001", asset_id: "a", section_title: "Lên tàu" }], texts: [], music: null, source_audio: { muted: false },
    assets: { a: { title: "Cánh đồng lúa qua cửa sổ", summary_vi: "", duration_s: 12, orientation: "landscape" } }, alternates: [],
  };

  it("thumbnails as pictures, the YouTube pack and the timeline read in place, each still downloadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url.endsWith("youtube.json") ? youtube : timeline) })));
    client.getEpisode.mockResolvedValue(episode({}, {
      status: "ready", finalVideoUrl: "https://r2.test/final.mp4",
      exportFiles: [file("mp4", "tap-1.mp4"), file("thumbnail", "suggestion-1.jpg"), file("thumbnail", "suggestion-2.jpg"), file("youtube", "youtube.json"), file("timeline", "timeline.json")],
    }));
    mount();
    const pics = await screen.findAllByRole("img", { name: /suggestion-/ });
    expect(pics.map((i) => i.getAttribute("src"))).toEqual(["https://r2.test/suggestion-1.jpg", "https://r2.test/suggestion-2.jpg"]);
    expect(await screen.findByText("Ninh Bình Chậm #1")).toBeInTheDocument();
    expect(screen.getByText("Đi tàu về Ninh Bình")).toBeInTheDocument();
    expect(screen.getByText("1:10 Ga Hà Nội")).toBeInTheDocument();
    expect(screen.getByText("vlog du lịch")).toBeInTheDocument();
    expect(screen.getByText("#ninhbinh")).toBeInTheDocument();
    fireEvent.click(await screen.findByText(/Timeline đã render/));
    expect(await screen.findByText("Cánh đồng lúa qua cửa sổ")).toBeInTheDocument();
    const downloads = screen.getAllByRole("link", { name: /Tải về/ }).map((a) => a.getAttribute("href"));
    expect(downloads).toEqual(expect.arrayContaining(["https://r2.test/tap-1.mp4?dl=1", "https://r2.test/youtube.json?dl=1", "https://r2.test/timeline.json?dl=1", "https://r2.test/suggestion-1.jpg?dl=1"]));
  });

  it("a file that cannot be read in place is still a download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    client.getEpisode.mockResolvedValue(episode({}, { status: "ready", exportFiles: [file("youtube", "youtube.json")] }));
    mount();
    expect(await screen.findByText("Không mở được file này ở đây.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Tải về/ }).getAttribute("href")).toBe("https://r2.test/youtube.json?dl=1");
  });
});
