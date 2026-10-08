import { describe, expect, it } from "vitest";
import type { EditPlan, ShotsIndex, StudioStyle, StudioSurvey } from "@harness/contracts";
import { studioSourceId } from "../../src/studio/render-plan.js";
import { applySurveyOps, validateEditPlan, validateStudioSurvey } from "../../src/studio/cut-validate.js";
import { TimelineOpError } from "../../src/studio/layout.js";

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
  it("cut 1.1.0: a median shot length outside the style's range (widened) is a style_ follow-up, from five shots on", () => {
    const piece = (order: number, shot_id: string, source_id: string, inS: number) =>
      ({ order, shot_id, source_id, in: inS, out: inS + 2, line_id: null, transition: "cut" as const, section_title: null, note: "" });
    const five = plan({
      target_seconds: 10,
      shots: [
        { ...piece(1, "s000-000", A, 1), line_id: "L001" }, piece(2, "s001-000", B, 0), { ...piece(3, "s000-002", A, 14), line_id: "L002" },
        piece(4, "s000-002", A, 16), piece(5, "s001-000", B, 2),
      ],
    });
    const style = (min: number, max: number, skipped = false) =>
      ({ skipped, name: "Mei Time", params: { shot_seconds: { min, max } } }) as unknown as StudioStyle;
    const ctx = { survey: survey(), shots: shots() };
    expect(validateEditPlan(five, ctx)).toMatchObject({ ok: true, warnings: [] });
    const slow = validateEditPlan(five, { ...ctx, style: style(4, 8) });
    expect(slow.ok).toBe(true);
    expect(slow.warnings).toEqual([{ code: "style_shot_length", message: expect.stringContaining("shot dài hơn") }]);
    expect(validateEditPlan(five, { ...ctx, style: style(0.5, 1) }).warnings[0]?.message).toContain("shot ngắn hơn");
    // within min × 0.7 … max × 1.3, a skipped style, or fewer than five shots: nothing
    expect(validateEditPlan(five, { ...ctx, style: style(2.5, 6) }).warnings).toEqual([]);
    expect(validateEditPlan(five, { ...ctx, style: style(4, 8, true) }).warnings).toEqual([]);
    expect(validateEditPlan({ ...five, shots: five.shots.slice(0, 4) }, { ...ctx, style: style(4, 8) }).warnings.map((w) => w.code)).not.toContain("style_shot_length");
  });

  it("usable shots in range, anchored lines, one title: ok", () => {
    expect(validateEditPlan(plan(), { survey: survey(), shots: shots() })).toMatchObject({ ok: true, problems: [], warnings: [] });
    // cut 1.1.0: a shot may say its own sound is not heard
    const muted = plan({ shots: plan().shots.map((s, i) => (i === 1 ? { ...s, source_audio: "mute" as const } : s)) });
    expect(validateEditPlan(muted, { survey: survey(), shots: shots() }).ok).toBe(true);
    expect(validateEditPlan({ ...muted, shots: [{ ...muted.shots[0]!, source_audio: "loud" }, ...muted.shots.slice(1)] }, { survey: survey(), shots: shots() }).problems[0]?.code).toBe("schema");
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

describe("applySurveyOps", () => {
  it("keeps, rejects, scores and notes shots in order, never changing the selection it was given", () => {
    const before = survey();
    const after = applySurveyOps(before, [
      { op: "keep", shot_id: "s000-001", note: "giữ lại · rung nhẹ" },
      { op: "reject", shot_id: "s001-000", reason: "có người nhìn máy" },
      { op: "setScore", shot_id: "s000-000", score: 5 },
      { op: "setNote", shot_id: "s000-002", note: "cảnh mở đầu" },
    ]);
    expect(after.shots.map((r) => [r.shot_id, r.usable, r.score, r.note])).toEqual([
      ["s000-000", true, 5, "đẹp"], ["s000-001", true, 1, "giữ lại · rung nhẹ"], ["s000-002", true, 4, "cảnh mở đầu"], ["s001-000", false, 4, "có người nhìn máy"],
    ]);
    expect(before).toEqual(survey());
    expect(validateStudioSurvey(after, { shots: shots() }).ok).toBe(true);
  });

  it("keep with a null note keeps the note; a kept shot scored 0 gets 1", () => {
    const s = survey();
    s.shots[1]!.score = 0;
    const row = applySurveyOps(s, [{ op: "keep", shot_id: "s000-001", note: null }]).shots[1]!;
    expect(row).toMatchObject({ usable: true, note: "rung", score: 1 });
  });

  it("a shot the selection does not have throws, naming the edit; rejecting every shot is left to the validator", () => {
    expect(() => applySurveyOps(survey(), [{ op: "setScore", shot_id: "s000-000", score: 3 }, { op: "keep", shot_id: "s009-009", note: null }]))
      .toThrow(new TimelineOpError("not_found", "thao tác 2 (keep): không có shot s009-009"));
    const none = applySurveyOps(survey(), survey().shots.map((r) => ({ op: "reject" as const, shot_id: r.shot_id, reason: "tối" })));
    expect(validateStudioSurvey(none, { shots: shots() }).problems.map((p) => p.code)).toEqual(["none_usable"]);
  });
});
