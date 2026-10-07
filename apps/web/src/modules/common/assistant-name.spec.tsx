import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ChatThreadView, ChatTurn } from "../../api/studio-client";

const usage = { running: 0, waiting: 0, max: 20, source: "env" as const, assistantName: "AG AI" };
const client = {
  getClaudeUsage: vi.fn().mockResolvedValue(usage),
  setAssistantName: vi.fn().mockResolvedValue({ ...usage, assistantName: "Trợ lý" }),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { AssistantNameProvider } = await import("./assistant-name");
const { ChatThread } = await import("../chat/ChatThread");
const { AssistantNameForm } = await import("../chat/AssistantNameForm");

const turn = (over: Partial<ChatTurn>): ChatTurn => ({
  id: "t1", production_id: "p", episode_id: null, run_id: "r", scope: "gate", stage_key: "approve-rnd", turn: 1, role: "assistant",
  text: "", mentions: [], context: null, proposal: null, action: null, status: "running", not_before: null, problems: [],
  llm_call_id: null, created_by: null, applied_at: null, created_at: "", updated_at: "", ...over,
});
const thread: ChatThreadView = {
  turns: [turn({})], scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "approve-rnd", scope: "gate" }, blocked: null,
  current: null, queueAhead: 0,
};

function mount(node: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><AssistantNameProvider>{node}</AssistantNameProvider></AntApp>
    </QueryClientProvider>,
  );
}

describe("the AI's name", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("the chat calls the AI by the name the Studio saved", async () => {
    mount(<ChatThread onCard={vi.fn()} thread={thread} />);
    expect(await screen.findByText("AG AI đang trả lời…")).toBeInTheDocument();
    expect(screen.getByText("AG AI", { selector: ".chat-reply__who" })).toBeInTheDocument();
  });

  it("an admin renames it; the new name shows at once", async () => {
    mount(<><AssistantNameForm /><ChatThread onCard={vi.fn()} thread={thread} /></>);
    const box = await screen.findByLabelText("Tên hiển thị");
    await waitFor(() => expect(box).toHaveValue("AG AI"));
    fireEvent.change(box, { target: { value: "  Trợ lý " } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu tên" }));
    await waitFor(() => expect(client.setAssistantName).toHaveBeenCalledWith("Trợ lý"));
    expect(await screen.findByText("Trợ lý đang trả lời…")).toBeInTheDocument();
  });
});
