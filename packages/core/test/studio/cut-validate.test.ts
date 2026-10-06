import { describe, expect, it } from "vitest";
import type { EditPlan, ShotsIndex, StudioSurvey } from "@harness/contracts";
import { studioSourceId } from "../../src/studio/render-plan.js";
import { validateEditPlan, validateStudioSurvey } from "../../src/studio/cut-validate.js";

const A = studioSourceId("a");
const B = studioSourceId("b");

function shots(): ShotsIndex {
  return {
    schema_version: "harness.shots/v2",
    sources: [
      { source_id: A, index: 0, file_name: `${A}.mp4`, duration_seconds: 30, has_audio: true, shots: [
        { shot_id: "s000-000", in: 0, out: 6 }, { shot_id: "s000-001", in: 6, out: 14 }, { shot_id: "s000-002", in: 14, out: 30 },
      ] },
      { source_id: B, index: 1, file_name: `${B}.mp4`, duration_seconds: 10, has_audio: false, shots: [{ shot_id: "s001-000", in: 0, out: 10 }] },
    ],
  };
}

function survey(): StudioSurvey {
  return {
    schema_version: "harness.survey-index/v2",
    shots: shots().sources.flatMap((s) => s.shots.map((x) => ({
      source_id: s.source_id, shot_id: x.shot_id, in: x.in, out: x.out, score: x.shot_id === "s000-001" ? 1 : 4,
      tags: ["phố"], usable: x.shot_id !== "s000-001", note: x.shot_id === "s000-001" ? "rung" : "đẹp", speech: "ambient" as const,
    }))),
  };
}

const codes = (r: { problems: { code: string }[]; warnings: { code: string }[] }) => ({ problems: r.problems.map((p) => p.code), warnings: r.warnings.map((w) => w.code) });

describe("validateStudioSurvey", () => {
  it("a row for every shot, in range, at least one usable: ok", () => {
    expect(validateStudioSurvey(survey(), { shots: shots() })).toMatchObject({ ok: true, problems: [] });
  });

  it("every shot must have exactly one row matching its source and range", () => {
    const s = survey();
    const missing = { ...s, shots: s.shots.slice(1) };
    expect(codes(validateStudioSurvey(missing, { shots: shots() })).problems).toContain("missing_shot");
    const twice = { ...s, shots: [...s.shots, s.shots[0]!] };
    expect(codes(validateStudioSurvey(twice, { shots: shots() })).problems).toContain("duplicate_shot");
    const unknown = { ...s, shots: [...s.shots, { ...s.shots[0]!, shot_id: "s009-000" }] };
    expect(codes(validateStudioSurvey(unknown, { shots: shots() })).problems).toContain("unknown_shot");
    const wrong = { ...s, shots: s.shots.map((x, i) => (i === 0 ? { ...x, source_id: B } : x)) };
    expect(codes(validateStudioSurvey(wrong, { shots: shots() })).problems).toContain("wrong_source");
    const moved = { ...s, shots: s.shots.map((x, i) => (i === 0 ? { ...x, out: 7 } : x)) };
    expect(codes(validateStudioSurvey(moved, { shots: shots() })).problems).toContain("shot_range");
    const none = { ...s, shots: s.shots.map((x) => ({ ...x, usable: false })) };
    expect(codes(validateStudioSurvey(none, { shots: shots() })).problems).toContain("none_usable");
    expect(codes(validateStudioSurvey({ schema_version: "x" }, { shots: shots() })).problems).toContain("schema");
  });
});

function plan(over: Partial<EditPlan> = {}): EditPlan {
  return {
    schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration: "tts", language: "vi", target_seconds: 14,
    shots: [
      { order: 1, shot_id: "s000-000", source_id: A, in: 1, out: 5, line_id: "L001", transition: "dissolve", section_title: null, note: "mở" },
      { order: 2, shot_id: "s001-000", source_id: B, in: 0, out: 4, line_id: null, transition: "cut", section_title: "Đền", note: "" },
      { order: 3, shot_id: "s000-002", source_id: A, in: 20, out: 26, line_id: "L002", transition: "cut", section_title: null, note: "" },
    ],
    lines: [{ line_id: "L001", text: "Phố cổ lúc chiều." }, { line_id: "L002", text: "Đền vua Đinh." }],
    texts: [{ text_id: "T001", kind: "title", text: "Hoa Lư", at_order: 1, offset_s: 0.5, duration: 3, position: "top_left" }],
    music_mood: "calm",
    ...over,
  };
}

