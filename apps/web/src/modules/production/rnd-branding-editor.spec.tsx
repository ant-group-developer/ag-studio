/**
 * RndEditor / BrandingEditor submit: the primary button sends the whole document, including schema_version and
 * the fields of folded panels (which validateFields alone leaves out), and says why when it can't send.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { StudioBranding, StudioRnd } from "@harness/contracts";
import "../../i18n/config";
import { RndEditor } from "./RndEditor";
import { BrandingEditor } from "./BrandingEditor";

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const rnd: StudioRnd = {
  schema_version: "studio.rnd/v1", summary: "Series phở sáng.",
  market: { opportunities: ["Lễ hội"], gaps: [], risks: [], competitors: [] },
  own_channels: null,
  footage_fit: { summary: "Nhiều cảnh phở", strong_themes: ["phở"], gaps: [] },
  direction: {
    description: "Mỗi tập một quán phở.", goal: "Người xem trẻ", audience: "18–30", tone: "Ấm áp", positioning: "Chân thật",
    content_pillars: [{ name: "Quán quen", description: "Quán lâu năm" }], episode_target_seconds: 300, max_episodes: 4,
    posting_schedule: "", keywords: ["Phở Hà Nội", "phở"], episode_ideas: [], notes: "Quay buổi sáng",
  },
};

const branding: StudioBranding = {
  schema_version: "studio.branding/v1", series_name: "Phở Sáng", tagline: "", positioning: "Chân thật",
  voice: { personality: [], do: [], dont: [], signature_phrases: [], banned_words: ["sốc"] },
  titles: { formulas: ["[Quán] — [điều bất ngờ]"], rules: [], examples: ["Phở Bát Đàn — xếp hàng từ 6 giờ"], max_chars: 40 },
  description: { opening: "", cta: "", hashtags: ["#PhởSáng"] },
  thumbnail: {
    concept: "Cận cảnh bát phở", text_rules: [], max_words: 3, text_case: "upper",
    palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "", do: [], dont: [],
  },
  on_screen_text: { style: "", max_chars: 40, rules: [] },
  music_mood: [],
};

describe("RndEditor", () => {
  it("approves with the whole document, folded panels and schema_version included", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    render(<App><RndEditor value={rnd} primaryLabel="Duyệt R&D" onSubmit={onSubmit} /></App>);
    fireEvent.click(screen.getByRole("button", { name: "Duyệt R&D" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toEqual(rnd);
  });

  it("lists the schema problems instead of doing nothing", async () => {
    const onSubmit = vi.fn();
    // footage_fit sits in a folded panel, so only the schema can catch its empty summary
    const bad = { ...rnd, footage_fit: { ...rnd.footage_fit, summary: "" } };
    render(<App><RndEditor value={bad} primaryLabel="Duyệt R&D" onSubmit={onSubmit} /></App>);
    fireEvent.click(screen.getByRole("button", { name: "Duyệt R&D" }));
    expect(await screen.findByText(/footage_fit\.summary/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("BrandingEditor", () => {
  it("approves with the whole document, folded panels and schema_version included", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    render(<App><BrandingEditor value={branding} primaryLabel="Duyệt branding" onSubmit={onSubmit} /></App>);
    fireEvent.click(screen.getByRole("button", { name: "Duyệt branding" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toEqual(branding);
  });

  it("cut 1.1.0: a look for the text on the video is switched on, chosen and sent; switched off it is not sent", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    render(<App><BrandingEditor value={branding} primaryLabel="Duyệt branding" onSubmit={onSubmit} /></App>);
    fireEvent.click(screen.getByText("Chữ trên hình"));
    fireEvent.click(await screen.findByRole("switch", { name: "Dùng kiểu chữ riêng" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Có hộp sau tiêu đề" }));
    fireEvent.change(screen.getByLabelText("Màu chữ"), { target: { value: "#ffd166" } });
    fireEvent.click(screen.getByRole("button", { name: "Duyệt branding" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].on_screen_text.look).toEqual({ text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "m" });

    fireEvent.click(screen.getByRole("switch", { name: "Dùng kiểu chữ riêng" }));
    fireEvent.click(screen.getByRole("button", { name: "Duyệt branding" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]![0].on_screen_text.look).toBeUndefined();
  }, 30_000);
});
