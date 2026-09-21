/** "Picture follows voice": reshapes an agent-written EDL so every narrated entry is long enough for the
 * lines TTS actually produced, and so `voice: original` cuts land in silence rather than mid-word (spec
 * sub-project 5A §4.1). Pure: no I/O, no clock, no randomness -- the same input always gives the same
 * output. It never throws for lack of footage; a shortage is recorded in `fit-report.json` instead. */
import {
  EdlSchema,
  FitReportSchema,
  type Edl,
  type EdlEntry,
  type FitReport,
  type NarrationTiming,
  type ShotsIndex,
  type SurveyIndexV2,
  type Transcript,
} from "@harness/contracts";
import { snapEntry } from "./snap.js";
import { EPS, round3 } from "./time.js";

export const FIT = { lead: 0.3, tail: 0.4, keepSlack: 0.5, snapWindow: 0.4, minGap: 0.15, handle: 0.08, minEntry: 0.2 } as const;

/** An interval marks a shot as "used" when it covers the shot's midpoint or overlaps it by more than this. */
const USED_OVERLAP = 0.2;

type FitAction = FitReport["entries"][number]["action"];
type Voice = FitReport["voice"];

/** One shot of one source, joined with its survey row (or the `survey: null` default of usable/score 0). */
interface ShotRef {
  source_id: string;
  sourceIndex: number;
  shot_id: string;
  in: number;
  out: number;
  score: number;
  usable: boolean;
}

/** An EDL entry under construction. `before` is null for an entry the input EDL did not contain. */
interface Work {
  source_id: string;
  in: number;
  out: number;
  overlay: "avatar" | null;
  note: string;
  before: { in: number; out: number } | null;
  action: FitAction;
}

function shotKey(s: { source_id: string; shot_id: string }): string {
  return `${s.source_id}|${s.shot_id}`;
}

/** Highest score first; ties go to the lower source index, then the earlier `in`. */
function byQuality(a: ShotRef, b: ShotRef): number {
  return b.score - a.score || a.sourceIndex - b.sourceIndex || a.in - b.in;
}

export interface FitEdlResult {
  edl: Edl;
  report: FitReport;
  /** Original `order` -> the new orders it produced, in emission order. A dropped entry maps to `[]`. */
  orderMap: Map<number, number[]>;
}

/**
 * Fits `edl` to `timing` and returns the reshaped EDL, a `fit-report.json` and the order mapping
 * `buildTimeline` needs to place narration lines.
 *
 * Entries are processed in ascending original `order`; the entries produced for one original order are
 * emitted contiguously (the fitted original first, then whatever was appended or reused for it) and the
 * whole result is renumbered `0..n-1`. The "used" shot set is seeded from EVERY entry of the input EDL
 * before any fitting happens, so an appended shot never duplicates footage the agent placed later on.
 */
