import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { STUDIO_API_URL } from "../../api/http";
import type { WorkspaceFile } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const MTIME = new Date().toISOString();
const file = (over: Partial<WorkspaceFile>): WorkspaceFile => ({
  path: "context/clips/pho.mp4", size: 300 * 1024 * 1024, sha256: null, mtime: MTIME, mime: "video/mp4", binary: true, text: null,
  issues: [], streamUrl: "/api/projects/p1/files/stream?path=context%2Fclips%2Fpho.mp4&t=a", ...over,
});
const ws = { readFile: vi.fn(), fileBlob: vi.fn(), deleteFile: vi.fn().mockResolvedValue(undefined) };
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
const { FileView } = await import("./FileView");

const wrap = (path: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AntApp><FileView projectId="p1" path={path} access="write" canEdit onBack={() => {}} onDeleted={() => {}} /></AntApp>
  </QueryClientProvider>,
);

describe("a workspace file", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("plays a video straight from its link, without downloading it first, and saves it from the same link", async () => {
    ws.readFile.mockResolvedValue(file({}));
    wrap("context/clips/pho.mp4");
    const video = await screen.findByLabelText("context/clips/pho.mp4", { selector: "video" });
    expect(video).toHaveAttribute("src", `${STUDIO_API_URL}/api/projects/p1/files/stream?path=context%2Fclips%2Fpho.mp4&t=a`);
    expect(video).toHaveAttribute("preload", "metadata");
    expect(ws.fileBlob).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Tải xuống" })).toHaveAttribute("href", `${STUDIO_API_URL}/api/projects/p1/files/stream?path=context%2Fclips%2Fpho.mp4&t=a&download=1`);
  });

  it("keeps the link it plays while the file is the same, and takes a fresh one once when the player fails on it", async () => {
    ws.readFile.mockResolvedValue(file({}));
    wrap("context/clips/pho.mp4");
    const video = await screen.findByLabelText("context/clips/pho.mp4", { selector: "video" });
    ws.readFile.mockResolvedValue(file({ streamUrl: "/api/projects/p1/files/stream?path=context%2Fclips%2Fpho.mp4&t=b" }));
    fireEvent.error(video);
    await waitFor(() => expect(video).toHaveAttribute("src", `${STUDIO_API_URL}/api/projects/p1/files/stream?path=context%2Fclips%2Fpho.mp4&t=b`));
    expect(ws.readFile).toHaveBeenCalledTimes(2);
    fireEvent.error(video);
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.readFile).toHaveBeenCalledTimes(2);
  });

  it("deletes a file that is not text without a checksum to check against", async () => {
    ws.readFile.mockResolvedValue(file({ path: "context/a.pdf", mime: "application/pdf", streamUrl: "/api/projects/p1/files/stream?path=context%2Fa.pdf&t=a" }));
    wrap("context/a.pdf");
    await waitFor(() => expect(document.querySelector("iframe")).toHaveAttribute("src", `${STUDIO_API_URL}/api/projects/p1/files/stream?path=context%2Fa.pdf&t=a`));
    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Xóa" }).length).toBeGreaterThan(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Xóa" }).at(-1)!);
    await waitFor(() => expect(ws.deleteFile).toHaveBeenCalledWith("p1", "context/a.pdf", undefined));
  });

  it("shows a text file as before, with no link", async () => {
    ws.readFile.mockResolvedValue(file({ path: "context/notes.md", mime: "text/markdown", binary: false, text: "# Ghi chú", sha256: "a".repeat(64), streamUrl: null, size: 9 }));
    wrap("context/notes.md");
    expect(await screen.findByRole("heading", { name: "Ghi chú" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tải xuống" })).toBeNull();
  });
});
