import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import type { ChatThreadView } from "../../api/studio-client";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const client = {
  getProductionCatalog: vi.fn().mockResolvedValue(null),
  getProduction: vi.fn().mockResolvedValue({ id: "p", episodeTargetSeconds: 60 }),
  saveManualEdit: vi.fn().mockResolvedValue({}),
  submitApprovePlan: vi.fn(),
  getAssetMedia: vi.fn().mockResolvedValue(null),
};
vi.mock("../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { ManualEditDrawer, HAND_EDITABLE } = await import("./ManualEditDrawer");

const plan = {
  schema_version: "studio.series-plan/v1", series_title: "Kyoto", rationale: "Ba cung đường",
  episodes: [{ idx: 1, title: "Rừng tre", hook: "Sáng sớm", logline: "Đi bộ", target_seconds: 60, items: [{ asset_id: "a1", reason: "đẹp", section_title: null }], alternates: [], texts_suggested: [] }],
};

describe("ManualEditDrawer", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("only documents with an editor can be edited by hand", () => {
    expect([...HAND_EDITABLE].sort()).toEqual(["branding", "rnd", "series_plan"]);
  });

  it("saving the plan adds a version to the chat and approves nothing", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const thread: ChatThreadView = {
      turns: [], scope: { productionId: "p", episodeId: null, runId: "r", stageKey: "approve-plan", scope: "gate" }, blocked: null,
      current: { turnId: null, document: plan, draft: plan, pendingApply: false, problems: [] }, queueAhead: 0,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AntApp><ManualEditDrawer open onClose={onClose} productionId="p" thread={thread} onSaved={onSaved} /></AntApp>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Lưu thành bản mới" }));
    await waitFor(() => expect(client.saveManualEdit).toHaveBeenCalledWith("p", { stageKey: "approve-plan", episodeId: undefined, document: plan }));
    expect(client.submitApprovePlan).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
