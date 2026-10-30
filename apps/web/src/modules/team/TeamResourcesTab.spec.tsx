/**
 * A team's Resources tab: an admin picks the team's Claude accounts and orders them, and picks its farm pool among the
 * pools the farm has, seeing each one's machines; nothing is typed. A pool with no machine left is said plainly.
 * An owner reads it.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const account = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, isDefault: id === "default", tokenHint: "1234", maxConcurrent: null, enabled: true, rateLimitedUntil: null, lastUsedAt: null,
  lastError: null, lastErrorAt: null, check: { requestedAt: null, at: null, status: null, error: null }, teams: [], createdAt: "", ...over,
});
const studio = {
  getTeamResources: vi.fn(),
  setTeamResources: vi.fn(),
  listClaudeAccounts: vi.fn(),
  listFarmPools: vi.fn(),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
const { TeamResourcesTab } = await import("./TeamResourcesTab");

beforeAll(async () => { await i18n.changeLanguage("vi"); });
beforeEach(() => {
  vi.clearAllMocks();
  studio.getTeamResources.mockResolvedValue({ claudeAccounts: [{ id: "a", name: "HCM 1", enabled: true }], farmPool: null });
  studio.setTeamResources.mockReset().mockImplementation(async (_t: string, v: { claudeAccountIds: string[]; farmPool: string | null }) => ({
    claudeAccounts: v.claudeAccountIds.map((id) => ({ id, name: id === "a" ? "HCM 1" : "HCM 2", enabled: true })), farmPool: v.farmPool,
  }));
  studio.listClaudeAccounts.mockResolvedValue({
    canStoreTokens: true,
    accounts: [account("default", "Mặc định"), account("a", "HCM 1", { rateLimitedUntil: "2099-01-01T00:00:00.000Z" }), account("b", "HCM 2")],
  });
  studio.listFarmPools.mockResolvedValue({
    ok: true, shared: [{ id: "s1", name: "render-01", online: true }],
    pools: [{ pool: "hcm", machines: [{ id: "h1", name: "hcm-render", online: true }, { id: "h2", name: "hcm-render-2", online: false }] }],
  });
});

function mount(isAdmin: boolean) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><MemoryRouter><TeamResourcesTab teamId="team-1" isAdmin={isAdmin} /></MemoryRouter></AntApp>
    </QueryClientProvider>,
  );
}

async function pick(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByTitle(option));
}

describe("TeamResourcesTab", { timeout: 30_000 }, () => {
  it("an admin adds an account, puts it first, picks a pool from the farm's and saves", async () => {
    mount(true);
    expect(await screen.findByText(/hết hạn mức tới/, undefined, { timeout: 10_000 })).toBeInTheDocument();
    await pick("Thêm tài khoản cho nhóm…", "HCM 2");
    const names = () => within(screen.getByRole("list", { name: "Thứ tự dùng" })).getAllByText(/^HCM \d$/).map((x) => x.textContent);
    expect(names()).toEqual(["HCM 1", "HCM 2"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Lên trên" })[1]!);
    expect(names()).toEqual(["HCM 2", "HCM 1"]);

    // the shared machines first, then the farm's pools with their machines
    await pick("Pool máy farm", "Pool hcm · 2 máy (1 đang bật)");
    const machines = screen.getByRole("list", { name: "Máy của lựa chọn này" });
    expect(within(machines).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["hcm-render · đang bật", "hcm-render-2 · đang tắt"]);
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(studio.setTeamResources).toHaveBeenCalledWith("team-1", { claudeAccountIds: ["b", "a"], farmPool: "hcm" }));
  });

  it("a saved pool the farm has no machine in any more is said plainly", async () => {
    studio.getTeamResources.mockResolvedValue({ claudeAccounts: [], farmPool: "hn" });
    mount(true);
    expect(await screen.findByText(/Farm không có máy nào trong pool hn/)).toBeInTheDocument();
    expect(screen.getByText("Dùng tài khoản mặc định")).toBeInTheDocument();
  });

  it("an owner reads the accounts and the pool's machines, and changes nothing", async () => {
    studio.getTeamResources.mockResolvedValue({ claudeAccounts: [{ id: "a", name: "HCM 1", enabled: true }], farmPool: "hcm" });
    mount(false);
    expect(await screen.findByText("HCM 1")).toBeInTheDocument();
    expect(await screen.findByText("Pool hcm")).toBeInTheDocument();
    expect(await screen.findByText("hcm-render")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lưu" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(studio.listClaudeAccounts).not.toHaveBeenCalled();
  });
});
