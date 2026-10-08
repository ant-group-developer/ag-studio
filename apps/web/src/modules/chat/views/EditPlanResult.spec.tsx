import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { EditPlan } from "@harness/contracts";
import i18n from "../../../i18n/config";
import { EditPlanResult, shotChanges, shotStarts } from "./EditPlanResult";

const SRC = "src_01J0000000000000000000000A";
const shot = (order: number, id: string, inS: number, out: number, over: Partial<EditPlan["shots"][number]> = {}): EditPlan["shots"][number] => ({
  order, shot_id: id, source_id: SRC, in: inS, out, line_id: null, transition: "cut", section_title: null, note: "", ...over,
});
const v1: EditPlan = {
  schema_version: "studio.edit-plan/v1", episode_id: "e", narration: "tts", language: "vi", target_seconds: 60,
  shots: [shot(1, "s000-000", 0, 4, { line_id: "L001" }), shot(2, "s000-001", 5, 9, { transition: "dissolve" }), shot(3, "s000-002", 10, 13)],
  lines: [{ line_id: "L001", text: "Phố cổ Hoa Lư lúc chiều." }],
  texts: [{ text_id: "T001", kind: "title", text: "Hoa Lư", at_order: 2, offset_s: 0.5, duration: 3, position: "top_left" }],
  music_mood: "calm",
};
const v2: EditPlan = {
  ...v1,
  shots: [shot(1, "s000-000", 0, 4, { line_id: "L001" }), shot(2, "s000-001", 5, 7.5, { transition: "dissolve" }), shot(3, "s000-003", 14, 18, { line_id: "L002" })],
  lines: [{ line_id: "L001", text: "Phố cổ Hoa Lư khi chiều xuống." }, { line_id: "L002", text: "Đèn lồng lên dần." }],
};

describe("EditPlanResult", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });

  it("places each shot in the cut and tells what changed since the version before", () => {
    expect([...shotStarts(v1)]).toEqual([[1, 0], [2, 4], [3, 8]]);
    const c = shotChanges(v2, v1);
    expect([...c.added]).toEqual(["s000-003"]);
    expect([...c.moved.keys()]).toEqual(["s000-001"]);
    expect(c.removed.map((x) => x.shot_id)).toEqual(["s000-002"]);
    expect(shotChanges(v1, undefined).added.size).toBe(0);
  });

  it("shows the shots, the narration and the words on screen, old struck out and new marked, and the total", () => {
    const { container } = render(<EditPlanResult plan={v2} previous={v1} />);
    expect(screen.getByText("3 shot · 0:11 hình (mục tiêu 1:00) · có lời dẫn")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Vào–ra" })).toBeInTheDocument();
    expect(screen.getByText("5s–9s").tagName).toBe("DEL");
    expect(screen.getByText("s000-003").tagName).toBe("INS");
    expect(screen.getAllByText("s000-002")[0]!.tagName).toBe("DEL");
    expect(container.querySelectorAll(".chat-plan__row--changed")).toHaveLength(2);
    expect(screen.getByText("chuyển mờ")).toBeInTheDocument();
    expect(screen.getByText("Phố cổ Hoa Lư lúc chiều.").tagName).toBe("DEL");
    expect(screen.getByText("Phố cổ Hoa Lư khi chiều xuống.").tagName).toBe("INS");
    expect(screen.getByText("Đèn lồng lên dần.").tagName).toBe("INS");
    expect(screen.getByText("từ shot 3")).toBeInTheDocument();
    expect(screen.getByText("~0:05–0:08 · “Hoa Lư”")).toBeInTheDocument(); // shot 2 starts at 4 s, +0.5
  });

  it("a first version marks nothing", () => {
    const { container } = render(<EditPlanResult plan={v1} />);
    expect(container.querySelectorAll("ins, del")).toHaveLength(0);
  });
});
