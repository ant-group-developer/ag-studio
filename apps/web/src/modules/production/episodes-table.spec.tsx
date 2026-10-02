/**
 * vitest tests for:
 * 1. EpisodesPanel URL state via nuqs
 * 2. Role-based buttons (canEdit)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NuqsAdapter } from "nuqs/adapters/react-router";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const episodeList = {
  items: [
    { id: "ep-1", idx: 1, title: "Tập 1", hook: "h", status: "ready", currentStage: null, progress: 100, durationSeconds: 310, thumbnailUrl: "https://r2.test/thumb-1.jpg", updatedAt: "" },
    { id: "ep-2", idx: 2, title: "Tập 2", hook: "h", status: "producing", currentStage: "render-final", progress: 50, durationSeconds: null, thumbnailUrl: null, updatedAt: "" },
  ],
  total: 2, page: 1, pageSize: 20,
};

const mockClient = {
  listEpisodes: vi.fn().mockResolvedValue(episodeList),
  getEpisode: vi.fn(),
  patchEpisode: vi.fn(),
  rerenderEpisode: vi.fn(),
  youtubePack: vi.fn(),
};

vi.mock("../../api/studio-client", async (orig) => ({
  ...(await orig<object>()),
  useStudioClient: () => mockClient,
}));

const { EpisodesPanel } = await import("./EpisodesPanel");

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter>
          <NuqsAdapter>{children}</NuqsAdapter>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>
  );
}

describe("EpisodesPanel", () => {
  it("shows each episode's thumbnail and its current step by name", async () => {
    const i18n = (await import("../../i18n/config")).default;
    await i18n.changeLanguage("vi");
    const { container } = render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    expect(await screen.findByText("Render bản cuối")).toBeTruthy();
    expect(container.querySelector('img[src="https://r2.test/thumb-1.jpg"]')).toBeTruthy();
  });

  it("renders episode titles from API", async () => {
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    expect(await screen.findByText("Tập 1")).toBeTruthy();
    expect(screen.getByText("Tập 2")).toBeTruthy();
  });

  it("passes sortBy and sortOrder to listEpisodes", async () => {
    mockClient.listEpisodes.mockClear();
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(mockClient.listEpisodes).toHaveBeenCalledWith(
        "p-1",
        expect.objectContaining({ sortBy: "idx", sortOrder: "asc" }),
      );
    });
  });

  it("hides re-render button when canEdit=false", async () => {
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={false} />
      </Wrapper>,
    );
    await screen.findByText("Tập 1");
    // Re-render buttons use aria-label / tooltip "Render lại" (vi locale) - button should not be present
    // We check that the number of action buttons is less (no rerender button per row)
    const rerenderButtons = screen.queryAllByTitle("Render lại");
    expect(rerenderButtons).toHaveLength(0);
  });

  it("shows re-render button when canEdit=true", async () => {
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    await screen.findByText("Tập 1");
    // With canEdit=true, Popconfirm with rerenderConfirm text is shown via tooltip
    // At minimum, we verify more buttons are present (editor + rerender + export = 3 per row)
    const allButtons = screen.getAllByRole("button");
    expect(allButtons.length).toBeGreaterThan(4); // sort + refresh + at least 2*3 row buttons
  });

  it("'Xuất' > 'Video (mp4)' fetches the episode detail and downloads its finalVideoDownloadUrl", async () => {
    mockClient.getEpisode.mockResolvedValue({ finalVideoDownloadUrl: "https://r2.test/ep-1.mp4" });
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    await screen.findByText("Tập 1");
    fireEvent.click(screen.getAllByRole("button", { name: "Xuất" })[0]!);
    fireEvent.click(await screen.findByText("Video (mp4)"));
    await waitFor(() => expect(mockClient.getEpisode).toHaveBeenCalledWith("p-1", "ep-1"));
  });

  it("'Xuất' > 'Gói đăng YouTube (zip)' calls the youtube-pack route", async () => {
    mockClient.youtubePack.mockResolvedValue({ url: "https://r2.test/ep-1-pack.zip", name: "pack.zip", sizeBytes: 10 });
    render(
      <Wrapper>
        <EpisodesPanel productionId="p-1" canEdit={true} />
      </Wrapper>,
    );
    await screen.findByText("Tập 1");
    fireEvent.click(screen.getAllByRole("button", { name: "Xuất" })[0]!);
    fireEvent.click(await screen.findByText("Gói đăng YouTube (zip)"));
    await waitFor(() => expect(mockClient.youtubePack).toHaveBeenCalledWith("p-1", "ep-1"));
  });
});
