import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => ({ setClaudeMaxConcurrent: vi.fn() }) }));
const { ClaudeSettingsForm } = await import("./ClaudeSettingsForm");

describe("ClaudeSettingsForm", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("someone who is not an admin only reads the cap and where it comes from", () => {
    render(<QueryClientProvider client={new QueryClient()}><AntApp>
      <ClaudeSettingsForm usage={{ running: 3, waiting: 2, max: 20, source: "env" }} isAdmin={false} />
    </AntApp></QueryClientProvider>);
    expect(screen.getByText("3 / 20 lượt đang chạy")).toBeInTheDocument();
    expect(screen.getByText("2 tin nhắn đang chờ lượt")).toBeInTheDocument();
    expect(screen.getByText(/STUDIO_CLAUDE_MAX_CONCURRENT/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Số lượt chạy cùng lúc")).toBeNull();
  });
});
