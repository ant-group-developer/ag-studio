import {
  newId, type ChannelPackage, type Clock, type PublicationJob, type StateStore, type StatsCollector,
  type StatsOutcome, type VideoMetrics,
} from "@harness/contracts";
import type { ChannelRegistry, LoadedChannel } from "../distribution/channels.js";
import { evaluateHypotheses, type EvaluationReport } from "./hypotheses.js";
import { learnChannelStandard } from "./learned.js";

export interface DueCollection { job: PublicationJob; target_age_hours: number }

export function ageHours(publishedAt: string, now: string): number {
  return (Date.parse(now) - Date.parse(publishedAt)) / 3_600_000;
}

/**
 * Every `PUBLISHED` job of the channel that has reached one of its collection targets (`horizon_hours`, then
 * each `recollect_hours`) and has no `source: "studio"` snapshot already covering that target (a `manual`
 * import never counts -- it does not answer "did the collector actually run"). Sorted by due time ascending,
 * then capped to `batch`.
 */
export function collectDue(store: StateStore, channel: LoadedChannel, now: string, batch: number): DueCollection[] {
  const targets = [channel.config.learning.horizon_hours, ...channel.config.learning.recollect_hours];
  const nowMs = Date.parse(now);
  const jobs = store.listPublicationJobs({ channel_id: channel.config.channel_id, state: "PUBLISHED" }).filter((j) => j.published_at);

  const due: DueCollection[] = [];
  for (const job of jobs) {
    const publishedMs = Date.parse(job.published_at!);
    const studioAges = store.listVideoMetrics({ publication_job_id: job.publication_job_id })
      .filter((m) => m.source === "studio").map((m) => m.age_hours);
    for (const t of targets) {
      if (nowMs < publishedMs + t * 3_600_000) continue;
      if (studioAges.some((age) => age >= t - 6)) continue;
      due.push({ job, target_age_hours: t });
    }
  }

  due.sort((a, b) => (Date.parse(a.job.published_at!) + a.target_age_hours * 3_600_000) - (Date.parse(b.job.published_at!) + b.target_age_hours * 3_600_000));
  return due.slice(0, batch);
}

export interface CollectDeps {
  store: StateStore;
  collector: StatsCollector;
  channels: ChannelRegistry;
  clock: Clock;
  batch: number;
  /** Injected by the caller (Task 6's worker sweep provides it from the package manifest / library mirror):
   * `evaluateHypotheses`/`learnChannelStandard` both need it to compute `avg_view_pct`, and this interface
   * as given in the brief omitted it even though `collectStats` must call both after every channel it
   * collects for -- added here so the module actually compiles and the dependency is explicit. */
  durationOf: (pkg: ChannelPackage) => number | null;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
}

export interface CollectReport {
  collected: { job_id: string; metric_id: string; age_hours: number }[];
  blocked: string[];
  failed: { job_id: string; reason: string }[];
  evaluated: EvaluationReport[];
  learned: string[];
}

/** Newest event of `eventType` whose payload satisfies `matches`, deduped to a 24h window against `now` --
 * mirrors `auto-accept.ts`'s `listEvents({ event_type, newest: true })` pattern but adds the time check the
 * brief's dedup rule calls for (an old blocked/failing event must eventually be re-raised). `listEvents({
 * newest: true })` orders `occurred_at DESC` and then reverses the page before returning it, so the array
 * comes back OLDEST-first within the newest-1000 window -- `.find` would grab the earliest match and dedupe
 * forever after the first 24h; the last matching element is the actually-newest one. */
function recentlyEmitted(store: StateStore, eventType: string, now: string, matches: (payload: Record<string, unknown>) => boolean): boolean {
  const latest = store.listEvents({ event_type: eventType, newest: true }).filter((e) => matches(e.payload)).at(-1);
  if (!latest) return false;
  return Date.parse(now) - Date.parse(latest.occurred_at) < 24 * 3_600_000;
}

