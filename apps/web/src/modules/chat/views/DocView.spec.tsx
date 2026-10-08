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
