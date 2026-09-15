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

/** The first snapshot (studio or manual, in the list's own order -- callers pass `listVideoMetrics`'s
 * `collected_at`-ordered result) whose `age_hours` has reached `horizonHours`. */
export function snapshotAtHorizon(list: VideoMetrics[], horizonHours: number): VideoMetrics | undefined {
  return list.find((m) => m.age_hours >= horizonHours);
}

export interface EvaluationReport {
  channel_id: string;
  evaluated: { hypothesis_id: string; package_id: string; status: "supported" | "refuted" | "void"; metric_value: number | null }[];
}

/**
 * Judges every `committed` package's still-`open` hypothesis against the first video-metrics snapshot that
 * reached its `expected.horizon_hours`, writing the verdict back onto `channel_package.hypothesis` (mirror
 * update via `updateChannelPackage`, not `transition()` -- see ADR 0001) and firing `hypothesis.evaluated`.
 * A hypothesis with no snapshot yet stays `open` and is skipped; anything already `supported|refuted|void`
 * is skipped too, making this idempotent to call on every `collectStats` sweep.
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

    let status: "supported" | "refuted" | "void";
    if (h.expected.metric === "ctr" && (snapshot.impressions == null || snapshot.impressions < minImpressions)) {
      status = "void";
    } else if (h.expected.metric === "avg_view_pct" && (snapshot.avg_view_sec == null || duration == null)) {
      status = "void";
    } else {
      status = (value ?? 0) >= h.expected.target ? "supported" : "refuted";
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