/**
 * One sweep across every channel (or just `o.channelId`): collects due videos' stats via `d.collector`,
 * records them append-only in `video_metrics`, and folds any channel it actually collected something for
 * through `evaluateHypotheses` + `learnChannelStandard`. Never throws: a `blocked` channel is skipped for
 * the rest of this sweep (its videos stay due for next time); a per-video `error` only counts against that
 * job's own `receipt.collect_failures`; a job with no `youtube_video_id` or a negative computed age is
 * skipped and reported in `failed` without ever calling the collector; any other unexpected failure while
 * processing one due item (a store write throwing, a schema-invalid outcome, etc.) is caught, logged and
 * reported in `failed` too; and a failure in the per-channel `evaluateHypotheses`/`learnChannelStandard`
 * pass is caught and logged rather than aborting the rest of the sweep. Nothing here ever stops another
 * video, another channel, or the sweep as a whole.
 */
export async function collectStats(d: CollectDeps, o?: { channelId?: string; jobId?: string; force?: boolean }): Promise<CollectReport> {
  const report: CollectReport = { collected: [], blocked: [], failed: [], evaluated: [], learned: [] };
  const now = d.clock.now();
  const channels = o?.channelId ? [d.channels.get(o.channelId)] : d.channels.list();

  for (const channel of channels) {
    const channelId = channel.config.channel_id;
    let due: DueCollection[];
    if (o?.force) {
      let jobs = d.store.listPublicationJobs({ channel_id: channelId, state: "PUBLISHED" }).filter((j) => j.published_at);
      if (o.jobId) jobs = jobs.filter((j) => j.publication_job_id === o.jobId);
      due = jobs.map((job) => ({ job, target_age_hours: ageHours(job.published_at!, now) }));
    } else {
      due = collectDue(d.store, channel, now, d.batch);
      if (o?.jobId) due = due.filter((x) => x.job.publication_job_id === o.jobId);
    }

    let collectedCount = 0;
    for (const { job } of due) {
      try {
        if (!job.youtube_video_id) {
          report.failed.push({ job_id: job.publication_job_id, reason: "no video id" });
          continue;
        }
        const ageH = ageHours(job.published_at!, now);
        if (ageH < 0) {
          report.failed.push({ job_id: job.publication_job_id, reason: "negative age_hours" });
          continue;
        }

        const publisherChannel = d.channels.toPublisherChannel(channelId);
        let outcome: StatsOutcome;
        try {
          outcome = await d.collector.collect({ channel: publisherChannel, video_id: job.youtube_video_id, timeout_seconds: 120 });
        } catch (e) {
          outcome = { kind: "error", reason: e instanceof Error ? e.message : String(e) };
        }

        if (outcome.kind === "blocked") {
          const alreadyBlocked = recentlyEmitted(d.store, "stats.blocked", now, (payload) => payload.channel_id === channelId);
          if (!alreadyBlocked) {
            d.store.appendEvent({
              run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
              channel_id: channelId, content_id: null, variant_id: null, workflow_release: null,
              severity: "warn", event_type: "stats.blocked", payload: { channel_id: channelId, reason: outcome.reason },
            });
          }
          d.logger.warn("collectStats: channel blocked", { channel_id: channelId, reason: outcome.reason });
          report.blocked.push(channelId);
          break; // stop this channel; other channels still get their turn
        }

        if (outcome.kind === "error") {
          const current = d.store.getPublicationJob(job.publication_job_id)!;
          const receipt: Record<string, unknown> = { ...(current.receipt ?? {}) };
          const failures = (typeof receipt.collect_failures === "number" ? receipt.collect_failures : 0) + 1;
          receipt.collect_failures = failures;
          d.store.updatePublicationJob({ ...current, receipt });
          d.logger.warn("collectStats: collect failed", { job_id: job.publication_job_id, reason: outcome.reason });
          report.failed.push({ job_id: job.publication_job_id, reason: outcome.reason });
          if (failures >= 3) {
            const alreadyFailing = recentlyEmitted(d.store, "stats.failing", now, (payload) => payload.job_id === job.publication_job_id);
            if (!alreadyFailing) {
              d.store.appendEvent({
                run_id: job.run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
                channel_id: channelId, content_id: null, variant_id: null, workflow_release: null,
                severity: "error", event_type: "stats.failing", payload: { job_id: job.publication_job_id },
              });
            }
          }
          continue;
        }

        // ok | no-views
        const metric: VideoMetrics = {
          schema_version: "harness.video-metrics/v1",
          metric_id: newId("video_metrics"),
          publication_job_id: job.publication_job_id,
          channel_id: channelId,
          video_id: job.youtube_video_id,
          collected_at: now,
          age_hours: ageH,
          source: "studio",
          views: outcome.kind === "ok" ? outcome.views : 0,
          impressions: outcome.kind === "ok" ? outcome.impressions ?? null : null,
          ctr_pct: outcome.kind === "ok" ? outcome.ctr_pct ?? null : null,
          avg_view_sec: outcome.kind === "ok" ? outcome.avg_view_sec ?? null : null,
          retention30_pct: outcome.kind === "ok" ? outcome.retention30_pct ?? null : null,
        };
        d.store.insertVideoMetrics(metric);
        d.store.appendEvent({
          run_id: job.run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
          channel_id: channelId, content_id: null, variant_id: null, workflow_release: null,
          severity: "info", event_type: "stats.collected", payload: { job_id: job.publication_job_id, metric_id: metric.metric_id },
        });

        const current = d.store.getPublicationJob(job.publication_job_id)!;
        d.store.updatePublicationJob({ ...current, receipt: { ...(current.receipt ?? {}), collect_failures: 0 } });

        report.collected.push({ job_id: job.publication_job_id, metric_id: metric.metric_id, age_hours: ageH });
        collectedCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        d.logger.error("collectStats: unexpected error processing job", { job_id: job.publication_job_id, error: message });
        report.failed.push({ job_id: job.publication_job_id, reason: message });
      }
    }

    if (collectedCount > 0) {
      try {
        report.evaluated.push(evaluateHypotheses({ store: d.store, clock: d.clock, channel, durationOf: d.durationOf }));
        const { changed } = learnChannelStandard({ store: d.store, clock: d.clock, channel, durationOf: d.durationOf });
        if (changed) report.learned.push(channelId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        d.logger.error("collectStats: evaluate/learn failed", { channel_id: channelId, error: message });
      }
    }
  }

  return report;
}

/**
 * Imports the legacy `channel-metrics.jsonl` register: every line is matched to a `PublicationJob` by
 * `youtube_video_id`, inserted as a `source: "manual"` snapshot. A `$schema` line is dropped silently (not
 * counted as skipped); a line whose `videoId` matches no job is skipped and reported.
 */
export function importMetrics(store: StateStore, p: { channel_id: string; jsonl: string; clock: Clock }): { imported: number; skipped: { videoId: string; why: string }[] } {
  const lines = p.jsonl.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const jobs = store.listPublicationJobs({ channel_id: p.channel_id });
  let imported = 0;
  const skipped: { videoId: string; why: string }[] = [];

  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped.push({ videoId: "", why: "invalid JSON" });
      continue;
    }
    if ("$schema" in row) continue;

    const videoId = typeof row.videoId === "string" ? row.videoId : "";
    const job = jobs.find((j) => j.youtube_video_id === videoId);
    if (!job) {
      skipped.push({ videoId, why: "no matching publication job" });
      continue;
    }
    if (typeof row.views !== "number") {
      skipped.push({ videoId, why: "no views" });
      continue;
    }
    const publishedAt = job.published_at ?? (typeof row.publishedAt === "string" ? row.publishedAt : undefined);
    if (!publishedAt) {
      skipped.push({ videoId, why: "no published_at" });
      continue;
    }
    const collectedAt = typeof row.collectedAt === "string" ? row.collectedAt : p.clock.now();
    const age = ageHours(publishedAt, collectedAt);
    if (age < 0) {
      skipped.push({ videoId, why: "negative age" });
      continue;
    }
    const metric: VideoMetrics = {
      schema_version: "harness.video-metrics/v1",
      metric_id: newId("video_metrics"),
      publication_job_id: job.publication_job_id,
      channel_id: p.channel_id,
      video_id: videoId,
      collected_at: collectedAt,
      age_hours: age,
      source: "manual",
      views: row.views,
      impressions: typeof row.impressions === "number" ? row.impressions : null,
      ctr_pct: typeof row.ctr_pct === "number" ? row.ctr_pct : null,
      avg_view_sec: typeof row.avg_view_sec === "number" ? row.avg_view_sec : null,
      retention30_pct: typeof row.retention30_pct === "number" ? row.retention30_pct : null,
    };
    store.insertVideoMetrics(metric);
    imported++;
  }

  return { imported, skipped };
}
