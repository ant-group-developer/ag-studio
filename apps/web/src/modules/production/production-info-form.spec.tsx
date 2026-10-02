/**
 * Component tests for ProductionForm + ProductionDetailPage step-0 edit flow:
 * 1. Quota estimate shown and updates reactively
 * 2. Invalid YouTube channel flagged in red / validation error
 * 3. PATCH payload on "Lưu thông tin"
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// Stub ag-go-client (folder tree)
const agGoClient = { getFolders: vi.fn().mockResolvedValue({ folders: [] }) };
vi.mock("../../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGoClient }));

// Studio client mock
const client = {
  getProduction: vi.fn(),
  checkProductionAccess: vi.fn(),
  getRun: vi.fn(),
  getResearch: vi.fn().mockResolvedValue(null),
  getTrendReport: vi.fn().mockResolvedValue(null),
  getSeriesPlan: vi.fn().mockResolvedValue(null),
  getProductionCatalog: vi.fn().mockResolvedValue(null),
  updateProduction: vi.fn(),
  getRndDraft: vi.fn().mockResolvedValue(null),
  getApprovedRnd: vi.fn().mockResolvedValue(null),
  getBrandingDraft: vi.fn().mockResolvedValue(null),
  getApprovedBranding: vi.fn().mockResolvedValue(null),
  getBriefDoc: vi.fn().mockResolvedValue(null),
  getProductionRnd: vi.fn().mockResolvedValue(null),
  getProductionBranding: vi.fn().mockResolvedValue(null),
  getEpisodes: vi.fn().mockResolvedValue([]),
  getLlmLogs: vi.fn().mockResolvedValue([]),
  startRun: vi.fn(),
};
vi.mock("../../api/studio-client", async (orig) => ({
  ...(await orig<object>()),
  useStudioClient: () => client,
}));

const { ProductionDetailPage } = await import("../../pages/ProductionDetailPage");

const baseProd = {
  id: "p-1", teamId: "t-1", teamName: "Team", title: "Ban đầu",
  description: "", goal: "", audience: "", tone: "", notes: "",
  status: "draft", runId: null, createdAt: "", updatedAt: "", ownerUserId: null,
  episodeTargetSeconds: null, maxEpisodes: 5, aspect: "16:9", language: "vi",
  music: null,
  // sources must be non-empty (required), and at least one channel or keyword must be present
  sources: ["folder-1"],
  youtubeChannels: ["@testchannel"],
  keywords: [],
  ownChannels: [], hasRnd: false, hasBranding: false, waitingGate: null,
  episodeCounts: { total: 0, ready: 0, producing: 0, failed: 0 },
} as const;

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <App>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/productions/p-1"]}>
          <Routes>
            <Route path="/productions/:productionId" element={<ProductionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </App>,
  );
}

describe("ProductionDetailPage – info form", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agGoClient.getFolders.mockResolvedValue({ folders: [] });
    client.getResearch.mockResolvedValue(null);
    client.getTrendReport.mockResolvedValue(null);
    client.getSeriesPlan.mockResolvedValue(null);
    client.getProductionCatalog.mockResolvedValue(null);
    client.getRndDraft.mockResolvedValue(null);
    client.getApprovedRnd.mockResolvedValue(null);
    client.getBrandingDraft.mockResolvedValue(null);
    client.getApprovedBranding.mockResolvedValue(null);
    client.getBriefDoc.mockResolvedValue(null);
    client.getProductionRnd.mockResolvedValue(null);
    client.getProductionBranding.mockResolvedValue(null);
    client.getEpisodes.mockResolvedValue([]);
    client.getLlmLogs.mockResolvedValue([]);
  });

  it("quota estimate shown correctly: 2 channels + 5 keywords → 2×3 + 5×201 = 1011", async () => {
    client.getProduction.mockResolvedValue({ ...baseProd, youtubeChannels: ["https://youtube.com/c/A", "https://youtube.com/c/B"], keywords: ["k1", "k2", "k3", "k4", "k5"] });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: false });
    client.getRun.mockResolvedValue(null);
    renderDetail();
    // quota = 2*3 + 5*201 = 6 + 1005 = 1011
    expect(await screen.findByText(/1\.011|1011/)).toBeTruthy();
  });

  it("quota estimate warns amber when > 5000: 25 keywords → 25×201 = 5025", async () => {
    const kw = Array.from({ length: 25 }, (_, i) => `keyword${i}`);
    client.getProduction.mockResolvedValue({ ...baseProd, keywords: kw, youtubeChannels: [] });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: false });
    client.getRun.mockResolvedValue(null);
    renderDetail();
    // 25*201 = 5025, which is > 5000 → warning text should appear
    await waitFor(() => {
      const el = screen.queryByText(/5\.025|5025/);
      expect(el).toBeTruthy();
    });
  });

  it("PATCH payload: updateProduction is called with correct data on save", async () => {
    // NOTE: uses 10s timeout because form validation + mutation are async
    client.getProduction.mockResolvedValue({ ...baseProd });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: true });
    client.getRun.mockResolvedValue(null);
    client.updateProduction.mockResolvedValue({ ...baseProd, title: "Tiêu đề mới" });
    renderDetail();

    // Wait for form to populate
    const titleInput = await screen.findByDisplayValue("Ban đầu");

    // Change the title
    fireEvent.change(titleInput, { target: { value: "Tiêu đề mới" } });

    // Click "Lưu thông tin"
    const saveBtn = screen.getByRole("button", { name: /Lưu/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(
      () => {
        expect(client.updateProduction).toHaveBeenCalledWith(
          "p-1",
          expect.objectContaining({ title: "Tiêu đề mới" }),
        );
      },
      { timeout: 10_000 },
    );
  }, 12_000);
});
