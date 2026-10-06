import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = {
  getClaudeUsage: vi.fn().mockResolvedValue({ running: 3, waiting: 2, max: 20, source: "env" }),
  getMe: vi.fn(),
  setClaudeMaxConcurrent: vi.fn().mockResolvedValue({ running: 3, waiting: 2, max: 12, source: "settings" }),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { ClaudeChip } = await import("./ClaudeChip");

const mount = () => render(<QueryClientProvider client={new QueryClient()}><AntApp><ClaudeChip /></AntApp></QueryClientProvider>);

describe("ClaudeChip", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("shows calls running and waiting; an admin sets the cap", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Claude: 3/20 lượt đang chạy · 2 lượt chờ" }));
    expect(await screen.findByText("2 tin nhắn đang chờ lượt")).toBeInTheDocument();
    const input = screen.getByLabelText("Số lượt chạy cùng lúc");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(client.setClaudeMaxConcurrent).toHaveBeenCalledWith(12));
  });

  it("someone who is not an admin only reads it", async () => {
    client.getMe.mockResolvedValue({ userId: "u", isAdmin: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Claude: 3\/20/ }));
    expect(await screen.findByText(/STUDIO_CLAUDE_MAX_CONCURRENT/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Số lượt chạy cùng lúc")).toBeNull();
  });
});
