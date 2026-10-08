/**
 * The edit style learned from reference videos (plan 2026-10-08 quality-fixes, ADR-0001 item 175). Pure: which videos
 * of the reference channels to learn from, what the scene changes measure, and whether the style Claude writes is
 * backed by what was watched.
 */
import {
  StudioStyleSchema, STYLE_MAX_REFERENCES,
  type StudioAspect, type StudioResearch, type StudioStyle, type StyleMeasured, type StyleRefs, type StyleWatch,
} from "@harness/contracts";
import type { ZodError } from "zod";
import { youtubeVideoUrl } from "./research-web.js";
import type { StudioProblem, StudioValidation } from "./validate.js";

/** Long-form references are between these lengths (seconds); vertical series learn from shorts up to 3 minutes. */
const LANDSCAPE_RANGE = [60, 1800] as const;
const PORTRAIT_MAX = 180;
/** Scene changes closer than this are one cut (a flash, a dissolve seen twice). */
export const MIN_CUT_GAP_SECONDS = 0.25;
/** Median shot length bounds of the rhythm labels. */
const FAST_BELOW = 2.5;
const SLOW_ABOVE = 5;
/** How far a number the style restates may stray from the measured one. */
const MEASURE_SLACK = 0.05;
/** How far an evidence time may stray from the frame it names. */
const FRAME_SLACK = 0.05;
const MIN_EVIDENCE = 3;

const r2 = (n: number) => Math.round(n * 100) / 100;

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Linear-interpolated quantile of sorted values. */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** The rhythm a median shot length reads as. */
export function rhythmOf(medianShotSeconds: number): "fast" | "medium" | "slow" {
  return medianShotSeconds < FAST_BELOW ? "fast" : medianShotSeconds > SLOW_ABOVE ? "slow" : "medium";
}

/** Scene changes inside the video, in order, those closer than `MIN_CUT_GAP_SECONDS` to the one before dropped. */
export function mergeCuts(cuts: readonly number[], duration: number): number[] {
  const out: number[] = [];
  for (const c of [...cuts].sort((a, b) => a - b)) {
    if (c <= 0 || c >= duration) continue;
    if (out.length && c - out[out.length - 1]! < MIN_CUT_GAP_SECONDS) continue;
    out.push(c);
  }
  return out;
}

/**
 * What the scene changes of the watched videos measure: shot lengths over all of them, cuts per minute, and how long
 * the first shot runs (the opening). Null without a video.
 */
export function measureShots(videos: readonly { cuts: readonly number[]; duration: number }[]): StyleMeasured | null {
  const watched = videos.filter((v) => v.duration > 0);
  if (!watched.length) return null;
  const lengths: number[] = [];
  const firsts: number[] = [];
  let cuts = 0;
  let seconds = 0;
  for (const v of watched) {
    const merged = mergeCuts(v.cuts, v.duration);
    const edges = [0, ...merged, v.duration];
    for (let i = 1; i < edges.length; i++) lengths.push(edges[i]! - edges[i - 1]!);
    firsts.push(edges[1]!);
    cuts += merged.length;
    seconds += v.duration;
  }
  const sorted = lengths.sort((a, b) => a - b);
  return {
    videos: watched.length,
    shots: sorted.length,
    cuts_per_minute: r2(cuts / (seconds / 60)),
    shot_seconds: { p25: r2(quantile(sorted, 0.25)), median: r2(median(sorted)), p75: r2(quantile(sorted, 0.75)) },
    first_shot_s: r2(firsts.reduce((a, b) => a + b, 0) / firsts.length),
  };
}

const minutes = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Which reference videos to learn from: the reference channels' uploads of a fitting length (16:9: 1–30 minutes;
 * 9:16: shorts up to 3 minutes), nearest the target length (the series' episode target, else the candidates' median),
 * then most views per day, then newest; channels take turns, at most `STYLE_MAX_REFERENCES`.
 */
export function pickReferenceVideos(r: StudioResearch, o: { aspect: StudioAspect; targetSeconds: number | null }): Omit<StyleRefs, "schema_version" | "production_id"> {
  const none = (reason: string) => ({ target_seconds: o.targetSeconds, skipped_reason: reason, picks: [] });
  const reference = r.channels.filter((c) => c.role === "reference");
  if (!reference.length) return none(r.skipped_reason ? `Không chọn được video mẫu: research bị bỏ qua: ${r.skipped_reason}` : "Chưa nhập kênh tham khảo");
  const fits = (d: number) => (o.aspect === "9:16" ? d > 0 && d <= PORTRAIT_MAX : d >= LANDSCAPE_RANGE[0] && d <= LANDSCAPE_RANGE[1]);
  const perChannel = reference.filter((c) => !c.error).map((c) => c.videos.filter((v) => fits(v.duration_s)));
  const all = perChannel.flat();
  if (!all.length) return none("Kênh tham khảo không có video phù hợp để học (độ dài hoặc không lấy được danh sách video)");
  const target = o.targetSeconds ?? Math.round(median(all.map((v) => v.duration_s).sort((a, b) => a - b)));
  // nearness in tenths of the log of the ratio: lengths within ~10% of each other count as equally near
  const nearness = (d: number) => Math.round(Math.abs(Math.log(d / target)) * 10);
  const ranked = perChannel.map((videos) => [...videos].sort((a, b) =>
    nearness(a.duration_s) - nearness(b.duration_s) || b.views_per_day - a.views_per_day || b.published_at.localeCompare(a.published_at)));
  const picks: StyleRefs["picks"] = [];
  const seen = new Set<string>();
  for (let round = 0; picks.length < STYLE_MAX_REFERENCES && ranked.some((list) => list.length > round); round++) {
    for (const list of ranked) {
      const v = list[round];
      if (!v || seen.has(v.video_id) || picks.length >= STYLE_MAX_REFERENCES) continue;
      seen.add(v.video_id);
      picks.push({
        video_id: v.video_id, url: youtubeVideoUrl(v.video_id), channel_id: v.channel_id, channel_title: v.channel_title, title: v.title,
        duration_s: v.duration_s, views: v.views, views_per_day: v.views_per_day, published_at: v.published_at,
        reason: `dài ${minutes(v.duration_s)} (đích ${minutes(target)}), ${Math.round(v.views_per_day)} lượt xem/ngày`,
      });
    }
  }
  return { target_seconds: target, skipped_reason: null, picks };
}

