/**
 * Claude accounts (admin): adding one checks its fields before sending — a name and a token are required, the token
 * is one line with no spaces, turns at once 1–100 or blank — and sends the trimmed values.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const studio = {
  getMe: vi.fn().mockResolvedValue({ userId: "u", isAdmin: true }),
  listTeams: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  getTeam: vi.fn(),
  getPrefs: vi.fn().mockResolvedValue({ tourSeen: {}, checklistHidden: true }),
  getOnboarding: vi.fn().mockResolvedValue({ steps: [], done: 7, total: 7, links: { teamId: null, projectId: null, video: null } }),
  listClaudeAccounts: vi.fn(),
  createClaudeAccount: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));

const { ClaudeAccountsPage } = await import("./ClaudeAccountsPage");

beforeAll(async () => { await i18n.changeLanguage("vi"); });
beforeEach(() => {
  studio.listClaudeAccounts.mockResolvedValue({ accounts: [], canStoreTokens: true });
  studio.createClaudeAccount.mockReset().mockResolvedValue({ id: "a1", name: "HCM" });
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><MemoryRouter><ClaudeAccountsPage /></MemoryRouter></AntApp>
    </QueryClientProvider>,
  );
}

describe("ClaudeAccountsPage — add an account", () => {
  it("says what is missing and sends nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Thêm" }));
    expect(await screen.findByText("Nhập tên tài khoản.")).toBeInTheDocument();
    expect(screen.getByText("Dán token từ claude setup-token.")).toBeInTheDocument();
    expect(studio.createClaudeAccount).not.toHaveBeenCalled();
  });

  it("refuses a token with spaces inside, then sends the trimmed values", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Tên"), { target: { value: "  HCM " } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "sk-ant two" } });
    fireEvent.click(screen.getByRole("button", { name: "Thêm" }));
    expect(await screen.findByText(/không có khoảng trắng/)).toBeInTheDocument();
    expect(studio.createClaudeAccount).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: " sk-ant-oat01-x " } });
    fireEvent.click(screen.getByRole("button", { name: "Thêm" }));
    await waitFor(() => expect(studio.createClaudeAccount).toHaveBeenCalledWith({ name: "HCM", token: "sk-ant-oat01-x", maxConcurrent: null }));
  });
});
