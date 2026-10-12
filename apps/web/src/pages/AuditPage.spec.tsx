import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { AuditItem } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const row = (over: Partial<AuditItem>): AuditItem => ({
  id: `r-${Math.random()}`, at: "2026-10-11T08:00:00.000Z", actorKind: "user", actorId: "auth0|lan", actor: { userId: "auth0|lan", name: "Lan", email: "lan@x", avatar: null },
  kind: "http", action: "VideosController.create", outcome: "ok", method: "POST", route: "/api/projects/:projectId/videos", statusCode: 201, durationMs: 42,
  team: { id: "t1", name: "Nhóm A" }, project: { id: "p1", name: "Du lịch chậm" }, video: null, threadId: null, messageId: null, jobId: null,
  target: "Tràng An", summary: null, details: { params: { projectId: "p1" }, body: { title: "Tràng An" } }, costUsd: null, ...over,
});

const client = {
  getMe: vi.fn().mockResolvedValue({ isAdmin: false }),
  listTeams: vi.fn().mockResolvedValue({ items: [{ id: "t1", name: "Nhóm A", role: "owner" }], total: 1, page: 1, pageSize: 100 }),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 0, waiting: 0, max: 20, source: "env" }),
  getAuditScope: vi.fn().mockResolvedValue({ all: false, teams: [{ id: "t1", name: "Nhóm A" }] }),
  listAuditActors: vi.fn().mockResolvedValue({ actors: [{ userId: "auth0|lan", name: "Lan", email: "lan@x", avatar: null }] }),
  listAudit: vi.fn(),
};
const ws = { listProjects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", name: "Du lịch chậm" }] }) };
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));
const { AuditPage } = await import("./AuditPage");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={["/audit"]}>
          <Routes><Route path="/audit" element={<AuditPage />} /></Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("activity log page", { timeout: 30_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    client.listAudit.mockResolvedValue({ total: 3, page: 1, pageSize: 50, items: [
      row({}),
      row({ actorKind: "agent", kind: "tool", action: "footage_search", outcome: "error", method: null, route: null, statusCode: null, summary: "chưa có project", target: null }),
      row({ actorKind: "agent", kind: "turn", action: "turn", method: null, route: null, statusCode: null, costUsd: 0.1234, durationMs: 65_000, threadId: "th1" }),
    ] });
  });

  it("lists who did what where, how it ended, time and cost; a row opens to its details", async () => {
    mount();
    expect(await screen.findByText("POST /api/projects/:projectId/videos")).toBeInTheDocument();
    expect(screen.getAllByText("Claude (cho Lan)")).toHaveLength(2);
    expect(screen.getByText("tìm cảnh trong footage")).toBeInTheDocument();
    expect(screen.getByText("Lỗi")).toBeInTheDocument();
    expect(screen.getByText("Xong 201")).toBeInTheDocument();
    expect(screen.getByText("$0.12")).toBeInTheDocument();
    expect(screen.getByText("1m5s")).toBeInTheDocument();
    expect(screen.getAllByText("Du lịch chậm")[0]!.closest("a")).toHaveAttribute("href", "/p/p1");
    fireEvent.click(screen.getAllByRole("button", { name: /expand row|mở rộng/i })[0]!);
    expect(await screen.findByLabelText("Chi tiết")).toHaveTextContent('"title": "Tràng An"');
  });

  it("filters by kind", async () => {
    mount();
    await screen.findByText("tìm cảnh trong footage");
    expect(client.listAudit).toHaveBeenLastCalledWith({ page: 1, pageSize: 50 });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Loại" }));
    fireEvent.click(await screen.findByTitle("Tool"));
    await waitFor(() => expect(client.listAudit).toHaveBeenLastCalledWith({ kind: "tool", page: 1, pageSize: 50 }));
  });
});
