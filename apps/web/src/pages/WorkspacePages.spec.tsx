import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import { StudioHttpError } from "../api/http";
import type { TeamDetail } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const studio = {
  getMe: vi.fn().mockResolvedValue({ userId: "u", isAdmin: false }),
  getCanvaConnection: vi.fn().mockResolvedValue({ enabled: false, connected: false, displayName: null }),
  listTeams: vi.fn().mockResolvedValue({ items: [{ id: "team-1", name: "Du lịch", role: "producer", isMember: true }], total: 1, page: 1, pageSize: 100 }),
  getTeam: vi.fn(async (id: string): Promise<TeamDetail> => ({ id, name: "Du lịch", role: "producer", isMember: true, memberCount: 1, projectCount: 1, createdAt: "", updatedAt: "" })),
  listTeamSkills: vi.fn().mockResolvedValue([]),
  createTeam: vi.fn().mockResolvedValue({ id: "team-new", name: "Ẩm thực", role: "owner", memberCount: 1, projectCount: 0, createdAt: "" }),
};
const ONE_TEAM = { items: [{ id: "team-1", name: "Du lịch", role: "producer", isMember: true }], total: 1, page: 1, pageSize: 100 };
const TEAM_1: TeamDetail = { id: "team-1", name: "Du lịch", role: "producer", isMember: true, memberCount: 1, projectCount: 1, createdAt: "", updatedAt: "" };
const step = (key: string, title: string, status: string, over: Record<string, unknown> = {}) => ({
  key, scope: "project", title, description: `Mô tả ${title}`, skill: null, optional: false, requires: [], status,
  outputs: [{ path: `channel/${key}.md`, role: "doc", exists: status !== "missing", issues: [] }], issues: [], primary: `channel/${key}.md`,
  prompts: { do: `Làm ${title}`, redo: `Làm lại ${title}`, revise: `Sửa ${title}: ` }, staleBecause: [], detail: null, ...over,
});
const project = {
  id: "p1", teamId: "team-1", name: "Du lịch chậm", channelUrl: "@dulichcham", description: "Đi bộ phố cổ", language: "vi", aspect: "16:9",
  settings: { auto_fix: true, auto_continue: true }, ownerUserId: "u", createdBy: "u", createdAt: "", updatedAt: "", archivedAt: null,
  creator: { userId: "u", name: "An Nguyễn", email: "a@b.c", avatar: null },
};
const BINH = { userId: "auth0|binh", name: null, email: "binh@ant-group.net", avatar: null };
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
    { id: "t-free", projectId: "p1", videoId: null, kind: "project", title: "Ý tưởng tháng 11", useLessons: true, createdAt: "", updatedAt: "", archivedAt: null, messageCount: 0 },
  ] }),
  getThread: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ message: {}, turn: null }),
  cancelTurn: vi.fn().mockResolvedValue({}),
  getActivity: vi.fn().mockResolvedValue({ activity: [] }),
  getVideo: vi.fn().mockResolvedValue({ id: "v2", projectId: "p1", idx: 2, title: "Huế mưa", status: "in_progress", threadId: "t-v2" }),
  openThreadEvents: vi.fn(() => new Promise(() => {})),
  openProjectEvents: vi.fn(() => new Promise(() => {})),
  setLearning: vi.fn(),
  renameThread: vi.fn(),
  updateVideo: vi.fn(),
  createThread: vi.fn(),
  getPlaybook: vi.fn(),
  markStep: vi.fn().mockResolvedValue({}),
  customizePlaybook: vi.fn(),
  listLessons: vi.fn().mockResolvedValue({ lessons: [{ id: "l1", project_id: "p1", thread_id: "t-kenh", text: "Không dùng nhạc buồn.", status: "proposed", decided_by: null, decided_at: null, created_at: "" }] }),
  acceptLesson: vi.fn().mockResolvedValue({}),
  dismissLesson: vi.fn().mockResolvedValue(undefined),
};
const PLAYBOOK = {
  custom: false, issues: [], video: null, next: [{ scope: "project", key: "branding" }],
  project: [
    step("research", "Nghiên cứu thị trường", "done"),
    step("branding", "Branding", "invalid", { issues: [{ level: "error", code: "text_look_no_contrast", message: "channel/branding.md: chữ khó đọc" }] }),
  ],
};
const vstep = (key: string, title: string, status: string, over: Record<string, unknown> = {}) =>
  step(key, title, status, { scope: "video", primary: `videos/v2/${key}.md`, outputs: [{ path: `videos/v2/${key}.md`, role: "doc", exists: status !== "missing", issues: [] }], ...over });
