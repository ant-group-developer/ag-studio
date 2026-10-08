import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/config";

const client = {
  getProductionAudio: vi.fn(), designVoice: vi.fn(), giveProductionAudio: vi.fn(), declineNarration: vi.fn(),
  removeProductionAudio: vi.fn(), setEpisodeNarration: vi.fn(),
};
vi.mock("../../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { ProductionAudioPanel } = await import("./ProductionAudioPanel");

const mount = (onChanged = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ProductionAudioPanel productionId="p" canEdit needsVoice onChanged={onChanged} />
  </QueryClientProvider>,
);

describe("ProductionAudioPanel: a machine voice", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("describes the voice, asks the farm to make it, and says it is being made", async () => {
    client.getProductionAudio.mockResolvedValue({ voice: null, music: null });
    const designing = { voice: { mode: "designing", instruct: "male, middle-aged, low pitch", requested_at: "", error: null }, music: null };
    client.designVoice.mockResolvedValue(designing);
    mount();
    fireEvent.click(await screen.findByText("Giọng máy"));
    expect(screen.getByText(/Không cần file mẫu/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Nam"));
    fireEvent.click(screen.getByLabelText("Trung niên"));
    fireEvent.click(screen.getByLabelText("Trầm"));
    fireEvent.click(screen.getByRole("button", { name: "Tạo giọng" }));
    await waitFor(() => expect(client.designVoice).toHaveBeenCalledWith("p", { gender: "male", age: "middle-aged", pitch: "low pitch" }));
    expect(await screen.findByText("Đang tạo giọng máy trên farm…")).toBeInTheDocument();
  });

  it("a voice the farm could not make says why", async () => {
    client.getProductionAudio.mockResolvedValue({ voice: { mode: "designing", instruct: "female, young adult, moderate pitch", requested_at: "", error: "farm không tạo được giọng: CUDA out of memory" }, music: null });
    mount();
    expect(await screen.findByText("Chưa tạo được giọng máy: farm không tạo được giọng: CUDA out of memory")).toBeInTheDocument();
  });

  it("a machine voice made: named as such, with its length", async () => {
    client.getProductionAudio.mockResolvedValue({ voice: {
      mode: "clone", origin: "synthetic", source: { kind: "design", instruct: "female, young adult, moderate pitch" }, duration_s: 7.2,
      reference_text: "Xin chào.", reference: "library:studio/p/voice/x.wav", listenUrl: "https://r2.test/x.wav",
    }, music: null });
    mount();
    expect(await screen.findByText("giọng máy · 7 giây")).toBeInTheDocument();
  });
});
