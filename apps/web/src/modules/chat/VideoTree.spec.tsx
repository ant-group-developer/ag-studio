import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

const client = {
  getOverview: vi.fn().mockResolvedValue({
    items: [
      { id: "p1", teamId: "t", title: "Series Kyoto", updatedAt: "", step: "approve-branding", group: "waiting_you", episodes: [] },
      { id: "p2", teamId: "t", title: "Đà Lạt", updatedAt: "", step: null, group: "running", episodes: [
        { id: "e1", idx: 2, title: "Hồ Xuân Hương", status: "producing", step: "render-final", group: "running" },
      ] },
      { id: "p3", teamId: "t", title: "Huế", updatedAt: "", step: "plan-episodes", group: "needs_attention", episodes: [] },
    ],
  }),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { VideoTree } = await import("./VideoTree");

describe("VideoTree", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("lists each video with its step and what it needs, episodes under their series", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><VideoTree productionId="p2" episodeId="e1" /></MemoryRouter>
      </QueryClientProvider>,
    );
    const kyoto = await screen.findByRole("link", { name: /Series Kyoto/ });
    expect(kyoto).toHaveAttribute("href", "/v/p1");
    expect(kyoto).toHaveTextContent("Branding");
    expect(kyoto).toHaveTextContent("chờ bạn");
    const ep = screen.getByRole("link", { name: /Tập 2 · Hồ Xuân Hương/ });
    expect(ep).toHaveAttribute("href", "/v/p2/e/e1");
    expect(ep).toHaveAttribute("aria-current", "page");
    expect(ep).toHaveTextContent("Render");
    expect(screen.getByRole("link", { name: /Huế/ })).toHaveTextContent("cần xử lý");
    expect(screen.getByRole("link", { name: /Video mới/ })).toHaveAttribute("href", "/");
  });

  it("folds the episodes of a series one is not on, unless one of them waits for you; a search shows past five videos", async () => {
    const ep = (id: string, idx: number, group: "running" | "waiting_you") => ({ id, idx, title: `Tập ${id}`, status: "producing", step: "render-final", group });
    const series = (id: string, title: string, episodes: ReturnType<typeof ep>[] = []) => ({ id, teamId: "t", title, updatedAt: "", step: null, group: "running", episodes });
    client.getOverview.mockResolvedValueOnce({
      items: [
        series("a", "Đà Lạt", [ep("a1", 1, "running"), ep("a2", 2, "running")]),
        series("b", "Huế", [ep("b1", 1, "waiting_you")]),
        series("c", "Hội An"), series("d", "Sa Pa"), series("e", "Ninh Bình"), series("f", "Cần Thơ"),
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><VideoTree productionId="c" /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "2 tập" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Tập a1/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Tập b1/ })).toHaveAttribute("href", "/v/b/e/b1");
    fireEvent.click(screen.getByRole("button", { name: "Mở các tập của Đà Lạt" }));
    expect(screen.getByRole("link", { name: /Tập a2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thu gọn các tập của Đà Lạt" }));
    expect(screen.queryByRole("link", { name: /Tập a2/ })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Tìm video…" }), { target: { value: "hu" } });
    expect(screen.getByRole("link", { name: /Huế/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sa Pa/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Tìm video…" }), { target: { value: "zz" } });
    expect(screen.getByText("Không có video nào khớp.")).toBeInTheDocument();
  });
});
