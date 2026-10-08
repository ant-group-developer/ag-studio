import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../i18n/config";
import { DocView } from "./DocView";

const skipped = (summary: string) => ({
  schema_version: "studio.trend-report/v1", skipped: true, summary,
  working_angles: [], title_patterns: [], hook_patterns: [], thumbnail_patterns: [],
  recommended_duration_s: null, posting_schedule: "", recommendations: [],
});

describe("DocView of a skipped trend report", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("says why the research found nothing, under the note", () => {
    render(<DocView kind="trend_report" doc={skipped("Không có dữ liệu nghiên cứu: Chưa cấu hình YOUTUBE_API_KEY cho Studio worker")} />);
    expect(screen.getByText("Không có dữ liệu nghiên cứu YouTube cho series này; các bước sau tự đề xuất.")).toBeInTheDocument();
    expect(screen.getByText("Không có dữ liệu nghiên cứu: Chưa cấu hình YOUTUBE_API_KEY cho Studio worker")).toBeInTheDocument();
  });

  it("shows only the note when the report has no reason (older reports)", () => {
    const { container } = render(<DocView kind="trend_report" doc={skipped("Không có dữ liệu nghiên cứu.")} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("DocView of a branding with a text look (cut 1.1.0)", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("draws a sample in the look and says it in words; no look, no row", () => {
    const branding = (look?: unknown) => ({ series_name: "Phở Sáng", on_screen_text: { style: "", max_chars: 40, rules: [], ...(look ? { look } : {}) } });
    render(<DocView kind="branding" doc={branding({ text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "l" })} />);
    expect(screen.getByText("Kiểu chữ trên video")).toBeInTheDocument();
    expect(screen.getByText("Chữ #FFD166 trên hộp #1D3557, cỡ Lớn")).toBeInTheDocument();
    expect(screen.getByText("Tiêu đề mẫu")).toHaveStyle({ color: "#FFD166" });
    const { container } = render(<DocView kind="branding" doc={branding()} />);
    expect(container.textContent).not.toContain("Kiểu chữ trên video");
  });
});
