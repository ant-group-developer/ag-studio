import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/config";

const client = { listThumbnails: vi.fn(), getAssetMedia: vi.fn(), pickFootageThumbnail: vi.fn() };
vi.mock("../../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { KitThumbnails } = await import("./KitThumbnails");

const mount = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <KitThumbnails productionId="p" episodeId="e" canEdit ideas={[{ asset_id: "a1", text: "Lúa vàng" }]} />
  </QueryClientProvider>,
);

describe("KitThumbnails", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("offers each idea's video keyframes; a click picks that picture with the idea's words", async () => {
    client.listThumbnails.mockResolvedValue({ items: [], selectedId: null, footageHidden: false, canDraw: true, canCutFrames: false, framesPending: false, framesError: null });
    client.getAssetMedia.mockResolvedValue({ assetId: "a1", keyframes: [{ url: "https://ag-go.test/k1.jpg", tMs: 1200 }, { url: "https://ag-go.test/k2.jpg", tMs: 5400 }] });
    client.pickFootageThumbnail.mockResolvedValue({ id: "t1" });
    mount();
    expect(await screen.findByText("Chưa chọn: sau khi render, thumbnail lấy gợi ý đầu tiên.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Dùng khung giây 5 cho “Lúa vàng”" }));
    await waitFor(() => expect(client.pickFootageThumbnail).toHaveBeenCalledWith("p", "e", { assetId: "a1", keyframe: 1, text: "Lúa vàng" }));
  });

  it("shows nothing to someone outside the footage scope", async () => {
    client.listThumbnails.mockResolvedValue({ items: [], selectedId: null, footageHidden: true, canDraw: false, canCutFrames: false, framesPending: false, framesError: null });
    const { container } = mount();
    await waitFor(() => expect(client.listThumbnails).toHaveBeenCalled());
    expect(container.querySelector(".chat-kit-thumbs")).toBeNull();
  });
});
