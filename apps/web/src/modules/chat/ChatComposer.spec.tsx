import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { encodeMentions, insertMention, mentionQuery, messageParts } from "./mentions";

const agGo = { getFolders: vi.fn().mockResolvedValue({ folders: [
  { id: "f1", name: "Kyoto 2025", parentId: null, usableVideos: 38 },
  { id: "f2", name: "Kyushu", parentId: null, usableVideos: 12 },
  { id: "f3", name: "Huế", parentId: null, usableVideos: 9 },
] }) };
vi.mock("../../api/ag-go-client", async (orig) => ({ ...(await orig<object>()), useAgGoClient: () => agGo }));
const { ChatComposer } = await import("./ChatComposer");

describe("mentions", () => {
  it("finds the @word being typed and replaces it by the folder", () => {
    expect(mentionQuery("Làm từ @Ky", 10)).toEqual({ start: 7, query: "Ky" });
    expect(mentionQuery("email a@b", 9)).toBeNull();
    expect(insertMention("Làm từ @Ky nhé", 7, 10, "Kyoto 2025")).toEqual({ text: "Làm từ @Kyoto 2025  nhé", caret: 19 });
  });

  it("sends picked folders by id, and reads them back for display", () => {
    const sent = encodeMentions("từ @Kyoto 2025 và @Kyushu", [{ id: "f2", name: "Kyushu" }, { id: "f1", name: "Kyoto 2025" }]);
    expect(sent).toBe("từ @[Kyoto 2025](folder:f1) và @[Kyushu](folder:f2)");
    expect(messageParts(sent)).toEqual([
      { kind: "text", text: "từ " }, { kind: "folder", name: "Kyoto 2025", id: "f1" }, { kind: "text", text: " và " }, { kind: "folder", name: "Kyushu", id: "f2" },
    ]);
  });
});

describe("ChatComposer", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  const mount = (onSend = vi.fn()) => {
    render(<QueryClientProvider client={new QueryClient()}><ChatComposer onSend={onSend} /></QueryClientProvider>);
    return { onSend, box: screen.getByLabelText("Yêu cầu cho Claude") as HTMLTextAreaElement };
  };

  it("picks a folder after @ and sends it by id with Enter", async () => {
    const { onSend, box } = mount();
    fireEvent.change(box, { target: { value: "Làm series từ @Ky", selectionStart: 17 } });
    const option = await screen.findByRole("button", { name: /Kyoto 2025/ });
    expect(screen.queryByRole("button", { name: /Huế/ })).toBeNull();
    fireEvent.mouseDown(option);
    expect(box.value).toBe("Làm series từ @Kyoto 2025 ");
    expect(screen.getByText("@Kyoto 2025")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Làm series từ @Kyoto 2025 nhé", selectionStart: 29 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Làm series từ @[Kyoto 2025](folder:f1) nhé"));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("Shift+Enter is a new line, and an empty box sends nothing", () => {
    const { onSend, box } = mount();
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "dòng 1", selectionStart: 6 } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