export function fitEdl(p: {
  edl: Edl;
  timing: NarrationTiming;
  shots: ShotsIndex;
  survey: SurveyIndexV2 | null;
  transcript: Transcript | null;
  voice: Voice;
  target_duration_seconds?: [number, number];
}): FitEdlResult {
  const target = p.target_duration_seconds;
  const durationOf = new Map(p.shots.sources.map((s) => [s.source_id, s.duration_seconds]));

  const surveyByShot = new Map<string, { score: number; usable: boolean }>();
  for (const s of p.survey?.shots ?? []) surveyByShot.set(shotKey(s), { score: s.score, usable: s.usable });

  const shotsBySource = new Map<string, ShotRef[]>();
  const allShots: ShotRef[] = [];
  for (const src of p.shots.sources) {
    const list = src.shots.map((sh): ShotRef => {
      // A shot the survey does not mention is treated as usable with score 0, exactly like `survey: null`.
      const meta = surveyByShot.get(shotKey({ source_id: src.source_id, shot_id: sh.shot_id }));
      return {
        source_id: src.source_id,
        sourceIndex: src.index,
        shot_id: sh.shot_id,
        in: sh.in,
        out: sh.out,
        score: meta?.score ?? 0,
        usable: meta?.usable ?? true,
      };
    });
    shotsBySource.set(src.source_id, list);
    allShots.push(...list);
  }

  const used = new Set<string>();
  const markUsed = (source_id: string, from: number, to: number): void => {
    const mid = (from + to) / 2;
    for (const sh of shotsBySource.get(source_id) ?? []) {
      const overlap = Math.min(sh.out, to) - Math.max(sh.in, from);
      if (overlap > USED_OVERLAP || (sh.in <= mid && mid < sh.out)) used.add(shotKey(sh));
    }
  };

  const ordered = [...p.edl.entries].sort((a, b) => a.order - b.order);
  for (const e of ordered) markUsed(e.source_id, e.in, e.out);

  const warnings: string[] = [];
  const shortfalls: FitReport["shortfalls"] = [];
  /** Original order -> the index of its single shortfall row, so the orphan pass below can replace that row
   * instead of adding a second one for the same line group. */
  const shortfallRow = new Map<number, number>();
  const groups = new Map<number, Work[]>();

  for (const entry of ordered) {
    const lines = p.timing.lines.filter((l) => l.edl_order === entry.order);
    const base: Work = {
      source_id: entry.source_id,
      in: entry.in,
      out: entry.out,
      overlay: entry.overlay,
      note: entry.note,
      before: { in: entry.in, out: entry.out },
      action: "kept",
    };

    let work: Work[];
    if (p.voice === "tts" && lines.length > 0) {
      const fitted = fitOne(base, lines, { shotsBySource, allShots, used, markUsed });
      work = fitted.work;
      if (fitted.shortfall) {
        shortfallRow.set(entry.order, shortfalls.length);
        shortfalls.push(fitted.shortfall);
      }
    } else {
      work = [base];
    }

    if (p.voice === "original") {
      for (const w of work) {
        const snapped = snapEntry({
          order: entry.order,
          in: w.in,
          out: w.out,
          source: p.transcript?.sources.find((s) => s.source_id === w.source_id),
          sourceDuration: durationOf.get(w.source_id) ?? w.out,
          o: { window: FIT.snapWindow, minGap: FIT.minGap, handle: FIT.handle, minEntry: FIT.minEntry },
        });
        w.in = snapped.in;
        w.out = snapped.out;
        if (snapped.snapped) w.action = "snapped";
        warnings.push(...snapped.warnings);
      }
    }

    groups.set(entry.order, work);
  }

  // Clamp to the source, round, drop what is now too short, renumber.
  const reportEntries: FitReport["entries"] = [];
  const finalEntries: EdlEntry[] = [];
  const orderMap = new Map<number, number[]>(ordered.map((e) => [e.order, []]));
  let firstOriginal: { row: number; warning: number } | null = null;

  for (const entry of ordered) {
    for (const w of groups.get(entry.order) ?? []) {
      const duration = durationOf.get(w.source_id);
      const clamp = (v: number): number => round3(duration === undefined ? Math.max(0, v) : Math.min(Math.max(0, v), duration));
      const after = { in: clamp(w.in), out: clamp(w.out) };

      // The row and warning for the FIRST original entry are remembered, because the all-dropped fallback
      // below revives exactly that entry and must then replace its own "dropped" row rather than contradict
      // it with a second row for the same order.
      const isFirstOriginal = entry.order === ordered[0]?.order && w.before !== null;

      if (after.out - after.in < FIT.minEntry) {
        if (isFirstOriginal) firstOriginal = { row: reportEntries.length, warning: warnings.length };
        reportEntries.push({ order: entry.order, source_id: w.source_id, before: w.before, after, action: "dropped" });
        warnings.push(
          `fit: entry for order ${entry.order} on ${w.source_id} dropped: ${round3(after.out - after.in)}s is shorter than ${FIT.minEntry}s`,
        );
        continue;
      }

      const newOrder = finalEntries.length;
      finalEntries.push({ source_id: w.source_id, in: after.in, out: after.out, order: newOrder, overlay: w.overlay, note: w.note });
      orderMap.get(entry.order)?.push(newOrder);
      reportEntries.push({ order: newOrder, source_id: w.source_id, before: w.before, after, action: w.action });
    }
  }

  // `EdlSchema` needs at least one entry, so a plan where everything was dropped revives the agent's first
  // entry -- clamped into its source like every other emitted entry, and widened to the last `minEntry`
  // seconds of the source when the clamp left nothing. `library-review` rejects the result and the SP4
  // replan loop takes it from there; this must never throw for lack of footage.
  if (finalEntries.length === 0) {
    const first = ordered[0]!;
    const duration = durationOf.get(first.source_id);
    let after: { in: number; out: number };
    if (duration !== undefined && duration > FIT.minEntry) {
      const fit = (v: number): number => round3(Math.min(Math.max(0, v), duration));
      after = { in: fit(first.in), out: fit(first.out) };
      if (after.out - after.in < FIT.minEntry) after = { in: round3(duration - FIT.minEntry), out: round3(duration) };
    } else {
      after = { in: round3(first.in), out: round3(first.out) };
      warnings.push(
        `fit: source ${first.source_id} has no usable duration, so the revived first entry could not be clamped`,
      );
    }
    finalEntries.push({ source_id: first.source_id, ...after, order: 0, overlay: first.overlay, note: first.note });
    orderMap.get(first.order)?.push(0);
    const revived = { order: 0, source_id: first.source_id, before: { in: first.in, out: first.out }, after, action: "kept" as const };
    if (firstOriginal) {
      reportEntries[firstOriginal.row] = revived;
      warnings.splice(firstOriginal.warning, 1);
    } else {
      reportEntries.push(revived);
    }
    warnings.push(`fit: every entry was dropped; kept the first original entry (order ${first.order}) so the EDL stays valid`);
  }

  // A narration line with no picture would otherwise vanish without a trace: synthesized audio nobody ever
  // hears and nothing for `library-review` to reject on. One shortfall row per orphaned group.
  if (p.voice === "tts") {
    const orphaned = new Map<number, NarrationTiming["lines"]>();
    for (const line of p.timing.lines) {
      if ((orderMap.get(line.edl_order)?.length ?? 0) > 0) continue;
      const group = orphaned.get(line.edl_order);
      if (group) group.push(line);
      else orphaned.set(line.edl_order, [line]);
    }
    for (const order of [...orphaned.keys()].sort((a, b) => a - b)) {
      const lines = orphaned.get(order) ?? [];
      const seconds = round3(lines.reduce((a, l) => a + l.duration_seconds, 0) + FIT.lead + FIT.tail);
      // Nothing of this group survived, so the whole need is uncovered -- that supersedes any partial row
      // the fit rules left behind, keeping it at one row per line group.
      const row = { line_ids: lines.map((l) => l.line_id), missing_seconds: seconds, reused_seconds: 0, uncovered_seconds: seconds };
      const existing = shortfallRow.get(order);
      if (existing === undefined) shortfalls.push(row);
      else shortfalls[existing] = row;
      warnings.push(`fit: narration for edl_order ${order} has no picture: ${lines.map((l) => l.line_id).join(", ")}`);
    }
  }

  const total = round3(finalEntries.reduce((a, e) => a + (e.out - e.in), 0));
  const report = FitReportSchema.parse({
    schema_version: "harness.fit-report/v1",
    voice: p.voice,
    entries: reportEntries,
    shortfalls,
    // By definition the sum of the rows, so replacing a row can never leave the total contradicting them.
    reused_seconds: round3(shortfalls.reduce((a, s) => a + s.reused_seconds, 0)),
    warnings,
    total_seconds: total,
    ...(target ? { target_duration_seconds: target } : {}),
    within_target: !target || (total >= target[0] && total <= target[1]),
  });

  return { edl: EdlSchema.parse({ schema_version: "harness.edl/v1", entries: finalEntries }), report, orderMap };
}

