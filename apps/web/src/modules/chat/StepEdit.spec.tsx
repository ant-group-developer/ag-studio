/**
 * Documents edited in place (plan 2026-10-07 step history): Sửa at a waiting gate saves a version, a step passed
 * opens again on the right, and saving an approved step asks: keep as the version in use, or reopen the step.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { EditPlan } from "@harness/contracts";
import type { ChatThreadView, StepDocView } from "../../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const trend = { schema_version: "studio.trend-report/v1", summary: "Phở sáng đang lên", working_angles: ["Quán lâu năm"], title_patterns: [], hook_patterns: [],
  thumbnail_patterns: [], recommended_duration_s: 600, posting_schedule: "", recommendations: [] };
const approved = (over: Partial<StepDocView> = {}): StepDocView => ({
  kind: "rnd", gate: "approve-rnd", state: "approved", document: trend, inUse: false,
  edit: { inPlace: true, inPlaceCode: null, reopen: true, reopenCode: null, replacesEpisodes: true, reruns: ["approve-rnd", "apply-rnd", "branding", "approve-plan", "spawn-episodes"] },
  ...over,
});
const client = {
  getStepDocument: vi.fn(),
  editStepDocument: vi.fn(),
  listEditorJobs: vi.fn().mockResolvedValue([]),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { ResultPane } = await import("./ResultPane");
const { StepPane } = await import("./StepPane");
const { reorderShots } = await import("./views/CutEditors");
const { setAt } = await import("./views/DocEditor");

const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AntApp>{node}</AntApp></QueryClientProvider>,
);

describe("editing a step's document", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("setAt copies along the path and keeps the rest", () => {
    const doc = { a: { b: 1, c: [1] }, d: 2 };
    const next = setAt(doc, "a.b", 5);
    expect(next).toEqual({ a: { b: 5, c: [1] }, d: 2 });
    expect(next.a.c).toBe(doc.a.c);
    expect(doc.a.b).toBe(1);
  });

  it("moving or removing a shot renumbers the cut and keeps each text on its shot", () => {
    const shot = (order: number, id: string) => ({ order, shot_id: id, source_id: "src_X", in: 0, out: 5, line_id: null, transition: "cut" as const, section_title: null, note: "" });
    const plan = { shots: [shot(1, "s000-000"), shot(2, "s000-001"), shot(3, "s000-002")],
      texts: [{ text_id: "T001", at_order: 3, text: "Cuối" }, { text_id: "T002", at_order: 2, text: "Giữa" }] } as unknown as EditPlan;
    const moved = reorderShots(plan, [plan.shots[2]!, plan.shots[0]!, plan.shots[1]!]);
    expect(moved.shots.map((x) => [x.order, x.shot_id])).toEqual([[1, "s000-002"], [2, "s000-000"], [3, "s000-001"]]);
    expect(moved.texts.map((x) => [x.text, x.at_order])).toEqual([["Cuối", 1], ["Giữa", 3]]);
    const removed = reorderShots(plan, [plan.shots[0]!, plan.shots[2]!]);
    expect(removed.texts.map((x) => [x.text, x.at_order])).toEqual([["Cuối", 2]]);
  });

  it("Sửa at a waiting gate turns the document into a form; Lưu sends the whole document", async () => {
    const onSaveEdit = vi.fn().mockResolvedValue({});
    const thread: ChatThreadView = {
      turns: [], scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "approve-trend-report", scope: "gate" }, blocked: null,
      current: { turnId: null, document: trend, draft: trend, pendingApply: false, problems: [] }, queueAhead: 0,
    };
    wrap(<ResultPane productionId="p" thread={thread} onPrimary={vi.fn()} onMenu={vi.fn()} onSaveEdit={onSaveEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Sửa" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tóm tắt" }), { target: { value: "Phở chiều" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Điều đang hiệu quả 1" }), { target: { value: "Quán mới" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(onSaveEdit).toHaveBeenCalledWith("approve-trend-report", { ...trend, summary: "Phở chiều", working_angles: ["Quán mới"] }));
    // back to the document once saved
    expect(await screen.findByRole("button", { name: "Sửa" })).toBeInTheDocument();
  });

  it("a passed step reads again; saving it asks — keep in use or reopen, saying the episodes are replaced", async () => {
    client.getStepDocument.mockResolvedValue(approved());
    client.editStepDocument.mockResolvedValue({ mode: "saved", warnings: [], view: approved({ inUse: true }) });
    const onBack = vi.fn();
    const onChanged = vi.fn();
    wrap(<StepPane productionId="p" step="rnd" canManage canEdit onBack={onBack} onChanged={onChanged} onOpenEditor={vi.fn()} />);
    expect(await screen.findByText("đã duyệt")).toBeInTheDocument();
    expect(client.getStepDocument).toHaveBeenCalledWith("p", "rnd", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Về bước hiện tại" }));
    expect(onBack).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sửa" }));
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Các tập hiện có sẽ bị thay/)).toBeInTheDocument();
    expect(within(dialog).getByText(/R&D → Branding → Kế hoạch tập → Dựng các tập/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Chỉ lưu" }));
    await waitFor(() => expect(client.editStepDocument).toHaveBeenCalledWith("p", "rnd", { document: trend, reopen: false, episodeId: undefined }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a step that cannot be edited now says why", async () => {
    client.getStepDocument.mockResolvedValue(approved({ kind: "series_plan", edit: { inPlace: false, inPlaceCode: "only_reopen", reopen: false, reopenCode: "episode_producing", replacesEpisodes: true, reruns: [] } }));
    wrap(<StepPane productionId="p" step="plan" canManage canEdit onBack={vi.fn()} onChanged={vi.fn()} onOpenEditor={vi.fn()} />);
    expect(await screen.findByText("Chưa sửa được: một tập đang sản xuất hoặc chờ duyệt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sửa" })).toBeNull();
  });
});
