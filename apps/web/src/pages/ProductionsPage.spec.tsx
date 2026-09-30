import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";

// antd's Table and Select watch breakpoints; jsdom has no matchMedia
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = { listTeams: vi.fn(), listProductions: vi.fn() };
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ getAccessTokenSilently: async () => "token" }) }));

const { ProductionsPage } = await import("./ProductionsPage");

function page(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/productions" element={<ProductionsPage />} />
          <Route path="/teams/:teamId/productions" element={<ProductionsPage />} />
          <Route path="/teams" element={<div>teams page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const prod = (id: string, title: string) => ({
  id, teamId: "t-2", title, brief: null, status: "draft", canvas: null, runId: null, sources: [], createdAt: "", updatedAt: "",
  ownerUserId: null, targetSeconds: 30, aspect: "16:9", language: "vi",
});

describe("ProductionsPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });
  beforeEach(() => {
    client.listTeams.mockReset();
    client.listProductions.mockReset();
    localStorage.clear();
  });

  it("từ menu: chọn nhóm (nhớ nhóm lần trước) rồi hiện production của nhóm đó", async () => {
    localStorage.setItem("ag-studio:last-team", "t-2");
    client.listTeams.mockResolvedValue([{ id: "t-1", name: "Nhóm A", createdAt: "" }, { id: "t-2", name: "Chạy thử", createdAt: "" }]);
    client.listProductions.mockResolvedValue([prod("p-1", "Phở sáng")]);
    page("/productions");
    expect(await screen.findByText("Phở sáng")).toBeTruthy();
    expect(client.listProductions).toHaveBeenCalledWith("t-2");
    expect(screen.getByText("Chạy thử")).toBeTruthy();
  });

  it("chưa ở nhóm nào thì chỉ đường sang trang Nhóm", async () => {
    client.listTeams.mockResolvedValue([]);
    page("/productions");
    expect(await screen.findByText(/Bạn chưa ở nhóm nào/)).toBeTruthy();
    expect(client.listProductions).not.toHaveBeenCalled();
  });

  it("mở từ một nhóm thì dùng nhóm đó, không hỏi chọn nhóm", async () => {
    client.listProductions.mockResolvedValue([]);
    page("/teams/t-9/productions");
    await waitFor(() => expect(client.listProductions).toHaveBeenCalledWith("t-9"));
    expect(client.listTeams).not.toHaveBeenCalled();
  });
});
