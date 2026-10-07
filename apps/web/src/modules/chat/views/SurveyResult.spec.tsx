import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioSurvey } from "@harness/contracts";
import i18n from "../../../i18n/config";
import type { ChatThreadView, ChatTurn } from "../../../api/studio-client";

const SRC = "src_01J0000000000000000000000A";
const client = {
  getEpisodeShots: vi.fn().mockResolvedValue({
    state: "waiting", turnId: null,
    shots: ["s000-000", "s000-001", "s000-002"].map((id) => ({ shotId: id, sourceId: SRC, frameUrl: `https://r2/${id}.jpg` })),
  }),
  getEpisodeDocument: vi.fn().mockResolvedValue({ sources: [{ source_id: SRC, asset_id: "asset-1", title: "Phố cổ Hoa Lư" }] }),
  getAssetMedia: vi.fn().mockResolvedValue({ previewUrl: "https://ag-go/asset-1-720p.mp4" }),
  listEditorJobs: vi.fn().mockResolvedValue([]), getEditorJob: vi.fn(), getEpisode: vi.fn(),
};
vi.mock("../../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { SurveyResult, filterShots } = await import("./SurveyResult");
const { ResultPane } = await import("../ResultPane");

const row = (id: string, over: Partial<StudioSurvey["shots"][number]> = {}): StudioSurvey["shots"][number] => ({
  source_id: SRC, shot_id: id, in: 0, out: 4, score: 4, tags: ["phố", "đèn lồng"], usable: true, note: `Cảnh ${id}`, speech: "ambient", ...over,
});
const draft: StudioSurvey = {
  schema_version: "harness.survey-index/v2",
  shots: [row("s000-000", { usable: false, score: 1, note: "Loại: rung mạnh", in: 0, out: 3 }), row("s000-001", { in: 3, out: 9.5 }), row("s000-002", { in: 9.5, out: 14 })],
};
const kept: StudioSurvey = { ...draft, shots: draft.shots.map((r, i) => (i === 0 ? { ...r, usable: true, note: "giữ lại · rung nhẹ" } : r)) };
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe("SurveyResult", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("filters shots by kept / rejected / all", () => {
    expect(filterShots(draft.shots, "usable").map((r) => r.shot_id)).toEqual(["s000-001", "s000-002"]);
    expect(filterShots(draft.shots, "rejected").map((r) => r.shot_id)).toEqual(["s000-000"]);
    render(wrap(<SurveyResult productionId="p" episodeId="e" survey={draft} />));
    expect(screen.getByRole("button", { name: "Tất cả (3)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Loại: rung mạnh")).toBeInTheDocument();
    expect(screen.getAllByText("4/5 · dùng được")).toHaveLength(2);
    expect(screen.getByText("phố, đèn lồng · 6.5s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bị loại (1)" }));
    expect(screen.queryByText("s000-001")).toBeNull();
    expect(screen.getByText("s000-000")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dùng được (2)" }));
    expect(screen.queryByText("s000-000")).toBeNull();
  });

  it("marks a shot changed since the version before, shows frames, and plays a shot's piece of the 720p proxy", async () => {
    const { container } = render(wrap(<SurveyResult productionId="p" episodeId="e" survey={kept} previous={draft} />));
    const changed = container.querySelectorAll(".chat-shot--changed");
    expect(changed).toHaveLength(1);
    expect(within(changed[0] as HTMLElement).getByText("s000-000")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(3));
    expect(container.querySelector("img")).toHaveAttribute("src", "https://r2/s000-000.jpg");

    fireEvent.click(screen.getByRole("button", { name: "Xem shot s000-001" }));
    await waitFor(() => expect(container.querySelector("video")).toHaveAttribute("src", "https://ag-go/asset-1-720p.mp4#t=3,9.5"));
    expect(client.getAssetMedia).toHaveBeenCalledWith("p", "asset-1");
    expect(screen.getByText(/Phố cổ Hoa Lư · 3s–9.5s/)).toBeInTheDocument();
  });

  it("is the result column of approve-survey, with its version and Duyệt", () => {
    let k = 0;
    const turn = (over: Partial<ChatTurn>): ChatTurn => ({
      id: `t${++k}`, production_id: "p", episode_id: "e", run_id: "r", scope: "gate", stage_key: "approve-survey", turn: k, role: "assistant",
      text: "", mentions: [], context: null, proposal: null, action: null, status: "done", not_before: null, problems: [],
      llm_call_id: null, created_by: null, applied_at: null, created_at: "", updated_at: "", ...over,
    });
    const v2 = turn({ proposal: kept });
    const thread: ChatThreadView = {
      turns: [turn({ role: "user", text: "Giữ lại shot đầu" }), v2],
      scope: { productionId: "p", episodeId: "e", runId: "r", stageKey: "approve-survey", scope: "gate" }, blocked: null,
      current: { turnId: v2.id, document: kept, draft, pendingApply: false, problems: [] }, queueAhead: 0,
    };
    const onPrimary = vi.fn();
    render(wrap(<ResultPane productionId="p" episodeId="e" thread={thread} onPrimary={onPrimary} onMenu={vi.fn()} workflow="ag-studio-episode-cut@1.0.0" />));
    expect(screen.getByRole("heading", { name: "Chọn cảnh" })).toBeInTheDocument();
    expect(screen.getByText(/^Bản 2 · \d+ thay đổi$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(onPrimary).toHaveBeenCalledWith("approve");
  });
});
