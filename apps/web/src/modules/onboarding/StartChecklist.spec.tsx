/**
 * The header's getting started checklist: n/7 from the API, each step with a way to its page and to the guide, hidden
 * when the person hides it or once every step is done; and where "Go to" leads when a place does not exist yet.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { wsEn } from "../../i18n/locales/ws.en";
import { wsVi } from "../../i18n/locales/ws.vi";
import type { OnboardingProgress, OnboardingStepKey, UserPrefs } from "../../api/studio-client";

const KEYS: OnboardingStepKey[] = ["team", "project", "footage", "video", "chat", "preview", "final"];
const LINKS = { teamId: "team-1", projectId: "p1", video: { projectId: "p1", videoId: "v2" } };
const progress = (done: number): OnboardingProgress => ({
  steps: KEYS.map((key, i) => ({ key, done: i < done, count: i < done ? 1 : 0 })), done, total: 7, links: LINKS,
});
const PREFS: UserPrefs = { tourSeen: { projects: true, project: true }, checklistHidden: false };
const studio = {
  getOnboarding: vi.fn(),
  getPrefs: vi.fn(),
  updatePrefs: vi.fn(async (patch: Partial<UserPrefs>) => ({ ...PREFS, ...patch })),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => studio }));

const { StartChecklist } = await import("./StartChecklist");
const { stepTarget, GUIDE_SECTION } = await import("./use-onboarding");

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><StartChecklist /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StartChecklist", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
  beforeEach(() => {
    vi.clearAllMocks();
    studio.getPrefs.mockResolvedValue(PREFS);
    studio.getOnboarding.mockResolvedValue(progress(3));
  });

  it("shows n/7 and opens the steps, each with Go there and How to", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Bắt đầu 3\/7/ }));
    expect(await screen.findByText("Vào hoặc tạo một nhóm")).toBeTruthy();
    expect(screen.getAllByLabelText("Đã xong")).toHaveLength(3);
    expect(screen.getAllByLabelText("Chưa làm")).toHaveLength(4);
    // a step's hint shows only while it is not done; the site's name stands in for {{site}}
    expect(screen.queryByText(/Nhóm giữ các dự án/)).toBeNull();
    expect(screen.getByText("Thêm footage từ AG Go")).toBeTruthy();
    const goTo = screen.getAllByRole("link", { name: "Đi tới" }).map((a) => a.getAttribute("href"));
    expect(goTo).toEqual(["/t/team-1", "/t/team-1", "/p/p1?tab=inputs", "/p/p1", "/p/p1/v/v2", "/p/p1/v/v2?tab=preview", "/p/p1/v/v2?tab=preview"]);
    const howTo = screen.getAllByRole("link", { name: "Xem cách làm" }).map((a) => a.getAttribute("href"));
    expect(howTo[2]).toBe("/guide#footage");
    expect(howTo[6]).toBe("/guide#renders");
  });

  it("hides for good when the person hides it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Bắt đầu 3\/7/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Ẩn" }));
    await waitFor(() => expect(studio.updatePrefs).toHaveBeenCalledWith({ checklistHidden: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Bắt đầu/ })).toBeNull());
  });

  it("shows nothing once every step is done", async () => {
    studio.getOnboarding.mockResolvedValue(progress(7));
    mount();
    await waitFor(() => expect(studio.getOnboarding).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Bắt đầu/ })).toBeNull();
  });

  it("does not even read the progress while hidden", async () => {
    studio.getPrefs.mockResolvedValue({ ...PREFS, checklistHidden: true });
    mount();
    await waitFor(() => expect(studio.getPrefs).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(studio.getOnboarding).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Bắt đầu/ })).toBeNull();
  });
});

describe("stepTarget", () => {
  it("leads to the step before when the place does not exist yet", () => {
    const none = { teamId: null, projectId: null, video: null };
    expect(KEYS.map((k) => stepTarget(k, none))).toEqual(["/", "/", "/", "/", "/", "/", "/"]);
    const team = { teamId: "t", projectId: null, video: null };
    expect(KEYS.map((k) => stepTarget(k, team))).toEqual(["/t/t", "/t/t", "/t/t", "/t/t", "/t/t", "/t/t", "/t/t"]);
    const project = { teamId: "t", projectId: "p", video: null };
    expect(KEYS.map((k) => stepTarget(k, project))).toEqual(["/t/t", "/t/t", "/p/p?tab=inputs", "/p/p", "/p/p", "/p/p", "/p/p"]);
  });

  it("every step has words in both languages and a guide section", () => {
    const words = (m: typeof wsVi.start.steps | typeof wsEn.start.steps) => KEYS.filter((k) => !m[k]?.title || !m[k]?.hint);
    expect(words(wsVi.start.steps)).toEqual([]);
    expect(words(wsEn.start.steps)).toEqual([]);
    expect(KEYS.filter((k) => !GUIDE_SECTION[k])).toEqual([]);
  });
});
