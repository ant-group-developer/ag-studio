import type { Clock, LookupOutcome, Publisher, StateStore } from "@harness/contracts";
import type { ChannelRegistry } from "./channels.js";
import { transitionPublication } from "./publication.js";

export interface VerifyDeps { store: StateStore; publisher: Publisher; channels: ChannelRegistry; clock: Clock; graceHours: number }
export interface VerifyReport {
  checked: string[]; published: string[]; reconcile: string[];
  errors: { job_id: string; message: string }[]; warnings: { job_id: string; message: string }[];
}

const ACTIVE_VISIBILITIES = new Set(["scheduled", "private"]);

/**
 * Sweeps every SCHEDULED publication job whose `scheduled_at + graceHours` has passed and asks the publisher
 * to confirm what actually happened on the provider. A job not yet due is left untouched (no lookup, no
 * `checked` entry) — this is what lets `verifyScheduled` run on a tight interval without hammering the
 * provider for jobs that are simply not due yet.
 */
export async function verifyScheduled(d: VerifyDeps): Promise<VerifyReport> {
  const report: VerifyReport = { checked: [], published: [], reconcile: [], errors: [], warnings: [] };
  const now = d.clock.now();
  const nowMs = Date.parse(now);
  const graceMs = d.graceHours * 3600_000;

  for (const job of d.store.listPublicationJobs({ state: "SCHEDULED" })) {
    if (!job.scheduled_at) continue;
    if (Date.parse(job.scheduled_at) + graceMs > nowMs) continue;

    const channel = d.channels.toPublisherChannel(job.channel_id);
    const receipt = { ...(job.receipt ?? {}) } as Record<string, unknown>;

    let lookup: LookupOutcome;
    try {
      lookup = await d.publisher.lookup({ channel, ...(job.youtube_video_id ? { video_id: job.youtube_video_id } : {}) });
    } catch (e) {
      report.checked.push(job.publication_job_id);
      const failures = (typeof receipt.verify_failures === "number" ? receipt.verify_failures : 0) + 1;
      receipt.verify_failures = failures;
      if (failures >= 2) {
        const updated = transitionPublication(d.store, job.publication_job_id, "SCHEDULED", "NEEDS_RECONCILIATION", { reason: "lookup failed twice" });
        d.store.updatePublicationJob({ ...updated, receipt, last_verified_at: now, note: "lookup failed twice in a row" });
        report.reconcile.push(job.publication_job_id);
      } else {
        d.store.updatePublicationJob({ ...job, receipt, last_verified_at: now });
        report.errors.push({ job_id: job.publication_job_id, message: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }

    report.checked.push(job.publication_job_id);
    receipt.verify_failures = 0;

    if (lookup.found && lookup.visibility === "public") {
      const updated = transitionPublication(d.store, job.publication_job_id, "SCHEDULED", "PUBLISHED", { video_id: lookup.video_id });
      d.store.updatePublicationJob({
        ...updated, receipt, last_verified_at: now, youtube_video_id: lookup.video_id, published_at: lookup.publish_at ?? now,
      });
      report.published.push(job.publication_job_id);
    } else if (lookup.found && ACTIVE_VISIBILITIES.has(lookup.visibility) && lookup.publish_at && Date.parse(lookup.publish_at) > nowMs) {
      d.store.updatePublicationJob({
        ...job, receipt, last_verified_at: now, scheduled_at: lookup.publish_at !== job.scheduled_at ? lookup.publish_at : job.scheduled_at,
      });
    } else {
      const reason = !lookup.found ? (lookup.reason ?? "not found on provider") : lookup.visibility === "unlisted" ? "unlisted on provider" : "private with no scheduled publish_at";
      const updated = transitionPublication(d.store, job.publication_job_id, "SCHEDULED", "NEEDS_RECONCILIATION", { reason });
      d.store.updatePublicationJob({ ...updated, receipt, last_verified_at: now, note: reason });
      report.reconcile.push(job.publication_job_id);
    }
  }

  for (const job of d.store.listPublicationJobs({ state: "PROCESSING" })) {
    if (nowMs - Date.parse(job.updated_at) > 24 * 3600_000) {
      report.warnings.push({ job_id: job.publication_job_id, message: `publication job ${job.publication_job_id} has been PROCESSING for over 24h` });
    }
  }

  return report;
}
