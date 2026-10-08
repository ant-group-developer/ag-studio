import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioStyle } from "@harness/contracts";
import i18n from "../../../i18n/config";

const client = { getStyleFrames: vi.fn() };
vi.mock("../../../api/studio-client", async (orig) => ({ ...(await orig<object>()), useStudioClient: () => client }));
const { StyleEvidence } = await import("./StyleEvidence");

const style: StudioStyle = {
  schema_version: "studio.style/v1", skipped: false, skipped_reason: null, name: "Chậm", summary: "Cảnh dài.",
  references: [{ video_id: "U_17EqTHUIo", title: "Kyoto in the rain", channel_title: "Mei Time", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", duration_s: 1299 }],
  measured: { videos: 1, shots: 200, cuts_per_minute: 9, shot_seconds: { p25: 5, median: 6.5, p75: 8 }, first_shot_s: 2 },
  params: { cut_rhythm: "slow", shot_seconds: { min: 5, max: 8 }, transitions: ["cut"], opening: { seconds: 16, structure: "montage" },
    text_overlay: { density: "low", style: "serif" }, subtitles: "none", voice: "unknown", music: { mood: "", ducking: null }, visual: "", pace_notes: "" },
  do: [], dont: [], evidence: [{ param: "opening", video_id: "U_17EqTHUIo", t: 2.5, note: "montage" }],
};
const mount = (s: StudioStyle) => render(<QueryClientProvider client={new QueryClient()}><StyleEvidence productionId="p" style={s} /></QueryClientProvider>);

describe("StyleEvidence", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("shows each frame the style cites with what it shows, and links the reference videos", async () => {
    client.getStyleFrames.mockResolvedValue({ frames: [{ video_id: "U_17EqTHUIo", t: 2.5, url: "https://r2.test/f.jpg" }] });
    mount(style);
    expect((await screen.findByAltText("Khung opening tại 2.5 giây")).getAttribute("src")).toBe("https://r2.test/f.jpg");
    expect(client.getStyleFrames).toHaveBeenCalledWith("p", [{ video_id: "U_17EqTHUIo", t: 2.5 }]);
    expect(screen.getByRole("link", { name: "Kyoto in the rain" }).getAttribute("href")).toBe("https://www.youtube.com/watch?v=U_17EqTHUIo");
  });

  it("a skipped style says why, asking for no frame", async () => {
    client.getStyleFrames.mockClear();
    mount({ ...style, skipped: true, skipped_reason: "Chưa nhập kênh tham khảo", references: [], evidence: [] });
    expect(screen.getByText(/Không học được phong cách từ video mẫu: Chưa nhập kênh tham khảo/)).toBeInTheDocument();
    await waitFor(() => expect(client.getStyleFrames).not.toHaveBeenCalled());
  });
});
