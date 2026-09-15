import type { ChannelPackage, Clock, StateStore, VideoMetrics } from "@harness/contracts";
import type { LoadedChannel } from "../distribution/channels.js";

export type HypothesisMetric = "ctr" | "views_72h" | "avg_view_pct";

/**
 * `ctr` -> `ctr_pct` (may be `null`, e.g. below the impression floor -- caller decides `void`).
 * `views_72h` -> `views` (always present, never `null`).
 * `avg_view_pct` -> `avg_view_sec / durationSeconds * 100`; `null` when either input is missing or the
 * duration is not positive.
 */
export function metricValue(metric: HypothesisMetric, m: VideoMetrics, durationSeconds: number | null): number | null {
  if (metric === "ctr") return m.ctr_pct;
  if (metric === "views_72h") return m.views;
  if (m.avg_view_sec == null || durationSeconds == null || durationSeconds <= 0) return null;
  return (m.avg_view_sec / durationSeconds) * 100;
}

/** How far either side of the horizon a snapshot may sit and still count as "the horizon snapshot"
 * (spec §2.2: "`views_72h` = `views` của ảnh chụp có `age_hours` gần 72 nhất trong [60, 96]", generalised
 * from 72 to any `horizon_hours`). */
export const HORIZON_WINDOW_BEFORE_HOURS = 12;
export const HORIZON_WINDOW_AFTER_HOURS = 24;

/**
 * The snapshot (studio or manual) whose `age_hours` is CLOSEST to `horizonHours` within the window
 * `[horizon - 12, horizon + 24]` -- for the default 72 h horizon, exactly spec §2.2's "nearest within
 * [60, 96]". `undefined` when no snapshot falls in the window: the horizon has genuinely not been measured,
 * so `evaluateHypotheses` leaves the hypothesis `open` and `learnChannelStandard` leaves that job out of the
 * channel medians. The upper bound is the point of the window (final-review finding, sub-project 3B): with
 * only "first snapshot at or past the horizon", a job whose 72 h collect was blocked had its 168 h (or 720 h)
 * snapshot judged as if it were the 72 h number -- a week's worth of extra views scored against a 72 h target,
 * both in the verdict and in the medians every other job's `lift` is measured against.
 *
 * Ties (two snapshots equidistant from the horizon) go to the earlier element; callers pass
 * `listVideoMetrics`'s `collected_at`-ordered result, so that is the earlier collection.
 */
export function snapshotAtHorizon(list: VideoMetrics[], horizonHours: number): VideoMetrics | undefined {
  const low = horizonHours - HORIZON_WINDOW_BEFORE_HOURS;
  const high = horizonHours + HORIZON_WINDOW_AFTER_HOURS;
  let best: VideoMetrics | undefined;
  let bestDistance = Infinity;
  for (const m of list) {
    if (m.age_hours < low || m.age_hours > high) continue;
    const distance = Math.abs(m.age_hours - horizonHours);
    if (distance < bestDistance) {
      best = m;
      bestDistance = distance;
    }
  }
  return best;
}

export interface EvaluationReport {
  channel_id: string;
  evaluated: { hypothesis_id: string; package_id: string; status: "supported" | "refuted" | "void"; metric_value: number | null }[];
}

/**
 * Judges every `committed` package's still-`open` hypothesis against the video-metrics snapshot nearest its
 * `expected.horizon_hours` within `snapshotAtHorizon`'s window, writing the verdict back onto
 * `channel_package.hypothesis` (mirror update via `updateChannelPackage`, not `transition()` -- see ADR 0001)
 * and firing `hypothesis.evaluated`. A hypothesis with no snapshot in that window stays `open` and is skipped
 * (including the case where the horizon collect was missed entirely and only a much later snapshot exists);
 * anything already `supported|refuted|void` is skipped too, making this idempotent to call on every
 * `collectStats` sweep.
 */
export function evaluateHypotheses(d: { store: StateStore; clock: Clock; channel: LoadedChannel; durationOf: (pkg: ChannelPackage) => number | null }): EvaluationReport {
  const channelId = d.channel.config.channel_id;
  const now = d.clock.now();
  const minImpressions = d.channel.config.learning.min_impressions;
  const report: EvaluationReport = { channel_id: channelId, evaluated: [] };

  const jobByPackageId = new Map(d.store.listPublicationJobs({ channel_id: channelId, state: "PUBLISHED" }).map((j) => [j.package_id, j]));

  for (const pkg of d.store.listChannelPackages({ channel_id: channelId, status: "committed" })) {
    const h = pkg.hypothesis;
    if (h.status !== "open") continue;
    const job = jobByPackageId.get(pkg.package_id);
    if (!job) continue;

    const metrics = d.store.listVideoMetrics({ publication_job_id: job.publication_job_id });
    const snapshot = snapshotAtHorizon(metrics, h.expected.horizon_hours);
    if (!snapshot) continue; // stays open: no snapshot has reached the horizon yet

    const duration = d.durationOf(pkg);
    const value = metricValue(h.expected.metric, snapshot, duration);

    // An unreadable metric is `void`, never a verdict. The null check covers every metric at once
    // (final-review finding, sub-project 3B): a `ctr` snapshot whose impressions cleared the floor but whose
    // `ctr_pct` Studio never rendered used to fall through to `(null ?? 0) >= target` -> `refuted` with
    // `metric_value: 0`, which then dragged that group's mean -- and the channel standard -- down with a
    // number nobody ever measured. `avg_view_pct` is null when `avg_view_sec` is missing or the duration is
    // missing/not positive (`metricValue`); `views_72h` is never null, so it is unaffected.
    let status: "supported" | "refuted" | "void";
    if (value == null) {
      status = "void";
    } else if (h.expected.metric === "ctr" && (snapshot.impressions == null || snapshot.impressions < minImpressions)) {
      status = "void";
    } else {
      status = value >= h.expected.target ? "supported" : "refuted";
    }

    const updated: ChannelPackage = {
      ...pkg,
      hypothesis: { ...h, status, evaluated: { at: now, metric_value: value ?? 0, metric_id: snapshot.metric_id } },
      updated_at: now,
    };
    d.store.updateChannelPackage(updated);

    d.store.appendEvent({
      run_id: job.run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
      channel_id: channelId, content_id: null, variant_id: null, workflow_release: null,
      severity: "info", event_type: "hypothesis.evaluated",
      payload: { hypothesis_id: h.hypothesis_id, status, metric_value: value ?? 0 },
    });

    report.evaluated.push({ hypothesis_id: h.hypothesis_id, package_id: pkg.package_id, status, metric_value: value });
  }

  return report;
}