describe("validateEditPlan", () => {
  it("usable shots in range, anchored lines, one title: ok", () => {
    expect(validateEditPlan(plan(), { survey: survey(), shots: shots() })).toMatchObject({ ok: true, problems: [], warnings: [] });
  });

  it("only usable shots of the approved selection, inside the shot, at least half a second", () => {
    const p = plan();
    const at = (i: number, x: Partial<EditPlan["shots"][number]>) => plan({ shots: p.shots.map((s, k) => (k === i ? { ...s, ...x } : s)) });
    expect(codes(validateEditPlan(at(0, { shot_id: "s000-001", in: 7, out: 9 }), { survey: survey(), shots: shots() })).problems).toContain("not_usable");
    expect(codes(validateEditPlan(at(0, { shot_id: "s009-000" }), { survey: survey(), shots: shots() })).problems).toContain("unknown_shot");
    expect(codes(validateEditPlan(at(0, { source_id: B }), { survey: survey(), shots: shots() })).problems).toContain("wrong_source");
    expect(codes(validateEditPlan(at(0, { out: 6.5 }), { survey: survey(), shots: shots() })).problems).toContain("outside_shot");
    expect(codes(validateEditPlan(at(0, { in: 1, out: 1.3 }), { survey: survey(), shots: shots() })).problems).toContain("too_short");
    expect(codes(validateEditPlan(at(1, { order: 5 }), { survey: survey(), shots: shots() })).problems).toContain("bad_order");
  });

  it("narration lines: anchored once, known, unique", () => {
    const p = plan();
    expect(codes(validateEditPlan(plan({ shots: p.shots.map((s, k) => (k === 1 ? { ...s, line_id: "L001" } : s)) }), { survey: survey(), shots: shots() })).problems).toContain("line_twice");
    expect(codes(validateEditPlan(plan({ shots: p.shots.map((s, k) => (k === 1 ? { ...s, line_id: "L009" } : s)) }), { survey: survey(), shots: shots() })).problems).toContain("unknown_line");
    expect(codes(validateEditPlan(plan({ lines: [...p.lines, p.lines[0]!] }), { survey: survey(), shots: shots() })).problems).toContain("duplicate_line");
    expect(codes(validateEditPlan(plan({ lines: [...p.lines, { line_id: "L003", text: "Thêm" }] }), { survey: survey(), shots: shots() })).warnings).toContain("unanchored_line");
    expect(codes(validateEditPlan(plan({ narration: "none" }), { survey: survey(), shots: shots() })).problems).toContain("lines_without_voice");
  });

  it("texts: on a shot that exists, one title per shot, within the density budget", () => {
    const p = plan();
    const t = p.texts[0]!;
    expect(codes(validateEditPlan(plan({ texts: [{ ...t, at_order: 9 }] }), { survey: survey(), shots: shots() })).problems).toContain("bad_at_order");
    expect(codes(validateEditPlan(plan({ texts: [t, { ...t, text_id: "T002" }] }), { survey: survey(), shots: shots() })).problems).toContain("two_titles");
    const many = ["T002", "T003", "T004"].map((id, i) => ({ ...t, text_id: id, kind: "lower_third" as const, at_order: i + 1 }));
    expect(codes(validateEditPlan(plan({ texts: [t, ...many] }), { survey: survey(), shots: shots() })).problems).toContain("too_many_texts");
  });

  it("warns when a line is longer than its picture and when the cut is off its target", () => {
    const long = plan({ lines: [{ line_id: "L001", text: "Một câu lời dẫn dài hơn rất nhiều so với hình đang có trước dòng sau, ".repeat(2) + "vẫn còn đọc tiếp khi hình đã sang cảnh khác." }, plan().lines[1]!] });
    expect(codes(validateEditPlan(long, { survey: survey(), shots: shots() })).warnings).toContain("line_too_long");
    expect(codes(validateEditPlan(plan({ target_seconds: 60 }), { survey: survey(), shots: shots() })).warnings).toContain("duration_off_target");
  });
});
