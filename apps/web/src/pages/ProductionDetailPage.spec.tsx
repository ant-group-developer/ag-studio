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
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ getAccessTokenSilently: async () => "token" }) }));
vi.mock("../api/ag-go-client", () => ({
  getFolders: async () => ({ folders: [{ id: "f-1", name: "Phở Hà Nội", parentId: null, usableSegments: 12 }] }),
}));

const { ProductionDetailPage } = await import("./ProductionDetailPage");

const stage = (key: string, state: string, extra: object = {}) => ({
  key, executor: "agent", state, attempts: 1, is_gate: false, error: null, failed_checks: [], outputs: [], ...extra,
});

describe("ProductionDetailPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện nhãn đọc được kèm mã enum, và tên thư mục nguồn thay cho id", async () => {
    client.getProduction.mockResolvedValue({
      id: "p-1", teamId: "t-1", title: "Phở sáng", brief: null, status: "in_progress", canvas: null, runId: "r-1",
      sources: ["f-1", "f-gone"], createdAt: "", updatedAt: "", ownerUserId: null, targetSeconds: 60, aspect: "9:16",
      language: "vi", voice: { reference: null, referenceText: null, speed: 1 }, music: null,
    });
    client.checkProductionAccess.mockResolvedValue({ hasAccess: true });
    client.getRun.mockResolvedValue({
      run_id: "r-1", state: "WAITING", created_at: "", updated_at: "", cost_usd: 0, waiting_gate: null, latest_revision: null,
      stages: [
        stage("intake", "SUCCEEDED"),
        stage("approve-treatment", "WAITING_HUMAN", { executor: "gate", is_gate: true }),
        stage("select-shots", "FAILED", { failed_checks: [{ check_id: "selection-valid", evidence: {} }] }),
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

    const status = await screen.findByText("Đang sản xuất");
    expect(within(status).getByText("in_progress")).toBeTruthy();
    expect(within(screen.getByText("Dọc")).getByText("9:16")).toBeTruthy();
    expect(within(screen.getByText("Tiếng Việt")).getByText("vi")).toBeTruthy();
    expect(await screen.findByText("Phở Hà Nội")).toBeTruthy();
    expect(screen.getByText("f-gone")).toBeTruthy();

    expect(within(await screen.findByText("Đang chờ")).getByText("WAITING")).toBeTruthy();
    expect(within(screen.getByText("Duyệt treatment")).getByText("approve-treatment")).toBeTruthy();
    expect(within(screen.getByText("Chờ người duyệt")).getByText("WAITING_HUMAN")).toBeTruthy();
    expect(screen.getByText("Cần người duyệt")).toBeTruthy();
    expect(within(screen.getByText("Danh sách cảnh hợp lệ")).getByText("selection-valid")).toBeTruthy();
    // a code without a label is still shown as is
    expect(screen.getByText("some-new-step")).toBeTruthy();
  });
});
