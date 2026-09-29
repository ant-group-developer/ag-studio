/**
 * Deterministic checks on what Claude wrote (plan 4.1). Each returns every problem it finds, in words Claude
 * can act on: the same list is fed back for the one repair round and shown in the web when a gate submit is
 * refused.
 */
import {
  SelectionSchema, StudioNarrationSchema, TreatmentSchema,
  type Selection, type StudioBrief, type StudioCatalog, type StudioNarration, type Treatment,
} from "@harness/contracts";
import type { ZodError } from "zod";
import { estimateSpeechSeconds, NARRATION_GAP } from "./layout.js";

export interface StudioProblem { code: string; message: string; beat_id?: string; segment_id?: string; line_id?: string }
export interface StudioValidation<T> { ok: boolean; value: T | null; problems: StudioProblem[] }

/** Total length of the beats may differ from the brief's target by at most this fraction. */
export const DURATION_TOLERANCE = 0.1;
/** Alternates asked for per beat (plan: 3–4). */
export const MIN_ALTERNATES = 3;

function zodProblems(e: ZodError): StudioProblem[] {
  return e.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "(root)"}: ${i.message}` }));
}

function withinTolerance(actual: number, target: number): boolean {
  return Math.abs(actual - target) <= target * DURATION_TOLERANCE + 1e-6;
}

export function validateTreatment(raw: unknown, brief: StudioBrief): StudioValidation<Treatment> {
  const parsed = TreatmentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error) };
  const t = parsed.data;
  const problems: StudioProblem[] = [];
  const ids = new Set<string>();
  for (const b of t.beats) {
    if (ids.has(b.beat_id)) problems.push({ code: "duplicate_beat", message: `beat_id ${b.beat_id} bị trùng`, beat_id: b.beat_id });
    ids.add(b.beat_id);
  }
  const total = t.beats.reduce((s, b) => s + b.seconds, 0);
  if (!withinTolerance(total, brief.target_seconds)) {
    problems.push({ code: "duration", message: `tổng thời lượng các beat là ${round(total)}s, phải nằm trong ${brief.target_seconds}s ±${DURATION_TOLERANCE * 100}%` });
  }
  return { ok: problems.length === 0, value: t, problems };
}

/** Orientations that fit a canvas: `null`/`square` fit both. */
export function orientationFits(orientation: string | null, aspect: StudioBrief["aspect"]): boolean {
  if (!orientation || orientation === "square") return true;
  return aspect === "9:16" ? orientation === "portrait" : orientation === "landscape";
}

/**
 * `selection-valid`: every id is in the catalog; no segment is picked twice; picks are usable and fit the
 * frame; every treatment beat is covered (and only those); each beat's picks hold at least its seconds of
 * footage; and the length they can deliver is within ±10% of the brief. Alternates must be real, distinct from
 * the beat's picks, and 3–4 per beat unless the catalog has fewer unused usable segments left.
 */
export function validateSelection(raw: unknown, ctx: { brief: StudioBrief; catalog: StudioCatalog; treatment: Treatment }): StudioValidation<Selection> {
  const parsed = SelectionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error) };
  const sel = parsed.data;
  const problems: StudioProblem[] = [];
  const byId = new Map(ctx.catalog.segments.map((s) => [s.id, s]));
  const treatmentBeats = new Map(ctx.treatment.beats.map((b) => [b.beat_id, b]));
  const seenBeats = new Set<string>();
  const picked = new Map<string, string>();

  for (const beat of sel.beats) {
    const tb = treatmentBeats.get(beat.beat_id);
    if (!tb) { problems.push({ code: "unknown_beat", message: `beat ${beat.beat_id} không có trong treatment`, beat_id: beat.beat_id }); continue; }
    if (seenBeats.has(beat.beat_id)) problems.push({ code: "duplicate_beat", message: `beat ${beat.beat_id} xuất hiện hai lần`, beat_id: beat.beat_id });
    seenBeats.add(beat.beat_id);
    let footage = 0;
    for (const p of beat.picks) {
      const seg = byId.get(p.segment_id);
      if (!seg) { problems.push({ code: "unknown_segment", message: `beat ${beat.beat_id}: segment_id ${p.segment_id} không có trong catalog`, beat_id: beat.beat_id, segment_id: p.segment_id }); continue; }
      const prev = picked.get(p.segment_id);
      if (prev) problems.push({ code: "duplicate_segment", message: `segment_id ${p.segment_id} đã chọn ở beat ${prev}, không được chọn lại ở ${beat.beat_id}`, beat_id: beat.beat_id, segment_id: p.segment_id });
      else picked.set(p.segment_id, beat.beat_id);
      if (!seg.usable) problems.push({ code: "not_usable", message: `segment_id ${p.segment_id} bị đánh dấu không dùng được`, beat_id: beat.beat_id, segment_id: p.segment_id });
      if (!orientationFits(seg.orientation, ctx.brief.aspect)) problems.push({ code: "orientation", message: `segment_id ${p.segment_id} là ${seg.orientation}, không hợp khung ${ctx.brief.aspect}`, beat_id: beat.beat_id, segment_id: p.segment_id });
      footage += seg.duration_s;
    }
    if (footage + 1e-6 < tb.seconds) {
      problems.push({ code: "beat_too_short", message: `beat ${beat.beat_id} cần ${tb.seconds}s hình nhưng các đoạn chọn chỉ có ${round(footage)}s`, beat_id: beat.beat_id });
    }
    const pickIds = new Set(beat.picks.map((p) => p.segment_id));
    const altIds = new Set<string>();
    for (const a of beat.alternates) {
      if (!byId.has(a.segment_id)) problems.push({ code: "unknown_segment", message: `beat ${beat.beat_id}: phương án thay thế ${a.segment_id} không có trong catalog`, beat_id: beat.beat_id, segment_id: a.segment_id });
      if (pickIds.has(a.segment_id)) problems.push({ code: "alternate_is_pick", message: `beat ${beat.beat_id}: ${a.segment_id} vừa là đoạn chọn vừa là phương án thay thế`, beat_id: beat.beat_id, segment_id: a.segment_id });
      if (altIds.has(a.segment_id)) problems.push({ code: "duplicate_alternate", message: `beat ${beat.beat_id}: phương án thay thế ${a.segment_id} bị trùng`, beat_id: beat.beat_id, segment_id: a.segment_id });
      altIds.add(a.segment_id);
    }
  }
  for (const id of treatmentBeats.keys()) {
    if (!seenBeats.has(id)) problems.push({ code: "missing_beat", message: `thiếu beat ${id} của treatment`, beat_id: id });
  }
  // Alternates: 3 per beat, unless the catalog simply does not have that many unused usable segments.
  const usable = ctx.catalog.segments.filter((s) => s.usable && orientationFits(s.orientation, ctx.brief.aspect));
  for (const beat of sel.beats) {
    const available = usable.filter((s) => !picked.has(s.id)).length;
    const need = Math.min(MIN_ALTERNATES, available);
    if (beat.alternates.length < need) problems.push({ code: "too_few_alternates", message: `beat ${beat.beat_id} cần ít nhất ${need} phương án thay thế, mới có ${beat.alternates.length}`, beat_id: beat.beat_id });
  }
  const deliverable = sel.beats.reduce((s, b) => {
    const tb = treatmentBeats.get(b.beat_id);
    if (!tb) return s;
    const footage = b.picks.reduce((x, p) => x + (byId.get(p.segment_id)?.duration_s ?? 0), 0);
    return s + Math.min(footage, tb.seconds);
  }, 0);
  if (!withinTolerance(deliverable, ctx.brief.target_seconds)) {
    problems.push({ code: "duration", message: `các đoạn chọn chỉ dựng được ${round(deliverable)}s, phải nằm trong ${ctx.brief.target_seconds}s ±${DURATION_TOLERANCE * 100}%` });
  }
  return { ok: problems.length === 0, value: sel, problems };
}

/** Lines may run at most this much longer than their beat before TTS has measured them. */
export const NARRATION_SLACK = 1.15;

export function validateNarration(raw: unknown, ctx: { brief: StudioBrief; treatment: Treatment }): StudioValidation<StudioNarration> {
  const parsed = StudioNarrationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error) };
  const n = parsed.data;
  const problems: StudioProblem[] = [];
  const beats = new Map(ctx.treatment.beats.map((b) => [b.beat_id, b]));
  const ids = new Set<string>();
  const perBeat = new Map<string, number>();
  for (const l of n.lines) {
    if (ids.has(l.line_id)) problems.push({ code: "duplicate_line", message: `line_id ${l.line_id} bị trùng`, line_id: l.line_id });
    ids.add(l.line_id);
    if (!beats.has(l.beat_id)) { problems.push({ code: "unknown_beat", message: `câu ${l.line_id} thuộc beat ${l.beat_id} không có trong treatment`, line_id: l.line_id }); continue; }
    const prev = perBeat.get(l.beat_id);
    perBeat.set(l.beat_id, (prev === undefined ? 0 : prev + NARRATION_GAP) + estimateSpeechSeconds(l.text));
  }
  for (const [beatId, seconds] of perBeat) {
    const tb = beats.get(beatId)!;
    if (seconds > tb.seconds * NARRATION_SLACK) problems.push({ code: "too_long", message: `lời dẫn beat ${beatId} ước chừng ${round(seconds)}s đọc, dài hơn beat (${tb.seconds}s); rút gọn lại`, beat_id: beatId });
  }
  for (const b of ctx.treatment.beats) {
    if (b.narration_idea.trim() && !perBeat.has(b.beat_id)) problems.push({ code: "missing_beat", message: `beat ${b.beat_id} có ý lời dẫn nhưng chưa có câu nào`, beat_id: b.beat_id });
  }
  if (n.language !== ctx.brief.language) problems.push({ code: "language", message: `language phải là ${ctx.brief.language}` });
  return { ok: problems.length === 0, value: n, problems };
}

function round(n: number): number { return Math.round(n * 10) / 10; }