interface FitContext {
  shotsBySource: Map<string, ShotRef[]>;
  allShots: ShotRef[];
  used: Set<string>;
  markUsed: (source_id: string, from: number, to: number) => void;
}

function appendedWork(group: ShotRef, take: number, lineIds: string[], action: "appended" | "reused"): Work {
  return {
    source_id: group.source_id,
    in: group.in,
    out: group.in + take,
    overlay: null,
    note: `fit: ${action} for ${lineIds.join(",")}`,
    before: null,
    action,
  };
}

/**
 * The five `voice: tts` rules for one narrated entry (spec §4.1): trim, extend inside the entry's own shot,
 * append the adjacent shots of the same source, append the best unused shots anywhere, and finally reuse
 * footage already on screen. Reuse makes at most one pass over its candidates, so it always terminates.
 *
 * A deficit below `minEntry` is treated as covered and stops the search: a cut that short is not worth a
 * shot of its own (it would be dropped again downstream) and the 0.4s tail pad absorbs it, so it is not a
 * shortfall either. That is also why no appended or reused entry is ever shorter than `minEntry`.
 *
 * At most ONE shortfall row is produced, for the whole line group: `missing_seconds` is everything fresh
 * footage could not cover, split into the part reuse papered over and the part nothing covers at all.
 */
