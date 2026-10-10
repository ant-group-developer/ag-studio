import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";

const usage = { running: 0, waiting: 0, max: 20, source: "env" as const, assistantName: "AG AI" };
const client = {
  getClaudeUsage: vi.fn().mockResolvedValue(usage),
  setAssistantName: vi.fn().mockResolvedValue({ ...usage, assistantName: "Trợ lý" }),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { AssistantNameProvider, useAiTranslation } = await import("./assistant-name");
const { AssistantNameForm } = await import("../admin/AssistantNameForm");

/** What the chat composer says, with the AI's name in it. */
function Placeholder() {
  const { t } = useAiTranslation();
  return <p data-testid="placeholder">{t("ws.chat.inputLabel")}</p>;
}

function mount(node: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp><AssistantNameProvider>{node}</AssistantNameProvider></AntApp>
    </QueryClientProvider>,
  );
}

describe("the AI's name", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("the workspace calls the AI by the name the Studio saved", async () => {
    mount(<Placeholder />);
    await waitFor(() => expect(screen.getByTestId("placeholder")).toHaveTextContent("Tin nhắn cho AG AI"));
  });

  it("an admin renames it; the new name shows at once", async () => {
    mount(<><AssistantNameForm /><Placeholder /></>);
    const box = await screen.findByLabelText("Tên hiển thị");
    await waitFor(() => expect(box).toHaveValue("AG AI"));
    fireEvent.change(box, { target: { value: "  Trợ lý " } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu tên" }));
    await waitFor(() => expect(client.setAssistantName).toHaveBeenCalledWith("Trợ lý"));
    await waitFor(() => expect(screen.getByTestId("placeholder")).toHaveTextContent("Tin nhắn cho Trợ lý"));
  });
});
