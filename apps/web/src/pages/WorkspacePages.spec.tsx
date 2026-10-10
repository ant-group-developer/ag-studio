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
  listTeamSkills: vi.fn().mockResolvedValue([]),
};
const step = (key: string, title: string, status: string, over: Record<string, unknown> = {}) => ({
  key, scope: "project", title, description: `Mô tả ${title}`, skill: null, optional: false, requires: [], status,
  outputs: [{ path: `channel/${key}.md`, role: "doc", exists: status !== "missing", issues: [] }], issues: [], primary: `channel/${key}.md`,
  prompts: { do: `Làm ${title}`, redo: `Làm lại ${title}`, revise: `Sửa ${title}: ` }, staleBecause: [], detail: null, ...over,
});
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
  listThreads: vi.fn().mockResolvedValue({ threads: [
    { id: "t-kenh", projectId: "p1", videoId: null, kind: "project", title: "Kênh", useLessons: true, createdAt: "", updatedAt: "", archivedAt: null, messageCount: 2, busy: true },
    { id: "t-v2", projectId: "p1", videoId: "v2", kind: "video", title: "Huế mưa", useLessons: true, createdAt: "", updatedAt: "", archivedAt: null, messageCount: 0 },
  ] }),
  getThread: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ message: {}, turn: null }),
  cancelTurn: vi.fn().mockResolvedValue({}),
  getActivity: vi.fn().mockResolvedValue({ activity: [] }),
  getVideo: vi.fn().mockResolvedValue({ id: "v2", projectId: "p1", idx: 2, title: "Huế mưa", status: "in_progress", threadId: "t-v2" }),
  openThreadEvents: vi.fn(() => new Promise(() => {})),
  openProjectEvents: vi.fn(() => new Promise(() => {})),
  setLearning: vi.fn(),
  createThread: vi.fn(),
  getPlaybook: vi.fn().mockResolvedValue({
    custom: false, issues: [], video: null, next: [{ scope: "project", key: "branding" }],
    project: [
      step("research", "Nghiên cứu thị trường", "done"),
      step("branding", "Branding", "invalid", { issues: [{ level: "error", code: "text_look_no_contrast", message: "channel/branding.md: chữ khó đọc" }] }),
    ],
  }),
  markStep: vi.fn().mockResolvedValue({}),
  customizePlaybook: vi.fn(),
  listLessons: vi.fn().mockResolvedValue({ lessons: [{ id: "l1", project_id: "p1", thread_id: "t-kenh", text: "Không dùng nhạc buồn.", status: "proposed", decided_by: null, decided_at: null, created_at: "" }] }),
  acceptLesson: vi.fn().mockResolvedValue({}),
  dismissLesson: vi.fn().mockResolvedValue(undefined),
};
const NOW = new Date().toISOString();
const message = (over: Record<string, unknown>) => ({
  id: `m${Math.random()}`, threadId: "t-kenh", seq: 1, role: "assistant", status: "done", text: "", parts: [], phase: null, attachments: [],
  trigger: "user", notBefore: null, error: null, cancelRequested: false, costUsd: null, createdBy: "u", actorRole: "editor",
  startedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
});
const thread = (messages: unknown[]) => ({ id: "t-kenh", projectId: "p1", videoId: null, kind: "project", title: "Kênh", useLessons: true, refs: [], messages, createdAt: "", updatedAt: "", archivedAt: null });
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
            <Route path="/p/:projectId/c/:threadId" element={<ProjectPage />} />
            <Route path="/p/:projectId/v/:videoId" element={<ProjectPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("workspace pages", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getThread.mockResolvedValue(thread([
      message({ id: "u1", seq: 1, role: "user", text: "Nghiên cứu kênh giúp tôi" }),
      message({ id: "a1", seq: 2, text: "## Kế hoạch\n\nTôi sẽ đọc tài liệu.", parts: [
        { kind: "text", text: "## Kế hoạch\n\nTôi sẽ đọc tài liệu." },
        { kind: "tool", id: "x1", name: "Read", input: { file_path: "context/notes.md" }, started_at: NOW, ended_at: NOW, is_error: false, result: "ok" },
        { kind: "tool", id: "x2", name: "mcp__studio__suggest_replies", input: { options: ["Làm tiếp", "Dừng ở đây"] }, started_at: NOW, ended_at: NOW },
      ] }),
    ]));
  });

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

  it("opens on the channel's chat, with its chats, its videos and its files", async () => {
    mount("/p/p1");
    // the first render of the whole page: slower when the repo's suites run side by side
    expect(await screen.findByRole("heading", { name: "Kế hoạch" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Nghiên cứu kênh giúp tôi")).toBeInTheDocument();
    expect(screen.getByText("đọc file")).toBeInTheDocument();
    expect(screen.getAllByText("Huế mưa").length).toBeGreaterThan(0);
    expect(ws.getThread).toHaveBeenCalledWith("t-kenh");
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

  it("adds a video with what it is about and what it learns from", async () => {
    mount("/p/p1");
    fireEvent.click(await screen.findByRole("button", { name: /Video mới/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Video này về gì"), { target: { value: "Hội An lúc lên đèn" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo video" }));
    await waitFor(() => expect(ws.createVideo).toHaveBeenCalledWith("p1", { prompt: "Hội An lúc lên đèn", learning: { useLessons: true, threads: [] } }));
  });

  it("sends a message, offers the agent's suggested replies, and stops a running turn", async () => {
    mount("/p/p1");
    const reply = await screen.findByRole("button", { name: "Làm tiếp" });
    fireEvent.click(reply);
    await waitFor(() => expect(ws.sendMessage).toHaveBeenCalledWith("t-kenh", { text: "Làm tiếp" }));
    const box = screen.getByLabelText("Tin nhắn cho Claude");
    fireEvent.change(box, { target: { value: "Viết chiến lược kênh" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(ws.sendMessage).toHaveBeenLastCalledWith("t-kenh", { text: "Viết chiến lược kênh" }));
  });

  it("suggests the steps: a step opens with its errors, and 'do this step' fills the message box", async () => {
    mount("/p/p1");
    const rail = await screen.findByRole("navigation", { name: "Các bước gợi ý" });
    fireEvent.click(within(rail).getByRole("button", { name: /Branding/ }));
    expect(await screen.findByText("channel/branding.md: chữ khó đọc")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Làm bước này" }));
    expect(screen.getByLabelText("Tin nhắn cho Claude")).toHaveValue("Làm Branding");
  });

  it("offers this thread's proposed lessons to keep", async () => {
    mount("/p/p1");
    const lessons = await screen.findByRole("region", { name: "Bài học đề xuất từ chat này" });
    expect(lessons).toHaveTextContent("Không dùng nhạc buồn.");
    fireEvent.click(within(lessons).getByRole("button", { name: "Lưu vào bài học dự án" }));
    await waitFor(() => expect(ws.acceptLesson).toHaveBeenCalledWith("p1", "l1"));
  });

  it("shows who works, on what and for how long while a turn runs, and stops it", async () => {
    ws.getThread.mockResolvedValue(thread([
      message({ id: "u1", seq: 1, role: "user", text: "Tạo 3 video" }),
      message({ id: "run", seq: 2, status: "running", phase: { kind: "tool", tool: "mcp__studio__video_create", detail: null }, startedAt: new Date(Date.now() - 65_000).toISOString(), parts: [
        { kind: "tool", id: "x1", name: "mcp__studio__video_create", input: { title: "Hội An đêm" }, started_at: new Date(Date.now() - 3000).toISOString() },
      ] }),
    ]));
    mount("/p/p1");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Claude");
    expect(status).toHaveTextContent("đang tạo video · Hội An đêm");
    expect(status).toHaveTextContent(/1:0\d · 1 công cụ/);
    fireEvent.click(within(status).getByRole("button", { name: /Dừng/ }));
    await waitFor(() => expect(ws.cancelTurn).toHaveBeenCalledWith("t-kenh", "run"));
  });
});
