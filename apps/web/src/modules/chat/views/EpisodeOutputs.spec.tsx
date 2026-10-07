import { render, screen } from "@testing-library/react";
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
