/**
 * Deterministic checks of the two documents Claude writes for a shot-cut episode (spec local-chat §3.3): the scene
 * selection (`survey.json`) and the edit plan (`edit-plan.json`). Same contract as `validate.ts`: problems block and go
 * back to Claude for the one repair round (and to a person at the gate), warnings never block.
 */
import {
  EditPlanSchema, EPISODE_DURATION_TOLERANCE, StudioSurveySchema,
  type EditPlan, type ShotsIndex, type StudioStyle, type StudioSurvey, type SurveyOp,
} from "@harness/contracts";
import type { ZodError } from "zod";
import { narrationCps, TimelineOpError } from "./layout.js";
import type { StudioProblem, StudioValidation } from "./validate.js";

/** How far a row's or a shot's `in`/`out` may stray from the detected shot (rounding of the 0.1 s cut grid). */
const SHOT_SLACK = 0.05;
/** Shortest piece of a shot an edit may use. */
const MIN_PIECE_SECONDS = 0.5;
/** One text on screen every this many seconds at most (harness `overlays-valid`, density `medium`). */
const TEXT_SPACING_SECONDS = 8;
/** A line may run this much past the picture before the next line before it is called too long. */
const LINE_OVERRUN = 1.1;
/** The style's shot length is checked from this many shots on, and its range widened by these factors. */
export const STYLE_SHOT_CHECK = { minShots: 5, below: 0.7, above: 1.3 } as const;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function zodProblems(e: ZodError): StudioProblem[] {
  return e.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "(root)"}: ${i.message}` }));
}

function shotTable(shots: ShotsIndex): Map<string, { source_id: string; in: number; out: number }> {
  return new Map(shots.sources.flatMap((s) => s.shots.map((x) => [x.shot_id, { source_id: s.source_id, in: x.in, out: x.out }] as const)));
}

/** `survey.json`: exactly one row per shot of `shots.json`, on the shot's source and range, at least one usable. */
export function validateStudioSurvey(raw: unknown, ctx: { shots: ShotsIndex }): StudioValidation<StudioSurvey> {
  const parsed = StudioSurveySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const survey = parsed.data;
  const table = shotTable(ctx.shots);
  const problems: StudioProblem[] = [];
  const seen = new Set<string>();
  for (const row of survey.shots) {
    const shot = table.get(row.shot_id);
    if (!shot) { problems.push({ code: "unknown_shot", message: `shot ${row.shot_id} không có trong danh sách shot` }); continue; }
    if (seen.has(row.shot_id)) problems.push({ code: "duplicate_shot", message: `shot ${row.shot_id} có hai dòng` });
    seen.add(row.shot_id);
    if (row.source_id !== shot.source_id) problems.push({ code: "wrong_source", message: `shot ${row.shot_id} thuộc video ${shot.source_id}, không phải ${row.source_id}` });
    if (Math.abs(row.in - shot.in) > SHOT_SLACK || Math.abs(row.out - shot.out) > SHOT_SLACK) {
      problems.push({ code: "shot_range", message: `shot ${row.shot_id} là ${shot.in}–${shot.out}s, dòng ghi ${row.in}–${row.out}s` });
    }
  }
  const missing = [...table.keys()].filter((id) => !seen.has(id));
  if (missing.length) problems.push({ code: "missing_shot", message: `thiếu dòng cho ${missing.length} shot: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}` });
  if (!survey.shots.some((r) => r.usable)) problems.push({ code: "none_usable", message: "không shot nào dùng được: tập không có gì để dựng" });
  return { ok: problems.length === 0, value: problems.length ? null : survey, problems, warnings: [] };
}

/**
 * `edit-plan.json`: shots in order, each a piece (≥ 0.5 s) of a usable shot of the approved selection; every
 * narration line anchored at most once on a shot; texts on shots that exist, one title per shot, at most one text
 * every 8 s. Warns when a line is longer than the picture before the next line, and when the cut is off its target
 * by more than 20%.
 */
export function validateEditPlan(
  raw: unknown,
  /** `style`: the production's edit style (cut 1.1.0), when it has one; its shot length is a follow-up (`style_`). */
  ctx: { survey: StudioSurvey; shots: ShotsIndex; style?: StudioStyle | null },
): StudioValidation<EditPlan> {
  const parsed = EditPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const plan = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];
  const table = shotTable(ctx.shots);
  const rows = new Map(ctx.survey.shots.map((r) => [r.shot_id, r]));

  if (plan.shots.some((s, i) => s.order !== i + 1)) {
    problems.push({ code: "bad_order", message: "order của các shot phải là 1, 2, 3… theo đúng thứ tự trong danh sách" });
  }
  for (const s of plan.shots) {
    const shot = table.get(s.shot_id);
    const row = rows.get(s.shot_id);
    if (!shot || !row) { problems.push({ code: "unknown_shot", message: `shot ${s.shot_id} (thứ ${s.order}) không có trong bản chọn cảnh` }); continue; }
    if (!row.usable) problems.push({ code: "not_usable", message: `shot ${s.shot_id} (thứ ${s.order}) đã bị loại ở bước chọn cảnh: ${row.note}` });
    if (s.source_id !== shot.source_id) problems.push({ code: "wrong_source", message: `shot ${s.shot_id} thuộc video ${shot.source_id}` });
    if (s.in < shot.in - SHOT_SLACK || s.out > shot.out + SHOT_SLACK || s.out <= s.in) {
      problems.push({ code: "outside_shot", message: `shot thứ ${s.order} lấy ${s.in}–${s.out}s, ngoài shot ${s.shot_id} (${shot.in}–${shot.out}s)` });
    } else if (s.out - s.in < MIN_PIECE_SECONDS) {
      problems.push({ code: "too_short", message: `shot thứ ${s.order} chỉ dài ${(s.out - s.in).toFixed(2)}s (tối thiểu ${MIN_PIECE_SECONDS}s)` });
    }
  }

  // Narration
  const lineIds = new Set<string>();
  for (const l of plan.lines) {
    if (lineIds.has(l.line_id)) problems.push({ code: "duplicate_line", message: `lời dẫn ${l.line_id} xuất hiện hai lần` });
    lineIds.add(l.line_id);
  }
  if (plan.narration !== "tts" && plan.lines.length > 0) {
    problems.push({ code: "lines_without_voice", message: `tập ${plan.narration === "none" ? "không có lời dẫn" : "giữ tiếng gốc"} nhưng kế hoạch có ${plan.lines.length} dòng lời dẫn` });
  }
  const anchors = new Map<string, number>();
  for (const s of plan.shots) {
    if (!s.line_id) continue;
    if (!lineIds.has(s.line_id)) problems.push({ code: "unknown_line", message: `shot thứ ${s.order} neo lời dẫn ${s.line_id} không có` });
    else if (anchors.has(s.line_id)) problems.push({ code: "line_twice", message: `lời dẫn ${s.line_id} neo ở cả shot thứ ${anchors.get(s.line_id)} và ${s.order}` });
    else anchors.set(s.line_id, s.order);
  }
  for (const l of plan.lines) {
    if (!anchors.has(l.line_id)) warnings.push({ code: "unanchored_line", message: `lời dẫn ${l.line_id} không neo vào shot nào nên sẽ không được đọc` });
  }

  // A line against the picture until the next line starts (or the end)
  const cps = narrationCps(plan.language);
  const anchored = plan.shots.filter((s) => s.line_id && anchors.get(s.line_id) === s.order);
  for (const [k, s] of anchored.entries()) {
    const next = anchored[k + 1];
    const picture = plan.shots.filter((x) => x.order >= s.order && (!next || x.order < next.order)).reduce((sum, x) => sum + (x.out - x.in), 0);
    const line = plan.lines.find((l) => l.line_id === s.line_id)!;
    const reading = line.text.length / cps;
    if (reading > picture * LINE_OVERRUN) {
      warnings.push({ code: "line_too_long", message: `lời dẫn ${line.line_id} đọc khoảng ${reading.toFixed(1)}s nhưng chỉ có ${picture.toFixed(1)}s hình tới dòng sau` });
    }
  }

  // Texts
  const orders = new Set(plan.shots.map((s) => s.order));
  const titles = new Map<number, number>();
  const textIds = new Set<string>();
  for (const t of plan.texts) {
    if (textIds.has(t.text_id)) problems.push({ code: "duplicate_text", message: `chữ ${t.text_id} xuất hiện hai lần` });
    textIds.add(t.text_id);
    if (!orders.has(t.at_order)) problems.push({ code: "bad_at_order", message: `chữ ${t.text_id} đặt ở shot thứ ${t.at_order}, không có shot đó` });
    if (t.kind === "title") titles.set(t.at_order, (titles.get(t.at_order) ?? 0) + 1);
  }
  for (const [order, n] of titles) if (n > 1) problems.push({ code: "two_titles", message: `shot thứ ${order} có ${n} tiêu đề (tối đa 1)` });
  const pictureSeconds = plan.shots.reduce((sum, s) => sum + (s.out - s.in), 0);
  const readingSeconds = plan.lines.reduce((sum, l) => sum + l.text.length, 0) / cps;
  const limit = Math.max(1, Math.floor(Math.max(pictureSeconds, readingSeconds) / TEXT_SPACING_SECONDS));
  if (plan.texts.length > limit) problems.push({ code: "too_many_texts", message: `${plan.texts.length} chữ trên hình cho ${pictureSeconds.toFixed(0)}s hình (tối đa ${limit}, một chữ mỗi ${TEXT_SPACING_SECONDS}s)` });

  // The style's rhythm: the median piece within the style's shot length, widened (the cut follows the picture first)
  const range = ctx.style && !ctx.style.skipped ? ctx.style.params?.shot_seconds : undefined;
  if (range && plan.shots.length >= STYLE_SHOT_CHECK.minShots) {
    const med = median(plan.shots.map((s) => s.out - s.in));
    const lo = range.min * STYLE_SHOT_CHECK.below;
    const hi = range.max * STYLE_SHOT_CHECK.above;
    if (med < lo || med > hi) {
      warnings.push({
        code: "style_shot_length",
        message: `shot dài trung vị ${med.toFixed(1)}s, phong cách "${ctx.style!.name}" giữ shot ${range.min}–${range.max}s: ${med < lo ? "cắt chậm lại (shot dài hơn)" : "cắt nhanh hơn (shot ngắn hơn)"}`,
      });
    }
  }

  // Duration (soft ±20%): the picture, or the reading when that is longer (the fit appends picture to cover it)
  const seconds = Math.max(pictureSeconds, plan.narration === "tts" ? readingSeconds : 0);
  if (Math.abs(seconds - plan.target_seconds) > plan.target_seconds * EPISODE_DURATION_TOLERANCE + 1e-6) {
    warnings.push({ code: "duration_off_target", message: `kế hoạch dài khoảng ${seconds.toFixed(0)}s, mục tiêu ${plan.target_seconds}s (±20%)` });
  }

  return { ok: problems.length === 0, value: problems.length ? null : plan, problems, warnings };
}

/**
 * Runs chat edits of a scene selection in order on `survey` (never changed): keep, reject (the reason becomes the
 * note), set a score, set a note. A shot the selection does not have throws `TimelineOpError` naming the edit.
 */
export function applySurveyOps(survey: StudioSurvey, ops: readonly SurveyOp[]): StudioSurvey {
  const shots = survey.shots.map((r) => ({ ...r }));
  ops.forEach((op, i) => {
    const row = shots.find((r) => r.shot_id === op.shot_id);
    if (!row) throw new TimelineOpError("not_found", `thao tác ${i + 1} (${op.op}): không có shot ${op.shot_id}`);
    switch (op.op) {
      case "keep": row.usable = true; if (op.note !== null) row.note = op.note; if (row.score === 0) row.score = 1; break;
      case "reject": row.usable = false; row.note = op.reason; break;
      case "setScore": row.score = op.score; break;
      case "setNote": row.note = op.note; break;
    }
  });
  return { ...survey, shots };
}