function zodProblems(e: ZodError): StudioProblem[] {
  return e.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "(root)"}: ${i.message}` }));
}

function differs(a: StyleMeasured, b: StyleMeasured): boolean {
  const pairs: [number, number][] = [
    [a.shot_seconds.median, b.shot_seconds.median], [a.shot_seconds.p25, b.shot_seconds.p25], [a.shot_seconds.p75, b.shot_seconds.p75],
    [a.cuts_per_minute, b.cuts_per_minute], [a.first_shot_s, b.first_shot_s],
  ];
  return a.videos !== b.videos || a.shots !== b.shots || pairs.some(([x, y]) => Math.abs(x - y) > MEASURE_SLACK);
}

/**
 * `style.json` (`studio-style`, the `approve-style` gate, a person's later edit). Problems: a skipped style says why;
 * a learned one has params, the numbers measured, at least one reference and three pieces of evidence, and a shot
 * range that is a range. With the watch (stage and gate): its references are the videos watched, its numbers the ones
 * measured, each piece of evidence a frame that was kept. Follow-up warnings (`style_`, back to Claude in its repair
 * round): a shot range that leaves out the measured median, a rhythm label the median contradicts.
 */
export function validateStyle(raw: unknown, ctx: { watch?: StyleWatch | null }): StudioValidation<StudioStyle> {
  const parsed = StudioStyleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const s = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];
  if (s.skipped) {
    if (!s.skipped_reason?.trim()) problems.push({ code: "skipped_without_reason", message: "style bị bỏ qua phải nói lý do" });
    return { ok: problems.length === 0, value: problems.length ? null : s, problems, warnings };
  }
  if (!s.params) problems.push({ code: "no_params", message: "thiếu các tham số dựng (params)" });
  if (!s.measured) problems.push({ code: "no_measured", message: "thiếu số đo nhịp cắt (measured)" });
  if (!s.references.length) problems.push({ code: "no_references", message: "thiếu video mẫu đã học" });
  if (s.evidence.length < MIN_EVIDENCE) problems.push({ code: "too_little_evidence", message: `cần ít nhất ${MIN_EVIDENCE} bằng chứng (khung hình), có ${s.evidence.length}` });
  if (s.params && s.params.shot_seconds.min > s.params.shot_seconds.max) {
    problems.push({ code: "shot_range", message: `độ dài shot ${s.params.shot_seconds.min}–${s.params.shot_seconds.max}s không phải một khoảng` });
  }
  const w = ctx.watch;
  if (w) {
    const watched = new Set(w.videos.filter((v) => !v.error).map((v) => v.video_id));
    const named = new Set(s.references.map((x) => x.video_id));
    if (watched.size !== named.size || [...watched].some((id) => !named.has(id))) {
      problems.push({ code: "references_differ", message: `video mẫu phải đúng các video đã xem: ${[...watched].join(", ") || "(không có)"}` });
    }
    if (s.measured && w.measured && differs(s.measured, w.measured)) {
      problems.push({ code: "measured_differs", message: `số đo phải chép đúng số đã đo (median ${w.measured.shot_seconds.median}s, ${w.measured.cuts_per_minute} cut/phút)` });
    }
    const frames = new Map(w.videos.map((v) => [v.video_id, v.frames.map((f) => f.t)]));
    for (const e of s.evidence) {
      if (!(frames.get(e.video_id) ?? []).some((t) => Math.abs(t - e.t) <= FRAME_SLACK)) {
        problems.push({ code: "evidence_not_watched", message: `bằng chứng ${e.param} (${e.video_id} t=${e.t}s) không phải khung đã xem` });
      }
    }
  }
  const m = w?.measured ?? s.measured;
  if (s.params && m && m.shots > 0) {
    const med = m.shot_seconds.median;
    if (med < s.params.shot_seconds.min || med > s.params.shot_seconds.max) {
      warnings.push({ code: "style_shot_seconds", message: `độ dài shot đo được (median ${med}s) nằm ngoài khoảng ${s.params.shot_seconds.min}–${s.params.shot_seconds.max}s` });
    }
    if (rhythmOf(med) !== s.params.cut_rhythm) {
      warnings.push({ code: "style_cut_rhythm", message: `nhịp "${s.params.cut_rhythm}" trái với số đo (median ${med}s là "${rhythmOf(med)}")` });
    }
  }
  return { ok: problems.length === 0, value: problems.length ? null : s, problems, warnings };
}
