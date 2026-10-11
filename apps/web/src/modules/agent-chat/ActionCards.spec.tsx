import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { StudioHttpError } from "../../api/http";
import type { ActionView, TeamRoleName } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const card = (over: Partial<ActionView>): ActionView => ({
  id: "a1", projectId: "p1", videoId: "v1", threadId: "t1", messageId: "m1", kind: "render_final", title: "Render bản cuối 1080p",
  summary: "Bản xem trước đã **ổn**.", params: { video_id: "v1", revision: 3 }, revision: 3, status: "proposed", needs: "producer",
  decidedBy: null, decidedAt: null, jobId: null, error: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_000_000).toISOString(), ...over,
});
const ws = {
  listActions: vi.fn(),
  confirmAction: vi.fn().mockResolvedValue({}),
  rejectAction: vi.fn().mockResolvedValue({}),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
const { ActionCards } = await import("./ActionCards");

const ORDER: TeamRoleName[] = ["viewer", "editor", "producer", "owner"];
function mount(role: TeamRoleName) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><ActionCards projectId="p1" threadId="t1" canDecide={(n) => ORDER.indexOf(role) >= ORDER.indexOf(n)} /></AntApp>
    </QueryClientProvider>,
  );
}

describe("confirmation cards", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.listActions.mockResolvedValue({ actions: [card({}), card({ id: "a0", status: "confirmed", title: "Đã xong" })] });
  });

  it("shows what the agent proposes and why, the role it needs; a producer confirms", async () => {
    mount("producer");
    const c = await screen.findByRole("group", { name: "Render bản cuối 1080p" });
    expect(c).toHaveTextContent("Bản xem trước đã ổn.");
    expect(c).toHaveTextContent("timeline bản 3 · cần Nhà sản xuất");
    expect(screen.queryByText("Đã xong")).toBeNull();
    fireEvent.click(within(c).getByRole("button", { name: "Xác nhận" }));
    await waitFor(() => expect(ws.confirmAction).toHaveBeenCalledWith("p1", "a1"));
  });

  it("an editor cannot confirm a final render but can reject it", async () => {
    mount("editor");
    const c = await screen.findByRole("group", { name: "Render bản cuối 1080p" });
    expect(within(c).getByRole("button", { name: "Xác nhận" })).toBeDisabled();
    fireEvent.click(within(c).getByRole("button", { name: "Từ chối" }));
    await waitFor(() => expect(ws.rejectAction).toHaveBeenCalledWith("p1", "a1"));
  });

  it("says when the card expired", async () => {
    ws.confirmAction.mockRejectedValueOnce(new StudioHttpError(422, { message: "x", code: "expired" }));
    mount("owner");
    fireEvent.click(within(await screen.findByRole("group", { name: "Render bản cuối 1080p" })).getByRole("button", { name: "Xác nhận" }));
    expect(await screen.findByText(/Thẻ đã hết hiệu lực/)).toBeInTheDocument();
  });
});