function fitOne(
  base: Work,
  lines: NarrationTiming["lines"],
  ctx: FitContext,
): { work: Work[]; shortfall: FitReport["shortfalls"][number] | null } {
  const lineIds = lines.map((l) => l.line_id);
  const need = lines.reduce((a, l) => a + l.duration_seconds, 0) + FIT.lead + FIT.tail;
  const work: Work[] = [base];
  const original = { in: base.in, out: base.out };

  // Rule 1 -- long enough already.
  if (base.out - base.in >= need) {
    if (base.out - base.in - need >= FIT.keepSlack) {
      base.out = base.in + need;
      base.action = "trimmed";
    }
    return { work, shortfall: null };
  }

  // Rule 2 -- grow inside the shot the entry sits in; with no such shot the entry is its own bound and
  // cannot grow at all, so the whole deficit falls through to the append rules.
  const list = ctx.shotsBySource.get(base.source_id) ?? [];
  const mid = (base.in + base.out) / 2;
  const containing = list.find((s) => s.in <= base.in && base.out <= s.out);
  const anchor = containing ?? list.find((s) => s.in <= mid && mid < s.out);
  const bound = containing ?? { in: base.in, out: base.out };
  base.out = Math.min(bound.out, base.in + need);
  if (base.out - base.in < need) base.in = Math.max(bound.in, base.out - need);
  if (base.in !== original.in || base.out !== original.out) base.action = "extended";
  ctx.markUsed(base.source_id, base.in, base.out);
  let remaining = need - (base.out - base.in);

  /** True while the deficit is still big enough to be worth a cut of its own. */
  const worthFilling = (): boolean => remaining >= FIT.minEntry - EPS;
  /** A shot that could not fill even a minimum-length entry is no use to any of the append rules. */
  const longEnough = (s: ShotRef): boolean => s.out - s.in >= FIT.minEntry - EPS;

  // Rule 3 -- the shots right after it in the same source, while they are free and usable.
  if (anchor) {
    for (let i = list.indexOf(anchor) + 1; worthFilling() && i < list.length; i++) {
      const sh = list[i]!;
      if (!sh.usable || ctx.used.has(shotKey(sh)) || !longEnough(sh)) break;
      const take = Math.min(sh.out - sh.in, remaining);
      work.push(appendedWork(sh, take, lineIds, "appended"));
      ctx.used.add(shotKey(sh));
      remaining -= take;
    }
  }

  // Rule 4 -- the best unused shot anywhere, repeatedly.
  while (worthFilling()) {
    const next = ctx.allShots.filter((s) => s.usable && longEnough(s) && !ctx.used.has(shotKey(s))).sort(byQuality)[0];
    if (!next) break;
    const take = Math.min(next.out - next.in, remaining);
    work.push(appendedWork(next, take, lineIds, "appended"));
    ctx.used.add(shotKey(next));
    remaining -= take;
  }

  // Rule 5 -- last resort: put the best footage on screen a second time and own up to it.
  let reused = 0;
  if (worthFilling()) {
    for (const sh of ctx.allShots.filter((s) => s.usable && longEnough(s) && ctx.used.has(shotKey(s))).sort(byQuality)) {
      if (!worthFilling()) break;
      const take = Math.min(sh.out - sh.in, remaining);
      work.push(appendedWork(sh, take, lineIds, "reused"));
      remaining -= take;
      reused += take;
    }
    const reusedSeconds = round3(reused);
    const uncoveredSeconds = worthFilling() ? round3(remaining) : 0;
    const missing = round3(reusedSeconds + uncoveredSeconds);
    if (missing > 0) {
      return {
        work,
        shortfall: { line_ids: lineIds, missing_seconds: missing, reused_seconds: reusedSeconds, uncovered_seconds: uncoveredSeconds },
      };
    }
  }

  return { work, shortfall: null };
}
