import type { ChannelLearned, ChannelPackage, Clock, StateStore } from "@harness/contracts";
import type { LoadedChannel } from "../distribution/channels.js";
import { snapshotAtHorizon, type HypothesisMetric } from "./hypotheses.js";

/** `${has-a-digit? "number":"plain"}+${ends-with-"?"? "question":"statement"}+${>60 chars? "long":"short"}`. */
export function titlePattern(title: string): string {
  const hasNumber = /\d/.test(title) ? "number" : "plain";
  const isQuestion = title.trim().endsWith("?") ? "question" : "statement";
  const long = title.length > 60 ? "long" : "short";
  return `${hasNumber}+${isQuestion}+${long}`;
}

export function overlayGroup(lines: string[]): "0" | "1-2" | "3" {
  if (lines.length === 0) return "0";
  if (lines.length <= 2) return "1-2";
  return "3";
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

type GroupStat = ChannelLearned["winners"]["angles"][number];
type Standard = ChannelLearned["standard"];
type StandardCore = ChannelLearned["history"][number]["standard"];

/** Most frequent metric across a channel's evaluated hypotheses; ties (including a 3-way tie) resolve to
 * `views_72h`, and an empty list has no mode at all. */
function modeMetric(metrics: HypothesisMetric[]): HypothesisMetric | null {
  if (metrics.length === 0) return null;
  const counts: Record<HypothesisMetric, number> = { ctr: 0, views_72h: 0, avg_view_pct: 0 };
  for (const m of metrics) counts[m]++;
  const max = Math.max(counts.ctr, counts.views_72h, counts.avg_view_pct);
  const tied = (Object.keys(counts) as HypothesisMetric[]).filter((k) => counts[k] === max);
  return tied.length === 1 ? tied[0]! : "views_72h";
}

function computeGroups(items: { value: string; status: "supported" | "refuted"; metricValue: number }[], medianForMetric: number | null): GroupStat[] {
  const map = new Map<string, { supported: number; refuted: number; values: number[] }>();
  for (const it of items) {
    const g = map.get(it.value) ?? { supported: 0, refuted: 0, values: [] };
    if (it.status === "supported") g.supported++; else g.refuted++;
    g.values.push(it.metricValue);
    map.set(it.value, g);
  }
  const groups: GroupStat[] = [];
  for (const [value, g] of map) {
    const mean = g.values.reduce((a, b) => a + b, 0) / g.values.length;
    const lift = medianForMetric == null || medianForMetric === 0 ? 0 : mean / medianForMetric;
    groups.push({ value, supported: g.supported, refuted: g.refuted, lift });
  }
  groups.sort((a, b) => b.lift - a.lift || a.value.localeCompare(b.value));
  return groups;
}

function pickCandidate(groups: GroupStat[], minSamples: number): GroupStat | undefined {
  return groups.find((g) => g.supported >= minSamples && g.lift > 1 && g.supported > g.refuted);
}

/**
 * One dimension (angle / title_pattern / overlay_lines) of the "10% threshold" rule: when the *old* standard
 * already names a value for this dimension, it is kept unless the new candidate's lift beats the old value's
 * own lift by at least 10%. The old lift is looked up from last time's `winners` first (the authoritative
 * record of what that value scored when it became the standard); if it is not there (e.g. the very first
 * learn after a manual override), we fall back to this round's freshly computed groups. If neither has it,
 * there is nothing to compare against, so the new candidate (if any) wins outright.
 */
function decideDimension(p: { candidate: GroupStat | undefined; oldValue: string | undefined; oldGroups: GroupStat[] | undefined; newGroups: GroupStat[] }): string | undefined {
  if (p.oldValue === undefined) return p.candidate?.value;
  const oldLift = p.oldGroups?.find((w) => w.value === p.oldValue)?.lift ?? p.newGroups.find((w) => w.value === p.oldValue)?.lift;
  // No old lift to compare against: fall back to this round's candidate, but never *drop* a standing value
  // just because nothing qualified this round -- that would silently erase a value the channel already
  // earned (changed=true, a spurious history entry, a spurious channel.learned_updated event) for no reason.
  if (oldLift === undefined) return p.candidate?.value ?? p.oldValue;
  if (p.candidate && p.candidate.lift >= oldLift * 1.10) return p.candidate.value;
  return p.oldValue;
}

function standardCoreOf(s: Standard | StandardCore | undefined): string {
  return JSON.stringify({ angle: s?.angle, title_pattern: s?.title_pattern, overlay_lines: s?.overlay_lines });
}

/**
 * Folds every `committed` package's evaluated (`supported|refuted`) hypothesis into one `ChannelLearned` row:
 * groups by angle / title pattern / overlay-line count, picks the highest-lift group per dimension that
 * clears `min_samples` and beats its refuted count, and only replaces an existing standard value when the new
 * candidate's lift is at least 10% better than the old one's. Always upserts `channel_learned`; only pushes
 * `history` and fires `channel.learned_updated` when the (note-less) `standard` actually changed.
 */
export function learnChannelStandard(d: { store: StateStore; clock: Clock; channel: LoadedChannel; durationOf: (pkg: ChannelPackage) => number | null }): { learned: ChannelLearned; changed: boolean } {
  const channelId = d.channel.config.channel_id;
  const now = d.clock.now();
  const minSamples = d.channel.config.learning.min_samples;

  const committed = d.store.listChannelPackages({ channel_id: channelId, status: "committed" });
  const evaluated = committed.filter((p) => (p.hypothesis.status === "supported" || p.hypothesis.status === "refuted") && p.hypothesis.evaluated);

  const metric = modeMetric(evaluated.map((p) => p.hypothesis.expected.metric));

  // medians: snapshotAtHorizon(72) of every PUBLISHED job of the channel.
  const views: number[] = [];
  const ctrs: number[] = [];
  const avgViewPcts: number[] = [];
  for (const job of d.store.listPublicationJobs({ channel_id: channelId, state: "PUBLISHED" })) {
    const snap = snapshotAtHorizon(d.store.listVideoMetrics({ publication_job_id: job.publication_job_id }), 72);
    if (!snap) continue;
    views.push(snap.views);
    if (snap.ctr_pct != null) ctrs.push(snap.ctr_pct);
    const pkg = d.store.getChannelPackage(job.package_id);
    const duration = pkg ? d.durationOf(pkg) : null;
    if (snap.avg_view_sec != null && duration != null && duration > 0) avgViewPcts.push((snap.avg_view_sec / duration) * 100);
  }
  const medians = { views_72h: median(views), ctr_pct: median(ctrs), avg_view_pct: median(avgViewPcts) };
  const medianForMetric = metric === "ctr" ? medians.ctr_pct : metric === "views_72h" ? medians.views_72h : metric === "avg_view_pct" ? medians.avg_view_pct : null;

  const sameMetric = evaluated.filter((p) => p.hypothesis.expected.metric === metric);
  const asItem = (p: ChannelPackage, value: string): { value: string; status: "supported" | "refuted"; metricValue: number } => (
    { value, status: p.hypothesis.status as "supported" | "refuted", metricValue: p.hypothesis.evaluated!.metric_value }
  );

  const angleGroups = computeGroups(
    sameMetric.map((p) => asItem(p, p.hypothesis.chosen.angle.trim().toLowerCase())).filter((it) => it.value !== ""),
    medianForMetric,
  );
  const titleGroups = computeGroups(sameMetric.map((p) => asItem(p, titlePattern(p.hypothesis.chosen.title))), medianForMetric);
  const overlayGroups = computeGroups(sameMetric.map((p) => asItem(p, overlayGroup(p.hypothesis.chosen.overlay_text))), medianForMetric);

  const angleCandidate = pickCandidate(angleGroups, minSamples);
  const titleCandidate = pickCandidate(titleGroups, minSamples);
  const overlayCandidate = pickCandidate(overlayGroups, minSamples);

  const old = d.store.getChannelLearned(channelId);

  const angle = decideDimension({ candidate: angleCandidate, oldValue: old?.standard.angle, oldGroups: old?.winners.angles, newGroups: angleGroups });
  const titlePatternValue = decideDimension({ candidate: titleCandidate, oldValue: old?.standard.title_pattern, oldGroups: old?.winners.title_patterns, newGroups: titleGroups });
  const overlayLines = decideDimension({ candidate: overlayCandidate, oldValue: old?.standard.overlay_lines, oldGroups: old?.winners.overlay, newGroups: overlayGroups }) as "0" | "1-2" | "3" | undefined;

  const n = evaluated.length;
  const note = angle === undefined && titlePatternValue === undefined && overlayLines === undefined
    ? `cần ≥${minSamples} giả thuyết supported cùng nhóm; hiện có ${n} đã đánh giá`
    : "";

  const standardCore: StandardCore = {
    ...(angle !== undefined ? { angle } : {}),
    ...(titlePatternValue !== undefined ? { title_pattern: titlePatternValue } : {}),
    ...(overlayLines !== undefined ? { overlay_lines: overlayLines } : {}),
  };
  const standard: Standard = { ...standardCore, note };

  const changed = standardCoreOf(standard) !== standardCoreOf(old?.standard);
  const history = changed ? [...(old?.history ?? []), { at: now, standard: standardCore }].slice(-20) : (old?.history ?? []);

  const learned: ChannelLearned = {
    schema_version: "harness.channel-learned/v1",
    channel_id: channelId,
    updated_at: now,
    sample_size: n,
    metric,
    medians,
    winners: { angles: angleGroups, title_patterns: titleGroups, overlay: overlayGroups },
    standard,
    history,
  };
  d.store.upsertChannelLearned(learned);

  if (changed) {
    d.store.appendEvent({
      run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
      channel_id: channelId, content_id: null, variant_id: null, workflow_release: null,
      severity: "info", event_type: "channel.learned_updated", payload: { channel_id: channelId, standard },
    });
  }

  return { learned, changed };
}
