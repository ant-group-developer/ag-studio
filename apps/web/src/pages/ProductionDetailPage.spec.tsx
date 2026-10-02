import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  getRndDraft: vi.fn().mockResolvedValue(null),
  getBrandingDraft: vi.fn().mockResolvedValue(null),
  getBriefDoc: vi.fn().mockResolvedValue(null),
  getProductionRnd: vi.fn().mockResolvedValue(null),
  getProductionBranding: vi.fn().mockResolvedValue(null),
  getEpisodes: vi.fn().mockResolvedValue([]),
  getLlmLogs: vi.fn().mockResolvedValue([]),
  updateProduction: vi.fn(),
  startRun: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

// ProductionForm uses ag-go-client for folder tree
const agGoClient = { getFolders: vi.fn().mockResolvedValue({ folders: [] }) };
vi.mock("../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGoClient }));

const { ProductionDetailPage, runToStepIndex } = await import("./ProductionDetailPage");

const stage = (key: string, state: string) =>
  ({ key, executor: "script", state, attempts: 1, is_gate: key === "approve-plan", error: null, failed_checks: [], outputs: [], reused: false });
const runOf = (stages: [string, string][], waiting_gate: string | null = null) =>
  ({ run_id: "r-1", state: "RUNNING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate, latest_revision: null,
     stages: stages.map(([k, s]) => stage(k, s)) });

describe("runToStepIndex", () => {
  it("returns 0 for no run", () => {
    expect(runToStepIndex(null)).toBe(0);
  });

  it("returns 1 for v1 run with research in progress", () => {
    // V1 run = no rnd stage
    expect(runToStepIndex(runOf([["intake", "SUCCEEDED"], ["research", "RUNNING"], ["plan-episodes", "PENDING"]]))).toBe(1);
  });

  it("returns 4 for v1 run with plan-episodes running", () => {
    // V1 skips R&D (2) and Branding (3), jumps straight to Plan (4)
    expect(runToStepIndex(runOf([["catalog", "SUCCEEDED"], ["plan-episodes", "RUNNING"]]))).toBe(4);
  });

  it("returns 4 for v1 run waiting approve-plan gate", () => {
    expect(runToStepIndex(runOf([["plan-episodes", "SUCCEEDED"], ["approve-plan", "WAITING"]], "approve-plan"))).toBe(4);
  });

  it("returns 5 when approve-plan succeeded", () => {
    expect(runToStepIndex(runOf([["approve-plan", "SUCCEEDED"], ["spawn-episodes", "SUCCEEDED"]]))).toBe(5);
  });

  it("returns 2 for v2 run waiting approve-rnd", () => {
    expect(runToStepIndex(runOf([["rnd", "SUCCEEDED"], ["approve-rnd", "WAITING"]], "approve-rnd"))).toBe(2);
  });

  it("returns 3 for v2 run waiting approve-branding", () => {
    expect(runToStepIndex(runOf([["rnd", "SUCCEEDED"], ["approve-rnd", "SUCCEEDED"], ["branding", "RUNNING"]], "approve-branding"))).toBe(3);
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
      ownChannels: [], hasRnd: false, hasBranding: false, waitingGate: null,
      episodeCounts: { total: 3, ready: 1, producing: 1, failed: 0 },
    });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: true });
    client.getRun.mockResolvedValue({
      run_id: "r-1", state: "RUNNING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate: null, latest_revision: null,
      stages: [
        { key: "intake", executor: "agent", state: "SUCCEEDED", attempts: 1, is_gate: false, error: null, failed_checks: [], outputs: [], reused: false },
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
    expect(await screen.findByDisplayValue("Phở sáng", {}, { timeout: 15000 })).toBeTruthy();

    // Steps bar: both step 0 and step 1 titles are shown
    expect(screen.getByText("Thông tin production")).toBeTruthy();
    expect(screen.getAllByText("Nghiên cứu thị trường").length).toBeGreaterThan(0);
    // The run is read by production id
    expect(client.getRun).toHaveBeenCalledWith("p-1");

    // Only the step the run is at shows: research, not the info form
    const section = (id: string) => document.getElementById(id)!;
    await waitFor(() => expect(section("step-info").hidden).toBe(true));
    expect(section("step-research").hidden).toBe(false);

    // Picking an earlier step on the bar shows that step instead
    fireEvent.click(screen.getByText("Thông tin production"));
    expect(section("step-info").hidden).toBe(false);
    expect(section("step-research").hidden).toBe(true);
  }, 15000);
});
