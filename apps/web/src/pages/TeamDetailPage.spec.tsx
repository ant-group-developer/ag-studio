import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { App as AntApp } from "antd";
import i18n from "../i18n/config";
import type { TeamDetail, TeamMember, TeamSkill, UserSummary } from "../api/studio-client";

// antd's Table and Select watch breakpoints; jsdom has no matchMedia
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

import type { Paged } from "../api/studio-client";

const client = {
  listMembers: vi.fn<(teamId: string) => Promise<Paged<TeamMember>>>(),
  searchMemberCandidates: vi.fn<(teamId: string, keyword: string) => Promise<UserSummary[]>>(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
  getTeam: vi.fn<(teamId: string) => Promise<TeamDetail>>(),
  getMe: vi.fn(async () => ({ userId: "auth0|me", name: "Tôi", email: "me@ant-group.net", avatar: null, isAdmin: false })),
  listTeamSkills: vi.fn<(teamId: string) => Promise<TeamSkill[]>>(),
  createTeamSkill: vi.fn(),
  updateTeamSkill: vi.fn(),
  deleteTeamSkill: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));

const { TeamDetailPage } = await import("./TeamDetailPage");

function team(role: TeamDetail["role"]): TeamDetail {
  return { id: "team-1", name: "Đội Ẩm Thực", role, memberCount: 2, productionCount: 1, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };
}

function skill(over: Partial<TeamSkill> = {}): TeamSkill {
  return {
    id: "s1", teamId: "team-1", name: "Quy chuẩn tiêu đề", purpose: "Tiêu đề bắt mắt", appliesTo: [], content: "# Tiêu đề\n- ≤ 60 ký tự",
    enabled: true, position: 0, createdBy: "auth0|u-1", updatedBy: "auth0|u-1", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
    ...over,
  };
}

function page(search = "", opts: { role?: TeamDetail["role"]; skills?: TeamSkill[] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.getTeam.mockResolvedValue(team(opts.role ?? "owner"));
  client.listTeamSkills.mockResolvedValue(opts.skills ?? []);
  return render(
    <AntApp>
    <NuqsTestingAdapter searchParams={search}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/teams/team-1"]}>
          <Routes>
            <Route path="/teams/:teamId" element={<TeamDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </NuqsTestingAdapter>
    </AntApp>,
  );
}

describe("TeamDetailPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện tên, email của thành viên thay cho User ID; không rõ tên thì hiện id", async () => {
    client.listMembers.mockResolvedValue({
      items: [
        { userId: "auth0|u-1", role: "owner", joinedAt: "2026-09-30T00:00:00Z", name: "Nguyễn An", email: "an@ant-group.net", avatar: null },
        { userId: "auth0|u-2", role: "editor", joinedAt: "2026-09-30T00:00:00Z", name: null, email: null, avatar: null },
      ],
      total: 2, page: 1, pageSize: 20,
    });
    page();
    expect(await screen.findByText("Nguyễn An")).toBeTruthy();
    expect(screen.getByText("an@ant-group.net")).toBeTruthy();
    expect(screen.getByText("auth0|u-2")).toBeTruthy();
    expect(screen.queryByText("auth0|u-1")).toBeNull();
  });

  it("thêm thành viên: tìm theo tên/email, danh sách có tên và email, gửi đúng user id", async () => {
    client.listMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
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
  }, 15_000);
});

describe("TeamDetailPage — quy chuẩn & skill", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("hiện tên nhóm; producer thấy danh sách quy chuẩn và tạo được quy chuẩn mới", async () => {
    client.listMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    client.createTeamSkill.mockResolvedValue(skill({ id: "s3" }));
    page("?tab=skills", { role: "producer", skills: [skill(), skill({ id: "s2", name: "Chỉ cho R&D", appliesTo: ["rnd"], enabled: false })] });
    expect(await screen.findByText("Đội Ẩm Thực")).toBeTruthy();
    expect(await screen.findByText("Quy chuẩn tiêu đề")).toBeTruthy();
    expect(screen.getByText("Mọi bước")).toBeTruthy();
    expect(screen.getByText("R&D")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Thêm quy chuẩn/ }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.change(within(drawer).getByLabelText("Tên"), { target: { value: "Nhịp dựng" } });
    fireEvent.change(within(drawer).getByLabelText("Nội dung (markdown)"), { target: { value: "Đổi cảnh mỗi 4 giây" } });
    fireEvent.click(within(drawer).getByRole("button", { name: /Lưu/ }));
    await waitFor(() => expect(client.createTeamSkill).toHaveBeenCalledWith("team-1", {
      name: "Nhịp dựng", purpose: "", appliesTo: [], enabled: true, content: "Đổi cảnh mỗi 4 giây",
    }));
  }, 15_000);

  it("nhập file .md: frontmatter thành tên, mục đích, bước áp dụng", async () => {
    client.listMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    page("?tab=skills");
    client.createTeamSkill.mockResolvedValue(skill());
    const input = await screen.findByTestId("skill-file-input");
    const file = new File(["---\nname: Nhạc nền\ndescription: Chọn nhạc\napplies_to: [youtube-kit]\n---\nNhạc không lời"], "nhac.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.createTeamSkill).toHaveBeenCalledWith("team-1", {
      name: "Nhạc nền", purpose: "Chọn nhạc", appliesTo: ["youtube-kit"], content: "Nhạc không lời", position: 0,
    }));
  });

  it("người xem chỉ đọc: không có nút thêm, có ghi chú quyền", async () => {
    client.listMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    page("?tab=skills", { role: "viewer", skills: [skill()] });
    expect(await screen.findByText("Quy chuẩn tiêu đề")).toBeTruthy();
    expect(await screen.findByText("Chỉ owner và producer của nhóm được sửa quy chuẩn.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Thêm quy chuẩn/ })).toBeNull();
  });
});
