import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import { StudioHttpError } from "../api/http";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const studio = {
  getMe: vi.fn().mockResolvedValue({ userId: "u", isAdmin: false }),
  getCanvaConnection: vi.fn().mockResolvedValue({ enabled: false, connected: false, displayName: null }),
  listTeams: vi.fn().mockResolvedValue({ items: [{ id: "team-1", name: "Du lịch", role: "producer" }], total: 1, page: 1, pageSize: 100 }),
};
const project = {
  id: "p1", teamId: "team-1", name: "Du lịch chậm", channelUrl: "@dulichcham", description: "Đi bộ phố cổ", language: "vi", aspect: "16:9",
  settings: { auto_fix: true, auto_continue: true }, ownerUserId: "u", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null,
};
const ws = {
  listProjects: vi.fn().mockResolvedValue({ projects: [{ ...project, videoCount: 2, lastActivityAt: new Date().toISOString() }] }),
  createProject: vi.fn().mockResolvedValue({ ...project, id: "p-new" }),
  getProject: vi.fn().mockResolvedValue({
    ...project,
    videos: [{ id: "v2", projectId: "p1", idx: 2, title: "Huế mưa", status: "in_progress", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null }],
  }),
  createVideo: vi.fn().mockResolvedValue({ id: "v3", projectId: "p1", idx: 3, title: "Video 3", status: "draft" }),
  listFiles: vi.fn().mockResolvedValue({ entries: [
    { path: "CLAUDE.md", kind: "file", size: 10, mtime: "", access: "write" },
    { path: "context", kind: "dir", size: 0, mtime: "", access: "write" },
    { path: "context/notes.md", kind: "file", size: 10, mtime: "", access: "write" },
    { path: ".studio", kind: "dir", size: 0, mtime: "", access: "read" },
  ] }),
  readFile: vi.fn(async (_p: string, path: string) => ({
    path, size: 10, sha256: "a".repeat(64), mtime: new Date().toISOString(), mime: "text/markdown", binary: false,
    text: path === "CLAUDE.md" ? "# Du lịch chậm\n\nKênh đi bộ." : "# Ghi chú\n\nmột dòng",
  })),
  writeFile: vi.fn(),
  listFileVersions: vi.fn().mockResolvedValue({ versions: [] }),
  updateProject: vi.fn(),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
vi.mock("../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));

const { ProjectsPage } = await import("./ProjectsPage");
const { ProjectPage } = await import("./ProjectPage");

function mount(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/t/:teamId" element={<ProjectsPage />} />
            <Route path="/p/:projectId" element={<ProjectPage />} />
            <Route path="/p/:projectId/v/:videoId" element={<ProjectPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("workspace pages", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("lists the team's projects and makes a new one for a channel", async () => {
    mount("/t/team-1");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    expect(screen.getByText("2 video")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Dự án mới/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Tên dự án"), { target: { value: "Ẩm thực Huế" } });
    fireEvent.change(within(dialog).getByLabelText("Kênh YouTube"), { target: { value: "@amthuchue" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo dự án" }));
    await waitFor(() => expect(ws.createProject).toHaveBeenCalledWith("team-1", { name: "Ẩm thực Huế", channelUrl: "@amthuchue", aspect: "16:9" }));
  });

  it("shows the project's CLAUDE.md, its videos, and its files", async () => {
    mount("/p/p1");
    expect(await screen.findByRole("heading", { name: "Du lịch chậm" })).toBeInTheDocument();
    expect(screen.getByText("Huế mưa")).toBeInTheDocument();
    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    fireEvent.click(screen.getByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "Ghi chú" })).toBeInTheDocument();
  });

  it("edits a file and says when someone changed it first", async () => {
    ws.writeFile.mockRejectedValueOnce(new StudioHttpError(409, { code: "file_conflict", message: "x", currentSha256: "b".repeat(64) }));
    mount("/p/p1?tab=files&file=context%2Fnotes.md");
    expect(await screen.findByRole("heading", { name: "Ghi chú" })).toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "Tệp và cài đặt" });
    fireEvent.click(within(aside).getByRole("button", { name: "Sửa" }));
    const editor = await screen.findByLabelText("context/notes.md");
    fireEvent.change(editor, { target: { value: "# Ghi chú\n\nhai dòng" } });
    fireEvent.click(within(aside).getByRole("button", { name: "Lưu" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tệp đã đổi từ lúc bạn mở");
    expect(ws.writeFile).toHaveBeenCalledWith("p1", { path: "context/notes.md", content: "# Ghi chú\n\nhai dòng", baseSha256: "a".repeat(64) });
    ws.writeFile.mockResolvedValueOnce({ path: "context/notes.md", sha256: "c".repeat(64), size: 1, versionId: "v" });
    fireEvent.click(screen.getByRole("button", { name: "Ghi đè bằng bản của tôi" }));
    await waitFor(() => expect(ws.writeFile).toHaveBeenLastCalledWith("p1", { path: "context/notes.md", content: "# Ghi chú\n\nhai dòng", baseSha256: "b".repeat(64) }));
  });

  it("adds a video from the project", async () => {
    mount("/p/p1");
    fireEvent.click(await screen.findByRole("button", { name: /Video mới/ }));
    await waitFor(() => expect(ws.createVideo).toHaveBeenCalledWith("p1"));
  });
});
