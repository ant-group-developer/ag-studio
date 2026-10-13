import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { JobView, RenderLink, RenderView, TeamRoleName } from "../../api/workspace-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const done = new Date().toISOString();
const r = (over: Partial<RenderView>): RenderView => ({
  jobId: "j1", kind: "render_preview", revision: 3, durationS: 65, width: 1920, height: 1080, watermarked: true, sizeBytes: 12_582_912, note: "",
  finishedAt: done, ...over,
});
const never = () => new Promise<never>(() => {});
const ws = {
  getTimeline: vi.fn(),
  listRenders: vi.fn(),
  renderLink: vi.fn(),
  startRender: vi.fn().mockResolvedValue({}),
  fitTimeline: vi.fn().mockResolvedValue({}),
  cancelJob: vi.fn(),
};
vi.mock("../../api/workspace-client", async (orig) => ({ ...(await orig<object>()), useWorkspaceClient: () => ws }));
const { VideoPanel, jobsToShow } = await import("./VideoPanel");

const ORDER: TeamRoleName[] = ["viewer", "editor", "producer", "owner"];
const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AntApp>{node}</AntApp></QueryClientProvider>,
);
const editor = (n: TeamRoleName) => ORDER.indexOf("editor") >= ORDER.indexOf(n);
const producer = (n: TeamRoleName) => ORDER.indexOf("producer") >= ORDER.indexOf(n);
const links = (byJob: Record<string, Omit<RenderLink, "jobId">>) => (_v: string, jobId: string) => Promise.resolve({ jobId, ...(byJob[jobId] ?? { url: `https://r2.test/${jobId}.mp4` }) });

