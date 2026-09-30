import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = { getProduction: vi.fn(), checkProductionAccess: vi.fn(), getRun: vi.fn() };
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

const { ProductionDetailPage } = await import("./ProductionDetailPage");

const stage = (key: string, state: string, extra: object = {}) => ({
  key, executor: "agent", state, attempts: 1, is_gate: false, error: null, failed_checks: [], outputs: [], ...extra,
});

describe("ProductionDetailPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện nhãn đọc được kèm mã enum, source ids và trạng thái run", async () => {
    client.getProduction.mockResolvedValue({
      id: "p-1", teamId: "t-1", teamName: "Team A", title: "Phở sáng",
      description: "Phim tài liệu", goal: "", audience: "", tone: "", notes: "",
      status: "producing", runId: "r-1", createdAt: "", updatedAt: "", ownerUserId: null,
      episodeTargetSeconds: 60, maxEpisodes: 12, aspect: "9:16", language: "vi",
      music: null, sources: ["f-1", "f-gone"], youtubeChannels: [], keywords: [],
      episodeCounts: { total: 3, ready: 1, producing: 1, failed: 0 },
    });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: true });
    client.getRun.mockResolvedValue({
      run_id: "r-1", state: "WAITING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate: null, latest_revision: null,
      stages: [
        stage("intake", "SUCCEEDED"),
        stage("approve-plan", "WAITING_HUMAN", { executor: "gate", is_gate: true }),
        stage("render-episode", "FAILED", { failed_checks: [{ check_id: "selection-valid", evidence: {} }] }),
        stage("some-new-step", "PENDING"),
      ],
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/productions/p-1"]}>
          <Routes>
            <Route path="/productions/:productionId" element={<ProductionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // EnumText renders label + code side-by-side; use the code (always a leaf text node)
    expect(await screen.findByText("producing")).toBeTruthy();  // productionStatus code
    expect(screen.getByText("9:16")).toBeTruthy();              // aspect code
    expect(screen.getAllByText("vi").length).toBeGreaterThan(0); // language code

    // Source IDs shown as tags
    expect(await screen.findByText("f-1")).toBeTruthy();
    expect(screen.getByText("f-gone")).toBeTruthy();

    // Run panel: state
    expect(await screen.findByText("WAITING")).toBeTruthy();
    // code without a label is still shown as-is
    expect(screen.getByText("some-new-step")).toBeTruthy();
  });
});
