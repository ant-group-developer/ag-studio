import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import type { ClaudeStats } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const m = { turns: 0, threads: 0, userMessages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, wallSeconds: 0, failed: 0, rateLimited: 0 };
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const stats = (groupBy: ClaudeStats["groupBy"]): ClaudeStats => ({
  from: "", to: "", groupBy,
  totals: { ...m, turns: 12, threads: 3, userMessages: 9, inputTokens: 200_000, outputTokens: 8_000, cacheReadTokens: 150_000, costUsd: 3.456, failed: 1, rateLimited: 2 },
  rows: groupBy === "user"
    ? [{ ...m, key: "auth0|lan", label: "Lan", teamId: null, projectId: null, turns: 12, costUsd: 3.456, user: { userId: "auth0|lan", name: "Lan", email: "lan@x", avatar: null } }]
    : [
      { ...m, key: "t1", label: "Nhóm A", teamId: "t1", projectId: null, turns: 10, threads: 2, userMessages: 7, inputTokens: 150_000, cacheReadTokens: 120_000, costUsd: 3 },
      { ...m, key: "t2", label: "Nhóm B", teamId: "t2", projectId: null, turns: 2, costUsd: 0.456 },
    ],
  daily: [{ day: ymd, turns: 12, costUsd: 3.456, inputTokens: 200_000, outputTokens: 8_000 }],
});

const client = {
  getMe: vi.fn().mockResolvedValue({ isAdmin: true }),
  listTeams: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 0, waiting: 0, max: 20, source: "env", assistantName: "Claude" }),
  getAuditScope: vi.fn().mockResolvedValue({ all: true, teams: [{ id: "t1", name: "Nhóm A" }, { id: "t2", name: "Nhóm B" }] }),
  getClaudeStats: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));
const { StatsPage } = await import("./StatsPage");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={["/stats"]}>
          <Routes><Route path="/stats" element={<StatsPage />} /></Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("Claude stats page", { timeout: 30_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    client.getClaudeStats.mockImplementation(async (q: { groupBy: ClaudeStats["groupBy"] }) => stats(q.groupBy));
  });

  it("shows the totals, a bar a day, and a row per team, over the last 30 days", async () => {
    mount();
    expect(await screen.findByText("Nhóm A")).toBeInTheDocument();
    const q = client.getClaudeStats.mock.calls[0]![0] as { from: string; to: string; groupBy: string; tz: number };
    expect(q.groupBy).toBe("team");
    expect(Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000)).toBe(30);
    expect(q.tz).toBe(-new Date().getTimezoneOffset());
    expect(screen.getAllByText("$3.46").length).toBeGreaterThan(0);
    expect(screen.getByText("trong 3 luồng")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument(); // read from cache
    expect(screen.getByText("80%")).toBeInTheDocument(); // Nhóm A's cache share
    expect(screen.getByText("2 lượt chờ hạn mức")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Chi phí theo ngày" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/: \$/)).toHaveLength(30);
  });

  it("groups by person and by period", async () => {
    mount();
    await screen.findByText("Nhóm A");
    fireEvent.click(screen.getByText("Người chat"));
    await waitFor(() => expect(client.getClaudeStats).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "user" })));
    expect(await screen.findByText("lan@x")).toBeInTheDocument();
    fireEvent.click(screen.getByText("7 ngày"));
    await waitFor(() => {
      const q = client.getClaudeStats.mock.lastCall![0] as { from: string; to: string };
      expect(Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000)).toBe(7);
    });
  });
});