const CHANNEL_NEW = [step("research", "Nghiên cứu thị trường", "missing"), step("channel", "Chiến lược kênh", "missing"), step("branding", "Branding", "missing")];
const CHANNEL_RESEARCHED = [step("research", "Nghiên cứu thị trường", "done"), step("channel", "Chiến lược kênh", "missing"), step("branding", "Branding", "missing")];
/** The video's steps, with the given statuses (the rest missing). */
const videoSteps = (statuses: Record<string, string>, over: Record<string, Record<string, unknown>> = {}) => [
  ["brief", "Ý tưởng & brief"], ["prepare", "Chuẩn bị đầu vào"], ["scenes", "Chọn cảnh"], ["timeline", "Timeline"], ["preview", "Xem trước"],
  ["youtube-kit", "Gói YouTube"], ["final", "Bản cuối"],
].map(([key, title]) => vstep(key!, title!, statuses[key!] ?? "missing", over[key!]));
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
const { HomePage } = await import("./HomePage");
const { ProjectPage } = await import("./ProjectPage");

function mount(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/teams" element={<p>trang nhóm</p>} />
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
    studio.listTeams.mockResolvedValue(ONE_TEAM);
    studio.getMe.mockResolvedValue({ userId: "u", isAdmin: false });
    studio.getTeam.mockImplementation(async (id: string) => ({ ...TEAM_1, id }));
    ws.getPlaybook.mockResolvedValue(PLAYBOOK);
    ws.getThread.mockResolvedValue(thread([
      message({ id: "u1", seq: 1, role: "user", text: "Nghiên cứu kênh giúp tôi" }),
      message({ id: "a1", seq: 2, text: "Tôi sẽ đọc tài liệu.\n\n## Kế hoạch\n\nĐi bộ phố cổ.", finishedAt: new Date(Date.parse(NOW) + 80_000).toISOString(), parts: [
        { kind: "text", text: "Tôi sẽ đọc tài liệu." },
        { kind: "tool", id: "x1", name: "Read", input: { file_path: "context/notes.md" }, started_at: NOW, ended_at: NOW, is_error: false, result: "ok" },
        { kind: "text", text: "## Kế hoạch\n\nĐi bộ phố cổ." },
        { kind: "tool", id: "x2", name: "mcp__studio__suggest_replies", input: { options: ["Làm tiếp", "Dừng ở đây"] }, started_at: NOW, ended_at: NOW },
      ] }),
    ]));
  });

  it("lists the team's projects and makes a new one for a channel", async () => {
    mount("/t/team-1");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    // the list opens as a table
    expect(within(screen.getByRole("row", { name: /Du lịch chậm/ })).getByText("2")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Dự án mới/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Tên dự án"), { target: { value: "Ẩm thực Huế" } });
    fireEvent.change(within(dialog).getByLabelText("Kênh YouTube"), { target: { value: "@amthuchue" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo dự án" }));
    await waitFor(() => expect(ws.createProject).toHaveBeenCalledWith("team-1", { name: "Ẩm thực Huế", channelUrl: "@amthuchue", aspect: "16:9" }));
  });

  it("the team picker makes a new team and leads to the teams page", async () => {
    mount("/t/team-1");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Nhóm" });
    fireEvent.mouseDown(picker);
    fireEvent.click(await screen.findByRole("button", { name: "Tạo nhóm mới" }));
    const dialog = await screen.findByRole("dialog", { name: "Nhóm mới" });
    fireEvent.change(within(dialog).getByLabelText("Tên nhóm"), { target: { value: "  Ẩm thực " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo nhóm" }));
    await waitFor(() => expect(studio.createTeam).toHaveBeenCalledWith("Ẩm thực"));
    await waitFor(() => expect(ws.listProjects).toHaveBeenCalledWith("team-new"));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Nhóm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Quản lý nhóm" }));
    expect(await screen.findByText("trang nhóm")).toBeInTheDocument();
  });

  it("an admin sees every team in the picker, works in a team they are not in, and is told so", async () => {
    studio.getMe.mockResolvedValue({ userId: "admin", isAdmin: true });
    studio.listTeams.mockResolvedValue({ items: [
      { id: "team-1", name: "Du lịch", role: "producer", isMember: true },
      { id: "team-2", name: "Ẩm thực", role: null, isMember: false },
    ], total: 2, page: 1, pageSize: 100 });
    studio.getTeam.mockImplementation(async (id: string) => (id === "team-2" ? { ...TEAM_1, id, name: "Ẩm thực", role: null, isMember: false } : { ...TEAM_1, id }));
    mount("/t/team-2");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Bạn đang xem với quyền admin");
    expect(within(screen.getByRole("navigation", { name: "Vị trí" })).getByText("Ẩm thực")).toBeInTheDocument();
    // an admin makes projects in any team
    expect(screen.getAllByRole("button", { name: /Dự án mới/ }).length).toBeGreaterThan(0);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Nhóm" }));
    expect(await screen.findByText("Nhóm của tôi")).toBeInTheDocument();
    expect(screen.getByText("Nhóm khác")).toBeInTheDocument();
  });

  it("a member sees no admin note and no 'other teams'", async () => {
    mount("/t/team-1");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Nhóm" }));
    expect(await screen.findByRole("button", { name: "Quản lý nhóm" })).toBeInTheDocument();
    expect(screen.queryByText("Nhóm khác")).toBeNull();
  });

  it("the team picker searches every team through the API, past the first page, and names a team it has not listed", async () => {
    studio.getMe.mockResolvedValue({ userId: "admin", isAdmin: true });
    studio.listTeams.mockImplementation(async (params?: { q?: string }) => (params?.q
      ? { items: [{ id: "team-205", name: "Huế xưa", role: null, isMember: false }], total: 1, page: 1, pageSize: 50 }
      : { items: [{ id: "team-1", name: "Du lịch", role: "producer", isMember: true }], total: 240, page: 1, pageSize: 100 }));
    studio.getTeam.mockImplementation(async (id: string) => (id === "team-300" ? { ...TEAM_1, id, name: "Miền Tây", role: null, isMember: false } : { ...TEAM_1, id }));
    mount("/t/team-300");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    // a team beyond the first page: its name comes from GET /teams/:id
    expect(within(screen.getByRole("navigation", { name: "Vị trí" })).getByText("Miền Tây")).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Nhóm" });
    fireEvent.mouseDown(picker);
    expect(await screen.findByText("Gõ tên để tìm trong cả 240 nhóm")).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "Huế" } });
    await waitFor(() => expect(studio.listTeams).toHaveBeenCalledWith({ q: "Huế", page: 1, pageSize: 50 }));
    fireEvent.click(await screen.findByText("Huế xưa"));
    await waitFor(() => expect(ws.listProjects).toHaveBeenCalledWith("team-205"));
  });

  it("lists a team's projects as a table or cards, found by name and sorted", async () => {
    localStorage.removeItem("studio.projects.viewMode");
    ws.listProjects.mockResolvedValueOnce({ projects: [
      { ...project, videoCount: 2, lastActivityAt: "2026-10-10T08:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" },
      { ...project, id: "p2", name: "Ẩm thực Huế", channelUrl: null, description: "", videoCount: 9, lastActivityAt: "2026-10-11T08:00:00.000Z", createdAt: "2026-09-05T00:00:00.000Z", createdBy: BINH.userId, creator: BINH },
    ] });
    mount("/t/team-1");
    expect(await screen.findByText("Du lịch chậm")).toBeInTheDocument();
    // a table first; a sticky header is a table of its own above the rows
    await screen.findAllByRole("table");
    const table = document.querySelector<HTMLElement>(".ws-page .ant-table-sticky-holder")!.closest<HTMLElement>(".ant-table")!;
    expect(within(table).getByRole("link", { name: "Ẩm thực Huế" })).toHaveAttribute("href", "/p/p2");
    expect(within(table).getByText("@dulichcham")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Người tạo" })).toBeInTheDocument();
    expect(within(table).getByText("An Nguyễn")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Lưới"));
    expect([...document.querySelectorAll(".ws-card__title")].map((e) => e.textContent)).toEqual(["Ẩm thực Huế", "Du lịch chậm"]);
    expect(localStorage.getItem("studio.projects.viewMode")).toBe("grid");
    // who made each: the name, else the email
    expect([...document.querySelectorAll(".ws-card .ws-creator__name")].map((e) => e.textContent)).toEqual(["binh@ant-group.net", "An Nguyễn"]);
    fireEvent.click(screen.getByText("Do tôi tạo"));
    await waitFor(() => expect([...document.querySelectorAll(".ws-card__title")].map((e) => e.textContent)).toEqual(["Du lịch chậm"]));
    fireEvent.click(screen.getByText("Tất cả"));
    fireEvent.change(screen.getByLabelText("Tìm dự án theo tên, kênh, mô tả"), { target: { value: "phố cổ" } });
    expect([...document.querySelectorAll(".ws-card__title")].map((e) => e.textContent)).toEqual(["Du lịch chậm"]);
  });

  it("someone in no team yet makes one from the home page", async () => {
    studio.listTeams.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    mount("/");
    expect(await screen.findByRole("heading", { name: "Bạn chưa ở nhóm nào" })).toBeInTheDocument();
    studio.listTeams.mockResolvedValue({ items: [{ id: "team-new", name: "Ẩm thực", role: "owner" }], total: 1, page: 1, pageSize: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Tạo nhóm" }));
    const dialog = await screen.findByRole("dialog", { name: "Nhóm mới" });
    fireEvent.change(within(dialog).getByLabelText("Tên nhóm"), { target: { value: "Ẩm thực" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo nhóm" }));
    await waitFor(() => expect(studio.createTeam).toHaveBeenCalledWith("Ẩm thực"));
    await waitFor(() => expect(ws.listProjects).toHaveBeenCalledWith("team-new"));
  });

  it("opens on the channel's chat, with its chats, its videos and its files", async () => {
    mount("/p/p1");
    // the first render of the whole page: slower when the repo's suites run side by side
    expect(await screen.findByRole("heading", { name: "Kế hoạch" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Nghiên cứu kênh giúp tôi")).toBeInTheDocument();
    // the turn's work folds into one line over its answer; it unfolds to the steps
    expect(screen.queryByText("đọc file")).toBeNull();
    expect(screen.queryByText("Tôi sẽ đọc tài liệu.")).toBeNull();
    const work = screen.getByRole("button", { name: "Đã làm 1 bước · 1 phút 20 giây" });
    expect(work).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(work);
    expect(screen.getByText("đọc file")).toBeInTheDocument();
    expect(screen.getByText("Tôi sẽ đọc tài liệu.")).toBeInTheDocument();
    expect(screen.getAllByText("Huế mưa").length).toBeGreaterThan(0);
    expect(ws.getThread).toHaveBeenCalledWith("t-kenh");
    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    fireEvent.click(screen.getByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "Ghi chú" })).toBeInTheDocument();
  });

  it("the breadcrumb is the team, then the project (each a switch), then the video; the team's name shows once", async () => {
    ws.getThread.mockResolvedValue({ ...thread([]), id: "t-v2", videoId: "v2", kind: "video", title: "Huế mưa" });
    ws.listProjects.mockResolvedValue({ projects: [
      { ...project, videoCount: 2, lastActivityAt: NOW },
      { ...project, id: "p2", name: "Ẩm thực Huế", videoCount: 0, lastActivityAt: NOW },
    ] });
    mount("/p/p1/v/v2");
    const crumbs = await screen.findByRole("navigation", { name: "Vị trí" });
    await waitFor(() => expect(within(crumbs).getByText("Du lịch chậm")).toBeInTheDocument());
    expect(within(crumbs).getAllByText("Du lịch")).toHaveLength(1);
    expect(within(crumbs).getByText("Huế mưa")).toBeInTheDocument();
    expect(within(crumbs).getByRole("combobox", { name: "Nhóm" })).toBeInTheDocument();
    const picker = within(crumbs).getByRole("combobox", { name: "Dự án" });
    fireEvent.mouseDown(picker);
    fireEvent.change(picker, { target: { value: "ẩm" } });
    fireEvent.click(await screen.findByText("Ẩm thực Huế", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(ws.getProject).toHaveBeenCalledWith("p2"));
    // back to the team's list from the project switch
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Dự án" }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Mọi dự án của nhóm" }));
    expect(await screen.findByRole("heading", { name: "Dự án" })).toBeInTheDocument();
  });

  describe("renaming in place", () => {
    const nav = async () => screen.findByRole("navigation", { name: "Video của dự án" }, { timeout: 5000 });

    it("renames a chat from its ⋯: Enter saves and the nav shows the new name at once", async () => {
      let done!: (x: unknown) => void;
      ws.renameThread.mockReturnValue(new Promise((r) => { done = r; }));
      mount("/p/p1");
      const n = await nav();
      await within(n).findByText("Ý tưởng tháng 11");
      // the channel's chat keeps its name
      expect(within(n).queryByRole("button", { name: "Thao tác với “Kênh”" })).toBeNull();
      fireEvent.click(within(n).getByRole("button", { name: "Thao tác với “Ý tưởng tháng 11”" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Đổi tên/ }));
      const box = within(n).getByRole("textbox", { name: "Tên chat" });
      expect(box).toHaveValue("Ý tưởng tháng 11");
      fireEvent.change(box, { target: { value: "  Ý tưởng tháng 12 " } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(ws.renameThread).toHaveBeenCalledWith("t-free", "Ý tưởng tháng 12"));
      expect(await within(n).findByText("Ý tưởng tháng 12")).toBeInTheDocument();
      expect(ws.renameThread).toHaveBeenCalledTimes(1);
      done({});
    });

    it("Esc and an empty name save nothing", async () => {
      mount("/p/p1");
      const n = await nav();
      fireEvent.doubleClick(await within(n).findByText("Ý tưởng tháng 11"));
      let box = within(n).getByRole("textbox", { name: "Tên chat" });
      fireEvent.change(box, { target: { value: "Khác" } });
      fireEvent.keyDown(box, { key: "Escape" });
      expect(within(n).queryByRole("textbox")).toBeNull();
      fireEvent.doubleClick(within(n).getByText("Ý tưởng tháng 11"));
      box = within(n).getByRole("textbox", { name: "Tên chat" });
      fireEvent.change(box, { target: { value: "   " } });
      fireEvent.blur(box);
      expect(within(n).getByText("Ý tưởng tháng 11")).toBeInTheDocument();
      expect(ws.renameThread).not.toHaveBeenCalled();
    });

    it("renames a video on double-click, saved on leaving the box; refused, the old name comes back with a toast", async () => {
      ws.updateVideo.mockRejectedValueOnce(new StudioHttpError(403, { code: "forbidden", message: "Bạn không có quyền đổi tên video" }));
      mount("/p/p1");
      const n = await nav();
      fireEvent.doubleClick(await within(n).findByText("Huế mưa"));
      const box = within(n).getByRole("textbox", { name: "Tên video" });
      fireEvent.change(box, { target: { value: "Huế nắng" } });
      fireEvent.blur(box);
      await waitFor(() => expect(ws.updateVideo).toHaveBeenCalledWith("v2", { title: "Huế nắng" }));
      expect(await screen.findByText("Bạn không có quyền đổi tên video")).toBeInTheDocument();
      await waitFor(() => expect(within(n).getByText("Huế mưa")).toBeInTheDocument());
      expect(within(n).queryByText("Huế nắng")).toBeNull();
    });

    it("a producer renames the project; the header's switch follows", async () => {
      ws.updateProject.mockImplementationOnce(async () => {
        ws.listProjects.mockResolvedValue({ projects: [{ ...project, name: "Đi chậm", videoCount: 2, lastActivityAt: NOW }] });
        return { ...project, name: "Đi chậm" };
      });
      mount("/p/p1");
      const n = await nav();
      fireEvent.click(await within(n).findByRole("button", { name: "Đổi tên dự án" }));
      const box = within(n).getByRole("textbox", { name: "Tên dự án" });
      fireEvent.change(box, { target: { value: "Đi chậm" } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(ws.updateProject).toHaveBeenCalledWith("p1", { name: "Đi chậm" }));
      expect(await within(n).findByText("Đi chậm")).toBeInTheDocument();
      const crumbs = screen.getByRole("navigation", { name: "Vị trí" });
      await waitFor(() => expect(within(crumbs).getByText("Đi chậm")).toBeInTheDocument());
      ws.listProjects.mockResolvedValue({ projects: [{ ...project, videoCount: 2, lastActivityAt: NOW }] });
    });

    it("an editor renames chats and videos but not the project; a viewer renames nothing", async () => {
      studio.getTeam.mockImplementation(async (id: string) => ({ ...TEAM_1, id, role: "editor" }));
      mount("/p/p1");
      let n = await nav();
      expect(await within(n).findByRole("button", { name: "Thao tác với “Huế mưa”" })).toBeInTheDocument();
      expect(within(n).queryByRole("button", { name: "Đổi tên dự án" })).toBeNull();
      fireEvent.doubleClick(within(n).getByText("Du lịch chậm"));
      expect(within(n).queryByRole("textbox")).toBeNull();
      cleanup();
      studio.getTeam.mockImplementation(async (id: string) => ({ ...TEAM_1, id, role: "viewer" }));
      mount("/p/p1");
      n = await nav();
      await within(n).findByText("Huế mưa");
      expect(within(n).queryByRole("button", { name: /Thao tác với/ })).toBeNull();
      fireEvent.doubleClick(within(n).getByText("Huế mưa"));
      expect(within(n).queryByRole("textbox")).toBeNull();
    });
  });

  it("a new video's empty chat tells what to say, naming the AI", async () => {
    ws.getThread.mockResolvedValue({ ...thread([]), id: "t-v2", videoId: "v2", kind: "video", title: "Huế mưa" });
    mount("/p/p1/v/v2");
    expect(await screen.findByText("Bắt đầu video này: kể Claude nghe video về gì, dùng footage nào, dài bao lâu.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/\{\{ai\}\}/)).toBeNull();
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

  it("keeps the folder tree beside an open file: the file is marked, another opens from it, the tree hides", async () => {
    localStorage.removeItem("studio.files.tree");
    mount("/p/p1?tab=files&file=context%2Fnotes.md");
    expect(await screen.findByRole("heading", { name: "Ghi chú" })).toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "Tệp và cài đặt" });
    const tree = await within(aside).findByRole("list", { name: "Tệp của dự án" });
    expect(within(tree).getByRole("button", { name: "notes.md" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(tree).getByRole("button", { name: "CLAUDE.md" }));
    expect(await screen.findByRole("heading", { name: "Du lịch chậm" })).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole("button", { name: "Ẩn cây thư mục" }));
    expect(within(aside).queryByRole("list", { name: "Tệp của dự án" })).toBeNull();
    expect(localStorage.getItem("studio.files.tree")).toBe("hidden");
    fireEvent.click(within(aside).getByRole("button", { name: "Hiện cây thư mục" }));
    expect(within(aside).getByRole("list", { name: "Tệp của dự án" })).toBeInTheDocument();
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

  it("shows one proposed lesson and the rest on demand", async () => {
    const lesson = (id: string, text: string) => ({ id, project_id: "p1", thread_id: "t-kenh", text, status: "proposed", decided_by: null, decided_at: null, created_at: "" });
    ws.listLessons.mockResolvedValueOnce({ lessons: [lesson("l1", "Không dùng nhạc buồn."), lesson("l2", "Chữ to hơn."), lesson("l3", "Mở đầu bằng cảnh rộng.")] });
    mount("/p/p1");
    const lessons = await screen.findByRole("region", { name: "Bài học đề xuất từ chat này" });
    expect(await within(lessons).findByText("Không dùng nhạc buồn.")).toBeInTheDocument();
    expect(within(lessons).queryByText("Chữ to hơn.")).toBeNull();
    const more = within(lessons).getByRole("button", { name: "Xem tất cả (3)" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(within(lessons).getByText("Chữ to hơn.")).toBeInTheDocument();
    expect(within(lessons).getByText("Mở đầu bằng cảnh rộng.")).toBeInTheDocument();
    fireEvent.click(within(lessons).getByRole("button", { name: "Thu gọn" }));
    expect(within(lessons).queryByText("Mở đầu bằng cảnh rộng.")).toBeNull();
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
  describe("suggestions fit the page", () => {
    const chips = () => [...document.querySelectorAll(".ws-suggestions--steps button")].map((b) => b.textContent);
    const VIDEO_THREAD = { ...thread([]), id: "t-v2", videoId: "v2", kind: "video", title: "Huế mưa" };
    const FREE_THREAD = { ...thread([]), id: "t-free", title: "Ý tưởng tháng 11" };
    const cases: { name: string; path: string; thread: unknown; playbook: unknown; chips: string[]; hint: RegExp }[] = [
      {
        name: "a new channel: research", path: "/p/p1", thread: thread([]),
        playbook: { custom: false, issues: [], scope: "project", project: CHANNEL_NEW, video: null, next: [{ scope: "project", key: "research" }], projectOpen: 3 },
        chips: ["Nghiên cứu thị trường"], hint: /^Chat với Claude về kênh/,
      },
      {
        name: "a channel with its research: the strategy", path: "/p/p1", thread: thread([]),
        playbook: { custom: false, issues: [], scope: "project", project: CHANNEL_RESEARCHED, video: null, next: [{ scope: "project", key: "channel" }], projectOpen: 2 },
        chips: ["Chiến lược kênh"], hint: /^Chat với Claude về kênh/,
      },
      {
        name: "a free chat of the project: the channel's steps", path: "/p/p1/c/t-free", thread: FREE_THREAD,
        playbook: { custom: false, issues: [], scope: "project", project: CHANNEL_RESEARCHED, video: null, next: [{ scope: "project", key: "channel" }], projectOpen: 2 },
        chips: ["Chiến lược kênh"], hint: /^Chat tự do với Claude trong dự án/,
      },
      {
        name: "a new video: its brief, not the channel's research", path: "/p/p1/v/v2", thread: VIDEO_THREAD,
        playbook: { custom: false, issues: [], scope: "video", project: CHANNEL_NEW, video: videoSteps({}), next: [{ scope: "video", key: "brief" }], projectOpen: 3 },
        chips: ["Ý tưởng & brief"], hint: /^Bắt đầu video này/,
      },
      {
        name: "a video, from an older API that mixed the channel's steps in: the video's only", path: "/p/p1/v/v2", thread: VIDEO_THREAD,
        playbook: { custom: false, issues: [], project: CHANNEL_NEW, video: videoSteps({}), next: [{ scope: "project", key: "research" }, { scope: "video", key: "brief" }] },
        chips: ["Ý tưởng & brief"], hint: /^Bắt đầu video này/,
      },
      {
        name: "a prepared video: pick the scenes", path: "/p/p1/v/v2", thread: VIDEO_THREAD,
        playbook: { custom: false, issues: [], scope: "video", project: CHANNEL_RESEARCHED, video: videoSteps({ brief: "done", prepare: "done" }), next: [{ scope: "video", key: "scenes" }], projectOpen: 2 },
        chips: ["Chọn cảnh"], hint: /^Video đã có brief/,
      },
      {
        name: "a video with its timeline: preview and the YouTube kit, which waits on the channel's branding", path: "/p/p1/v/v2", thread: VIDEO_THREAD,
        playbook: {
          custom: false, issues: [], scope: "video", project: CHANNEL_RESEARCHED,
          video: videoSteps({ brief: "done", prepare: "done", scenes: "done", timeline: "done" }, { "youtube-kit": { outsideRequires: ["branding"] } }),
          next: [{ scope: "video", key: "preview" }, { scope: "video", key: "youtube-kit" }], projectOpen: 2,
        },
        chips: ["Xem trước", "Gói YouTube · kênh chưa có Branding"], hint: /^Video đã có brief/,
      },
      {
        name: "a finished video: nothing to suggest", path: "/p/p1/v/v2", thread: VIDEO_THREAD,
        playbook: {
          custom: false, issues: [], scope: "video", project: CHANNEL_RESEARCHED,
          video: videoSteps({ brief: "done", prepare: "done", scenes: "done", timeline: "done", preview: "done", "youtube-kit": "done", final: "done" }), next: [], projectOpen: 2,
        },
        chips: [], hint: /^Video đã có bản cuối/,
      },
    ];

    it.each(cases)("$name", async (c) => {
      ws.getThread.mockResolvedValue(c.thread);
      ws.getPlaybook.mockResolvedValue(c.playbook);
      mount(c.path);
      expect(await screen.findByText(c.hint, {}, { timeout: 5000 })).toBeInTheDocument();
      await waitFor(() => expect(ws.getPlaybook).toHaveBeenCalled());
      await waitFor(() => expect(chips()).toEqual(c.chips));
    });

    it("a step waiting on the channel says so when opened; a video's rail counts the channel's open steps", async () => {
      ws.getThread.mockResolvedValue(VIDEO_THREAD);
      ws.getPlaybook.mockResolvedValue(cases[6]!.playbook);
      mount("/p/p1/v/v2");
      const rail = await screen.findByRole("navigation", { name: "Các bước gợi ý" }, { timeout: 5000 });
      expect(rail).toHaveTextContent("Kênh còn 2 bước chưa xong");
      fireEvent.click(within(rail).getByRole("button", { name: /Gói YouTube/ }));
      expect(await screen.findByText(/^Kênh chưa xong: Branding/)).toBeInTheDocument();
    });

    it("names the default steps in the UI language; a step the project wrote itself keeps its words", async () => {
      await i18n.changeLanguage("en");
      try {
        ws.getThread.mockResolvedValue(VIDEO_THREAD);
        const own = videoSteps({ brief: "done", prepare: "done", scenes: "done", timeline: "done" }, {
          "youtube-kit": { outsideRequires: ["branding"] }, preview: { title: "Duyệt bản nháp" },
        });
        ws.getPlaybook.mockResolvedValue({ custom: true, issues: [], scope: "video", project: CHANNEL_RESEARCHED, video: own, next: [{ scope: "video", key: "preview" }, { scope: "video", key: "youtube-kit" }], projectOpen: 2 });
        mount("/p/p1/v/v2");
        const rail = await screen.findByRole("navigation", { name: "Suggested steps" }, { timeout: 5000 });
        expect(within(rail).getByRole("button", { name: /Idea & brief/ })).toBeInTheDocument();
        await waitFor(() => expect(chips()).toEqual(["Duyệt bản nháp", "YouTube kit · channel has no Branding yet"]));
      } finally {
        await i18n.changeLanguage("vi");
      }
    });
  });
});
