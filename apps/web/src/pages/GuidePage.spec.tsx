/**
 * `/guide`: reached from the header's "Guide" link by everyone; every section with its anchor (the checklist's "How
 * to" targets), in both languages, the library's own name in place of {{site}}; replays the tour and brings back the
 * hidden checklist.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n/config";
import { guideEn } from "../i18n/locales/guide.en";
import { guideVi } from "../i18n/locales/guide.vi";
import type { UserPrefs } from "../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
const scrolled: string[] = [];
Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id); };

const PREFS: UserPrefs = { tourSeen: { projects: true, project: true }, checklistHidden: false };
const studio = {
  getMe: vi.fn().mockResolvedValue({ userId: "u", isAdmin: false }),
  listTeams: vi.fn().mockResolvedValue({ items: [{ id: "team-1", name: "Du lịch", role: "viewer", isMember: true }], total: 1, page: 1, pageSize: 100 }),
  getTeam: vi.fn(),
  getPrefs: vi.fn(),
  getOnboarding: vi.fn().mockResolvedValue({ steps: [], done: 7, total: 7, links: { teamId: null, projectId: null, video: null } }),
  updatePrefs: vi.fn(async (patch: Partial<UserPrefs>) => ({ ...PREFS, ...patch })),
};
vi.mock("../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));
vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => ({ user: { email: "a@b.c", name: "An" }, logout: vi.fn() }) }));

const { GuidePage, GUIDE_SECTIONS } = await import("./GuidePage");
const { GUIDE_SECTION } = await import("../modules/onboarding/use-onboarding");
const { WorkspaceShell } = await import("../modules/workspace/WorkspaceShell");

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function mount(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/queue" element={<WorkspaceShell><p>hàng đợi</p></WorkspaceShell>} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("GuidePage", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    scrolled.length = 0;
    studio.getPrefs.mockResolvedValue(PREFS);
  });

  it("opens from the header's Guide link, with every section and its anchor", async () => {
    mount("/queue");
    fireEvent.click(await screen.findByRole("link", { name: "Hướng dẫn" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hướng dẫn" })).toBeTruthy();
    const toc = screen.getByRole("navigation", { name: "Trên trang này" });
    expect(within(toc).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(GUIDE_SECTIONS.map((id) => `#${id}`));
    for (const id of GUIDE_SECTIONS) expect(document.getElementById(id)).not.toBeNull();
    // the library's own name, never a raw placeholder
    expect(screen.getByRole("heading", { level: 2, name: "Thêm footage từ AG Go" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\{\{|\*\*/);
    // lists and bold come from the locale's light markup
    expect(document.querySelector("#video ol")?.querySelectorAll("li").length).toBe(8);
    expect(document.querySelector("#teams strong")?.textContent).toBe("nhóm");
  });

  it("scrolls to the section in the link, and to one picked from the list", async () => {
    mount("/guide#footage");
    await screen.findByRole("heading", { level: 1, name: "Hướng dẫn" });
    expect(scrolled).toContain("footage");
    fireEvent.click(screen.getByRole("link", { name: "Lỗi thường gặp" }));
    expect(scrolled.at(-1)).toBe("problems");
  });

  it("brings back a hidden checklist", async () => {
    studio.getPrefs.mockResolvedValue({ ...PREFS, checklistHidden: true });
    mount("/guide");
    fireEvent.click(await screen.findByRole("button", { name: /Hiện lại danh sách Bắt đầu/ }));
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ checklistHidden: false }));
  });

  it("replays the quick tour on the team's projects", async () => {
    mount("/guide");
    await screen.findByRole("heading", { level: 1, name: "Hướng dẫn" });
    await waitFor(() => expect(studio.listTeams).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Xem lại hướng dẫn nhanh/ }));
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ tourSeen: { projects: false, project: false } }));
    expect((await screen.findByTestId("where")).textContent).toBe("/t/team-1");
  });

  it("every section has words in both languages, and every checklist step a section", () => {
    const sections = (m: typeof guideVi.sections | typeof guideEn.sections) =>
      GUIDE_SECTIONS.filter((id) => !m[id]?.title || !m[id]?.body);
    expect(sections(guideVi.sections)).toEqual([]);
    expect(sections(guideEn.sections)).toEqual([]);
    expect(Object.keys(guideVi.sections)).toEqual([...GUIDE_SECTIONS]);
    expect(Object.values(GUIDE_SECTION).filter((id) => !(GUIDE_SECTIONS as readonly string[]).includes(id))).toEqual([]);
  });
});