describe("video preview tab", { timeout: 20_000 }, () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    ws.getTimeline.mockResolvedValue({ latest: { revision: 3, label: "fit", approx_seconds: 64.6, clips: [{}, {}], texts: [], narration: { voice: "tts", lines: [{ line_id: "L001", text: "x" }] }, music: null, issues: [] }, revisions: [] });
    ws.listRenders.mockResolvedValue({ renders: [r({}), r({ jobId: "j2", kind: "export_premiere", durationS: null }), r({ jobId: "j3", revision: 2 })], jobs: [], thumbnails: [] });
    ws.renderLink.mockImplementation(links({}));
  });

  it("shows the timeline and the renders at once, each when it arrives, while the player waits for its link", async () => {
    ws.listRenders.mockImplementation(never);
    ws.renderLink.mockImplementation(never);
    const first = wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    expect(await screen.findByText("bản 3 · fit · 2 clip · ≈ 1:05 · 1 câu lời dẫn")).toBeInTheDocument();
    first.unmount();
    ws.getTimeline.mockImplementation(never);
    ws.listRenders.mockResolvedValue({ renders: [r({}), r({ jobId: "j3", revision: 2 })], jobs: [], thumbnails: [] });
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    const list = await screen.findByRole("region", { name: "Bản render" });
    await waitFor(() => expect(list).toHaveTextContent("bản 3 · 1:05 · 12.0 MB · có watermark"));
    expect(screen.getByRole("status", { name: "Trình phát bản render" })).toHaveTextContent("Đang lấy link xem…");
    expect(ws.renderLink).toHaveBeenCalledTimes(1);
    expect(ws.renderLink).toHaveBeenCalledWith("v1", "j1");
  });

  it("plays the latest preview once its link comes, and starts renders and the fit", async () => {
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    await waitFor(() => expect(screen.getByLabelText("Trình phát bản render")).toHaveAttribute("src", "https://r2.test/j1.mp4"));
    await screen.findByText("bản 3 · fit · 2 clip · ≈ 1:05 · 1 câu lời dẫn");
    const list = screen.getByRole("region", { name: "Bản render" });
    expect(within(list).queryByRole("button", { name: /Render bản cuối/ })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Render xem trước/ }));
    await waitFor(() => expect(ws.startRender).toHaveBeenCalledWith("v1", { kind: "render_preview" }));
    fireEvent.click(screen.getByRole("button", { name: /Dựng lại từ kế hoạch/ }));
    await waitFor(() => expect(ws.fitTimeline).toHaveBeenCalledWith("v1"));
    // another render plays when picked
    fireEvent.click(within(list).getAllByRole("button", { name: "Xem" })[1]!);
    await waitFor(() => expect(screen.getByLabelText("Trình phát bản render")).toHaveAttribute("src", "https://r2.test/j3.mp4"));
  });

  it("says why a render has no link, in the player and on its row", async () => {
    ws.renderLink.mockImplementation(links({ j1: { url: null, urlHidden: "footage_scope" }, j3: { url: null, urlHidden: "footage_check_failed" } }));
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    const player = await screen.findByRole("status", { name: "Trình phát bản render" });
    await waitFor(() => expect(player).toHaveTextContent("bạn chưa có quyền xem footage này trên AG Go"));
    const list = screen.getByRole("region", { name: "Bản render" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("bạn chưa có quyền xem footage này trên AG Go");
    expect(within(rows[0]!).queryByRole("button", { name: "Tải về" })).toBeNull();
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Xem" }));
    await waitFor(() => expect(player).toHaveTextContent("chưa kiểm được quyền xem footage trên AG Go, tải lại sau ít phút"));
    expect(rows[2]).toHaveTextContent("chưa kiểm được quyền xem footage trên AG Go");
  });

  it("keeps the player on the link it has while the renders are polled", async () => {
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    await waitFor(() => expect(screen.getByLabelText("Trình phát bản render")).toHaveAttribute("src", "https://r2.test/j1.mp4"));
    ws.renderLink.mockImplementation(links({ j1: { url: "https://r2.test/j1.mp4?sig=2" } }));
    fireEvent.click(screen.getByRole("button", { name: /Dựng lại từ kế hoạch/ }));
    await waitFor(() => expect(ws.listRenders).toHaveBeenCalledTimes(2));
    expect(ws.renderLink).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Trình phát bản render")).toHaveAttribute("src", "https://r2.test/j1.mp4");
  });

  it("asks for a link when a download is clicked: a render opens in a new tab, a Premiere export is saved", async () => {
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.href); });
    const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    ws.renderLink.mockImplementation(links({ j2: { url: "https://r2.test/xuat.zip?sig=1" } }));
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={editor} />);
    const list = await screen.findByRole("region", { name: "Bản render" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(list).getAllByRole("listitem");
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Tải về" }));
    await waitFor(() => expect(tab.location.href).toBe("https://r2.test/j3.mp4"));
    expect(tab.opener).toBeNull();
    expect(ws.renderLink).toHaveBeenCalledWith("v1", "j3");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Tải về" }));
    await waitFor(() => expect(saved).toEqual(["https://r2.test/xuat.zip?sig=1"]));
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
    click.mockRestore();
  });

  it("a producer renders the final after confirming", async () => {
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={producer} />);
    await screen.findByText("bản 3 · fit · 2 clip · ≈ 1:05 · 1 câu lời dẫn"); // the render buttons wait for the timeline
    fireEvent.click(screen.getByRole("button", { name: /Render bản cuối/ }));
    const ok = await screen.findAllByRole("button", { name: "Render bản cuối" });
    fireEvent.click(ok[ok.length - 1]!);
    await waitFor(() => expect(ws.startRender).toHaveBeenCalledWith("v1", { kind: "render_final" }));
  });

  it("saves a Premiere export started here once it is done, and not the older ones", async () => {
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.href); });
    const zip = "https://r2.test/xuat.zip?sig=1";
    ws.startRender.mockResolvedValueOnce({ id: "j9", kind: "export_premiere", status: "queued" });
    ws.renderLink.mockImplementation(links({ j9: { url: zip }, j2: { url: "https://r2.test/cu.zip" } }));
    ws.listRenders.mockReset();
    ws.listRenders.mockResolvedValueOnce({ renders: [r({ jobId: "j2", kind: "export_premiere" })], jobs: [], thumbnails: [] })
      .mockResolvedValue({ renders: [r({ jobId: "j9", kind: "export_premiere" }), r({ jobId: "j2", kind: "export_premiere" })], jobs: [], thumbnails: [] });
    wrap(<VideoPanel projectId="p1" videoId="v1" atLeast={producer} />);
    await screen.findByText("bản 3 · fit · 2 clip · ≈ 1:05 · 1 câu lời dẫn");
    fireEvent.click(screen.getByRole("button", { name: /Xuất Premiere/ }));
    await waitFor(() => expect(ws.startRender).toHaveBeenCalledWith("v1", { kind: "export_premiere" }));
    await waitFor(() => expect(saved).toEqual([zip]));
    expect(ws.renderLink.mock.calls).toEqual([["v1", "j9"]]);
    fireEvent.click(screen.getByRole("button", { name: /Dựng lại từ kế hoạch/ }));
    await waitFor(() => expect(ws.listRenders.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(saved).toEqual([zip]);
    click.mockRestore();
  });
});

describe("jobs over the player", () => {
  const at = (m: number) => new Date(Date.parse("2026-10-13T00:00:00Z") + m * 60_000).toISOString();
  const job = (id: string, over: Partial<JobView>): JobView => ({
    id, projectId: "p", videoId: "v", threadId: null, kind: "render_preview", status: "failed", title: id, request: null, result: null, error: "farm",
    phase: null, progress: null, etaSeconds: null, nodeId: null, cancelRequested: false, createdBy: "u", createdAt: at(0), startedAt: at(0), finishedAt: at(1), ...over,
  });

  it("a failed render shows until a render of its kind works again or is tried again", () => {
    const failed = job("f", {});
    expect(jobsToShow([failed], []).map((j) => j.id)).toEqual(["f"]);
    expect(jobsToShow([failed], [r({ jobId: "ok", finishedAt: at(5) })])).toEqual([]);
    expect(jobsToShow([failed], [r({ jobId: "old", finishedAt: at(-5) })]).map((j) => j.id)).toEqual(["f"]);
    expect(jobsToShow([failed], [r({ jobId: "fin", kind: "render_final", finishedAt: at(5) })]).map((j) => j.id)).toEqual(["f"]);
    const retry = job("again", { status: "running", createdAt: at(3), finishedAt: null });
    expect(jobsToShow([retry, failed], []).map((j) => j.id)).toEqual(["again"]);
    const otherKind = job("fit", { kind: "fit", createdAt: at(3), finishedAt: at(4) });
    expect(jobsToShow([otherKind, failed], []).map((j) => j.id)).toEqual(["fit", "f"]);
  });
});
