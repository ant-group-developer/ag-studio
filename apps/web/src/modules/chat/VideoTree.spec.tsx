import { render, screen } from "@testing-library/react";
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
});
