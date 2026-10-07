import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const jobs = [
  { id: "j2", kind: "export_premiere", status: "completed", progress: 100, request: { media: "proxy" }, result: { warnings: ["Failed to probe music: timeout"] }, error: null, createdAt: "2026-10-01T01:00:00Z", url: "https://bucket.test/premiere.zip" },
  { id: "j1", kind: "export_premiere", status: "failed", progress: null, request: { media: "original" }, result: null, error: "hết dung lượng", createdAt: "2026-10-01T00:00:00Z" },
];
const mockClient = {
  listEditorJobs: vi.fn().mockResolvedValue(jobs),
  exportPremiere: vi.fn().mockResolvedValue({ ...jobs[0], id: "j3", status: "queued" }),
};

vi.mock("../../api/studio-client", async (orig) => ({
  ...(await orig<object>()),
  useStudioClient: () => mockClient,
}));

const { PremiereExports } = await import("./PremiereExports");

function renderCard(canEdit: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <PremiereExports productionId="p1" episodeId="e1" canEdit={canEdit} />
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("PremiereExports", () => {
  it("lists the jobs with a download link for a finished one and the error of a failed one", async () => {
    await i18n.changeLanguage("vi");
    renderCard(false);
    expect(await screen.findByText("hết dung lượng")).toBeTruthy();
    expect(mockClient.listEditorJobs).toHaveBeenCalledWith("p1", "e1", "export_premiere");
    const link = screen.getByRole("link", { name: "Tải xuống" });
    expect(link.getAttribute("href")).toBe("https://bucket.test/premiere.zip");
    // what the export could not carry over is said under it
    expect(screen.getByText("Bản xuất có cảnh báo:")).toBeTruthy();
    expect(screen.getByText("Failed to probe music: timeout")).toBeTruthy();
    // viewers cannot start an export
    expect(screen.queryByRole("button", { name: /Xuất/ })).toBeNull();
  });

  it("starts a proxy export from the menu", async () => {
    await i18n.changeLanguage("vi");
    renderCard(true);
    fireEvent.click(await screen.findByRole("button", { name: /Xuất/ }));
    fireEvent.click(await screen.findByText("Premiere (proxy 720p)"));
    await waitFor(() => expect(mockClient.exportPremiere).toHaveBeenCalledWith("p1", "e1", "proxy"));
  });
});
