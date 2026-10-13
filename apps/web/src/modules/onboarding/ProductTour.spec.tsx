/**
 * The first-visit tours: they point only at what the page shows (a button the role lacks is skipped), are marked seen
 * when closed, never run once seen; "Replay the quick tour" makes them unseen and opens a page that has one.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { wsEn } from "../../i18n/locales/ws.en";
import { wsVi } from "../../i18n/locales/ws.vi";
import type { Team, UserPrefs } from "../../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const UNSEEN: UserPrefs = { tourSeen: { projects: false, project: false }, checklistHidden: false };
const studio = {
  getPrefs: vi.fn(),
  updatePrefs: vi.fn(async (patch: { tourSeen?: Partial<UserPrefs["tourSeen"]> }) => ({ ...UNSEEN, tourSeen: { ...UNSEEN.tourSeen, ...patch.tourSeen } })),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));

const { ProductTour, TOUR_STOPS, useReplayTour } = await import("./ProductTour");

const TEAMS = [{ id: "team-1", name: "Du lịch", role: "producer", isMember: true }] as Team[];
function Replay() {
  const replay = useReplayTour(TEAMS);
  return <button type="button" onClick={replay}>replay</button>;
}

function mount(path = "/t/team-1") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/t/:teamId" element={(
            <div>
              <span data-tour="team">Nhóm</span>
              {/* no "new project" button: a viewer */}
              <span data-tour="guide">Hướng dẫn</span>
              <ProductTour kind="projects" ready />
            </div>
          )} />
          <Route path="/guide" element={<Replay />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProductTour", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    studio.getPrefs.mockResolvedValue(UNSEEN);
  });

  it("walks through what the page shows and is marked seen when finished", async () => {
    mount();
    expect(await screen.findByText("Nhóm của bạn")).toBeTruthy();
    // two stops shown: the team and the guide (no new project button here)
    expect(document.querySelectorAll(".ant-tour-indicator")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Tiếp|Next/ }));
    expect(await screen.findByText("Hướng dẫn", { selector: ".ant-tour-title" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hoàn thành|Kết thúc|Finish/ }));
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ tourSeen: { projects: true } }));
    expect(studio.updatePrefs).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Nhóm của bạn")).toBeNull());
  });

  it("is marked seen when closed early", async () => {
    mount();
    await screen.findByText("Nhóm của bạn");
    fireEvent.click(document.querySelector(".ant-tour-close")!);
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ tourSeen: { projects: true } }));
  });

  it("does not run once seen", async () => {
    studio.getPrefs.mockResolvedValue({ ...UNSEEN, tourSeen: { projects: true, project: false } });
    mount();
    await waitFor(() => expect(studio.getPrefs).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.queryByText("Nhóm của bạn")).toBeNull();
  });

  it("replay makes every tour unseen and opens the team's projects", async () => {
    studio.getPrefs.mockResolvedValue({ ...UNSEEN, tourSeen: { projects: true, project: true } });
    mount("/guide");
    fireEvent.click(screen.getByRole("button", { name: "replay" }));
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ tourSeen: { projects: false, project: false } }));
    expect(await screen.findByText("Nhóm của bạn")).toBeTruthy();
  });

  it("every stop has words in both languages", () => {
    const missing = (m: typeof wsVi.tour | typeof wsEn.tour) => (Object.keys(TOUR_STOPS) as (keyof typeof TOUR_STOPS)[])
      .flatMap((kind) => TOUR_STOPS[kind].filter((p) => {
        const w = (m[kind] as Record<string, { title?: string; description?: string } | undefined>)[p];
        return !w?.title || !w?.description;
      }).map((p) => `${kind}.${p}`));
    expect(missing(wsVi.tour)).toEqual([]);
    expect(missing(wsEn.tour)).toEqual([]);
  });
});
