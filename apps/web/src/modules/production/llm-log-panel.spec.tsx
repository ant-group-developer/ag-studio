import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const call = {
  id: "c1", createdAt: "2026-10-01T01:00:00Z", episodeId: null, episodeIdx: null, stageKey: "plan-episodes", skill: "studio-plan-episodes",
  model: "claude-opus-5-5", round: 1, outcome: "rejected", problems: [{ code: "unknown_asset", message: "a99 không có trong danh mục" }],
  inputTokens: 12000, outputTokens: 900, costUsd: 0.4321, wallSeconds: 42.3, hasPayload: true,
};
const mockClient = {
  listLlmCalls: vi.fn().mockResolvedValue({ items: [call], total: 1, page: 1, pageSize: 20 }),
  listHumanEdits: vi.fn().mockResolvedValue({
    items: [{ id: "h1", createdAt: "2026-10-01T02:00:00Z", userId: "auth0|owner", episodeId: null, episodeIdx: null, kind: "series_plan",
      llmCallId: "c1", changed: true, before: { episodes: 2 }, after: { episodes: 3 } }],
    total: 1, page: 1, pageSize: 20,
  }),
  getLlmCall: vi.fn().mockResolvedValue({ ...call, prompt: "# Skill\nLập kế hoạch\n\n# Brief\nPhở", response: "{}", structuredOutput: { episodes: [] }, warnings: [] }),
};

vi.mock("../../api/studio-client", async (orig) => ({
  ...(await orig<object>()),
  useStudioClient: () => mockClient,
}));

const { LlmLogPanel } = await import("./LlmLogPanel");

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <LlmLogPanel productionId="p1" live={false} />
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("LlmLogPanel", () => {
  it("lists the calls and opens one with its prompt", async () => {
    await i18n.changeLanguage("vi");
    renderPanel();
    expect(await screen.findByText("Bị từ chối")).toBeTruthy();
    expect(screen.getByText("2 (sửa)")).toBeTruthy();
    expect(screen.getByText("$0.4321")).toBeTruthy();
    expect(mockClient.listLlmCalls).toHaveBeenCalledWith("p1", { page: 1, pageSize: 20 });
    fireEvent.click(screen.getAllByRole("button", { name: "Xem" })[0]!);
    await waitFor(() => expect(mockClient.getLlmCall).toHaveBeenCalledWith("p1", "c1"));
    expect(await screen.findByText(/Lập kế hoạch/)).toBeTruthy();
  });

  it("counts the human edits in their tab", async () => {
    await i18n.changeLanguage("vi");
    renderPanel();
    expect(await screen.findByText("Người sửa (1)")).toBeTruthy();
  });
});
