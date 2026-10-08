import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { App } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import i18n from "../i18n/config";

// antd's Table and Select watch breakpoints; jsdom has no matchMedia
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// v3: listTeamProductions replaces listProductions for per-team queries
const client = { listTeams: vi.fn(), listTeamProductions: vi.fn(), createProduction: vi.fn() };
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

const agGoClient = { getFolders: vi.fn() };
vi.mock("../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGoClient }));

const { ProductionsPage } = await import("./ProductionsPage");

function page(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <App>
      <NuqsTestingAdapter>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/productions" element={<ProductionsPage />} />
              <Route path="/teams/:teamId/productions" element={<ProductionsPage />} />
              <Route path="/teams" element={<div>teams page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </NuqsTestingAdapter>
    </App>,
  );
}

// The drawer's antd fields are slow in jsdom, more so when the whole suite runs at once
const SLOW = { timeout: 10_000 };

/** Not hidden by any ancestor: a validation message under `display: none` reads as a dead button. */
function shown(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.style.display === "none") return false;
  }
  return true;
}

/** Opens the create drawer and fills what every production needs: title, one source folder, aspect. */
async function openAndFillRequired() {
  fireEvent.click(await screen.findByRole("button", { name: "Tạo production mới" }, SLOW));
  const drawer = await screen.findByRole("dialog", undefined, SLOW);
  fireEvent.change(within(drawer).getByLabelText("Tiêu đề"), { target: { value: "Phở sáng" } });

  fireEvent.mouseDown(within(drawer).getByLabelText("Chọn thư mục nguồn"));
  fireEvent.click(await screen.findByText("Phở (3)", undefined, SLOW));

  fireEvent.mouseDown(within(drawer).getByLabelText("Tỉ lệ khung hình"));
  const aspect = await screen.findAllByText("16:9");
  fireEvent.click(aspect[aspect.length - 1]);
  return drawer;
}

function addTag(drawer: HTMLElement, label: string, value: string) {
  const input = within(drawer).getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
}

function paged<T>(items: T[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const prod = (id: string, title: string) => ({
  id, teamId: "t-2", teamName: "Nhóm A", title,
  description: "", goal: "", audience: "", tone: "", notes: "",
  status: "draft" as const, runId: null, sources: [], createdAt: "", updatedAt: "",
  ownerUserId: null, episodeTargetSeconds: 30, maxEpisodes: 12, aspect: "16:9" as const, language: "vi",
  music: null, youtubeChannels: [], keywords: [],
  episodeCounts: { total: 0, ready: 0, producing: 0, failed: 0 },
});

describe("ProductionsPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });
  beforeEach(() => {
    client.listTeams.mockReset();
    client.listTeamProductions.mockReset();
    client.createProduction.mockReset();
    agGoClient.getFolders.mockResolvedValue({ folders: [{ id: "f-1", name: "Phở", parentId: null, usableVideos: 3 }] });
    localStorage.clear();
  });

  // Driving antd's TreeSelect and Select in jsdom takes several seconds
  describe("tạo production", { timeout: 30_000 }, () => {
    it("thiếu kênh lẫn từ khóa thì nói ra trong drawer, không im lặng", async () => {
      client.listTeamProductions.mockResolvedValue(paged([]));
      page("/teams/t-9/productions");
      const drawer = await openAndFillRequired();

      fireEvent.click(within(drawer).getByRole("button", { name: /^Tạo$/ }));

      const error = await within(drawer).findByText(/Cần ít nhất một kênh/, undefined, SLOW);
      expect(shown(error)).toBe(true);
      expect(client.createProduction).not.toHaveBeenCalled();
    });

    it("gửi cả kênh của nhóm, đóng drawer khi tạo xong", async () => {
      client.listTeamProductions.mockResolvedValue(paged([]));
      client.createProduction.mockResolvedValue(prod("p-new", "Phở sáng"));
      page("/teams/t-9/productions");
      const drawer = await openAndFillRequired();
      addTag(drawer, "Kênh YouTube của nhóm", "@pho");

      fireEvent.click(within(drawer).getByRole("button", { name: /^Tạo$/ }));

      await waitFor(
        () =>
          expect(client.createProduction).toHaveBeenCalledWith(
            "t-9",
            expect.objectContaining({ title: "Phở sáng", sources: ["f-1"], aspect: "16:9", ownChannels: ["@pho"] }),
          ),
        SLOW,
      );
      await waitFor(() => expect(screen.queryByText("Tạo production mới", { selector: ".ant-drawer-title" })).toBeNull(), SLOW);
    });

    it("server từ chối thì báo lỗi và giữ drawer mở", async () => {
      client.listTeamProductions.mockResolvedValue(paged([]));
      client.createProduction.mockRejectedValue(new Error("Thư mục nguồn không thuộc nhóm"));
      page("/teams/t-9/productions");
      const drawer = await openAndFillRequired();
      addTag(drawer, "Từ khóa (phân cách bằng dấu phẩy)", "phở");

      fireEvent.click(within(drawer).getByRole("button", { name: /^Tạo$/ }));

      expect(await screen.findByText("Thư mục nguồn không thuộc nhóm", undefined, SLOW)).toBeTruthy();
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
  });

  it("từ menu: chọn nhóm (nhớ nhóm lần trước) rồi hiện production của nhóm đó", async () => {
    localStorage.setItem("ag-studio:last-team", "t-2");
    client.listTeams.mockResolvedValue(paged([{ id: "t-1", name: "Nhóm A", role: null, memberCount: 1, productionCount: 0, createdAt: "" }, { id: "t-2", name: "Chạy thử", role: null, memberCount: 1, productionCount: 1, createdAt: "" }]));
    client.listTeamProductions.mockResolvedValue(paged([prod("p-1", "Phở sáng")]));
    page("/productions");
    expect(await screen.findByText("Phở sáng")).toBeTruthy();
    expect(client.listTeamProductions).toHaveBeenCalledWith("t-2", expect.any(Object));
    expect(screen.getByText("Chạy thử")).toBeTruthy();
  });

  it("chưa ở nhóm nào thì chỉ đường sang trang Nhóm", async () => {
    client.listTeams.mockResolvedValue(paged([]));
    page("/productions");
    expect(await screen.findByText(/Bạn chưa ở nhóm nào/)).toBeTruthy();
    expect(client.listTeamProductions).not.toHaveBeenCalled();
  });

  it("mở từ một nhóm thì dùng nhóm đó, không hỏi chọn nhóm", async () => {
    client.listTeamProductions.mockResolvedValue(paged([]));
    page("/teams/t-9/productions");
    await waitFor(() => expect(client.listTeamProductions).toHaveBeenCalledWith("t-9", expect.any(Object)));
    expect(client.listTeams).not.toHaveBeenCalled();
  });

  it("URL state: nuqs params (page, sortBy, sortOrder, pageSize) được truyền vào API", async () => {
    // This test verifies that the URL-state-driven paging params are wired to the API call.
    // With NuqsTestingAdapter, hooks return their declared defaults on first render.
    client.listTeamProductions.mockResolvedValue(paged([prod("p-x", "Test")]));
    page("/teams/t-7/productions");
    await waitFor(() =>
      expect(client.listTeamProductions).toHaveBeenCalledWith(
        "t-7",
        expect.objectContaining({
          page: 1,           // default from parseAsInteger.withDefault(1)
          pageSize: 20,
          sortBy: "title",   // default
          sortOrder: "asc",  // default
        }),
      ),
    );
  });
});
