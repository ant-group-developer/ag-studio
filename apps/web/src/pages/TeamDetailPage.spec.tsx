import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { TeamMember, UserSummary } from "../api/studio-client";

// antd's Table and Select watch breakpoints; jsdom has no matchMedia
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = {
  listMembers: vi.fn<(teamId: string) => Promise<TeamMember[]>>(),
  searchMemberCandidates: vi.fn<(teamId: string, keyword: string) => Promise<UserSummary[]>>(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

const { TeamDetailPage } = await import("./TeamDetailPage");

function page() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/teams/team-1"]}>
        <Routes>
          <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TeamDetailPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện tên, email của thành viên thay cho User ID; không rõ tên thì hiện id", async () => {
    client.listMembers.mockResolvedValue([
      { userId: "auth0|u-1", role: "owner", joinedAt: "2026-09-30T00:00:00Z", name: "Nguyễn An", email: "an@ant-group.net", avatar: null },
      { userId: "auth0|u-2", role: "editor", joinedAt: "2026-09-30T00:00:00Z", name: null, email: null, avatar: null },
    ]);
    page();
    expect(await screen.findByText("Nguyễn An")).toBeTruthy();
    expect(screen.getByText("an@ant-group.net")).toBeTruthy();
    expect(screen.getByText("auth0|u-2")).toBeTruthy();
    expect(screen.queryByText("auth0|u-1")).toBeNull();
  });

  it("thêm thành viên: tìm theo tên/email, danh sách có tên và email, gửi đúng user id", async () => {
    client.listMembers.mockResolvedValue([]);
    client.searchMemberCandidates.mockResolvedValue([
      { userId: "auth0|u-3", name: "Trần Bình", email: "binh@ant-group.net", avatar: null },
    ]);
    client.addMember.mockResolvedValue({});
    page();
    fireEvent.click(await screen.findByRole("button", { name: /Thêm thành viên/ }));
    const dialog = await screen.findByRole("dialog");
    const [userSelect, roleSelect] = within(dialog).getAllByRole("combobox");
    fireEvent.change(userSelect!, { target: { value: "binh" } });
    await waitFor(() => expect(client.searchMemberCandidates).toHaveBeenCalledWith("team-1", "binh"));
    fireEvent.click(await screen.findByText("binh@ant-group.net"));
    fireEvent.mouseDown(roleSelect!);
    fireEvent.click(await screen.findByText("Biên tập viên"));
    fireEvent.click(within(dialog).getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(client.addMember).toHaveBeenCalledWith("team-1", "auth0|u-3", "editor"));
  });
});
