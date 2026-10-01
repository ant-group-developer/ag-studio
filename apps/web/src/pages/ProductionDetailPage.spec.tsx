import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = {
  getProduction: vi.fn(),
  checkProductionAccess: vi.fn(),
  getRun: vi.fn(),
  getResearch: vi.fn().mockResolvedValue(null),
  getTrendReport: vi.fn().mockResolvedValue(null),
  getSeriesPlan: vi.fn().mockResolvedValue(null),
  getProductionCatalog: vi.fn().mockResolvedValue(null),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

// ProductionForm uses ag-go-client for folder tree
const agGoClient = { getFolders: vi.fn().mockResolvedValue({ folders: [] }) };
vi.mock("../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGoClient }));

const { ProductionDetailPage, runToStepIndex } = await import("./ProductionDetailPage");

const stage = (key: string, state: string) =>
  ({ key, executor: "script", state, attempts: 1, is_gate: key === "approve-plan", error: null, failed_checks: [], outputs: [] });
const runOf = (stages: [string, string][], waiting_gate: string | null = null) =>
  ({ run_id: "r-1", state: "RUNNING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate, latest_revision: null,
     stages: stages.map(([k, s]) => stage(k, s)) });

describe("runToStepIndex", () => {
  it("follows the series plan run up to the approved plan", () => {
    expect(runToStepIndex(null)).toBe(0);
    expect(runToStepIndex(runOf([["intake", "SUCCEEDED"], ["research", "RUNNING"], ["plan-episodes", "PENDING"]]))).toBe(1);
    expect(runToStepIndex(runOf([["catalog", "SUCCEEDED"], ["plan-episodes", "RUNNING"]]))).toBe(2);
    expect(runToStepIndex(runOf([["plan-episodes", "SUCCEEDED"], ["approve-plan", "WAITING"]], "approve-plan"))).toBe(3);
    expect(runToStepIndex(runOf([["approve-plan", "SUCCEEDED"], ["spawn-episodes", "SUCCEEDED"]]))).toBe(4);
  });
});

describe("ProductionDetailPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện form chỉnh sửa với tiêu đề và các bước (Steps)", async () => {
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
      run_id: "r-1", state: "RUNNING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate: null, latest_revision: null,
      stages: [
        { key: "intake", executor: "agent", state: "SUCCEEDED", attempts: 1, is_gate: false, error: null, failed_checks: [], outputs: [] },
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

    // Production title is populated in the form
    expect(await screen.findByDisplayValue("Phở sáng")).toBeTruthy();

    // Steps bar: both step 0 and step 1 titles are shown (the research card repeats the second)
    expect(screen.getByText("Thông tin")).toBeTruthy();
    expect(screen.getAllByText("Nghiên cứu thị trường").length).toBeGreaterThan(0);
    // The run is read by production id (the route is /productions/:id/run), never by run id
    expect(client.getRun).toHaveBeenCalledWith("p-1");
  });
});
