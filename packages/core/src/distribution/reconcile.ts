import { HarnessError, type Clock, type Publisher, type PublicationJob, type StateStore } from "@harness/contracts";
import type { ExternalOperationJournal } from "../orchestration/journal.js";
import type { Planner } from "../orchestration/planner.js";
import { releaseReconciledStage } from "../orchestration/reconcile.js";
import type { ChannelRegistry } from "./channels.js";
import { transitionPublication } from "./publication.js";

// Named distinctly from orchestration/reconcile.ts's `ReconcileDeps` (operation-level reconcile) to avoid a
// barrel-export name collision in @harness/core's index.ts — both modules are re-exported with `export *`.
export interface PublicationReconcileDeps { store: StateStore; publisher: Publisher; channels: ChannelRegistry; journal: ExternalOperationJournal; planner: Planner; clock: Clock }
export interface PublicationReconcileReport { job_id: string; from: "NEEDS_RECONCILIATION"; to: PublicationJob["state"]; video_id: string | null; stage_state?: string; note?: string }

/** A stage state from which the run can still make progress on its own once the job is fixed up. */
const LIVE_STAGE_STATES = new Set(["READY", "NEEDS_RECONCILIATION", "WAITING_HUMAN"]);
const NO_LIVE_STAGE_NOTE = "run has no live stage: schedule by hand in Studio then publish reconcile again, or publish cancel";

/**
 * Resolves one publication job stuck in NEEDS_RECONCILIATION by asking the publisher what actually happened
 * on the provider — the counterpart to `orchestration/reconcileOperation` for the distribution domain.
 * Looks up by `youtube_video_id` when the job already has one (the connection was lost after the video was
 * created), otherwise by title (the connection was lost before any video_id was ever recorded).
 */
export async function reconcilePublication(d: PublicationReconcileDeps, jobId: string): Promise<PublicationReconcileReport> {
  const job = d.store.getPublicationJob(jobId);
  if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${jobId}`, { publication_job_id: jobId });
  if (job.state !== "NEEDS_RECONCILIATION") {
    throw new HarnessError("INVALID_TRANSITION", `publication job ${jobId} is ${job.state}, not NEEDS_RECONCILIATION`, { publication_job_id: jobId, state: job.state });
  }
  const pkg = d.store.getChannelPackage(job.package_id);
  if (!pkg) throw new HarnessError("NOT_FOUND", `channel package not found: ${job.package_id}`, { package_id: job.package_id });

  const channel = d.channels.toPublisherChannel(job.channel_id);
  const op = job.operation_id ? d.store.getExternalOperation(job.operation_id) : undefined;

  const lookup = await d.publisher.lookup(
    job.youtube_video_id
      ? { channel, video_id: job.youtube_video_id }
      : { channel, title: pkg.metadata.title, ...(op?.created_at ? { since: op.created_at } : {}) },
  );

  // "I could not ask" is not "it is not there". Returning the job to READY here would hand the next `upload`
  // attempt permission to create a *second* video for an episode that may well already exist — so a failed
  // lookup leaves the job exactly as it is (NEEDS_RECONCILIATION) and exits non-zero for the operator.
  if (!lookup.found && lookup.error) {
    throw new HarnessError("CONNECTION_LOST", `lookup failed for publication job ${jobId}: ${lookup.reason}`, {
      publication_job_id: jobId, reason: lookup.reason,
    });
  }

  let to: PublicationJob["state"];
  let videoId: string | null = job.youtube_video_id;
  if (lookup.found) {
    videoId = lookup.video_id;
    if (lookup.visibility === "public") to = "PUBLISHED";
    else if ((lookup.visibility === "scheduled" || lookup.visibility === "private") && lookup.publish_at && Date.parse(lookup.publish_at) > Date.parse(d.clock.now())) to = "SCHEDULED";
    else to = "PROCESSING";
  } else {
    // Definitively not on the provider: the job starts over from scratch, so the video id it was carrying
    // (from a lost upload that evidently produced nothing) must go too, not linger on a READY job.
    to = "READY";
    videoId = null;
  }

  const updated = transitionPublication(d.store, jobId, "NEEDS_RECONCILIATION", to, { video_id: videoId, found: lookup.found });
  d.store.updatePublicationJob({
    ...updated, youtube_video_id: videoId,
    ...(to === "SCHEDULED" && lookup.found ? { scheduled_at: lookup.publish_at ?? updated.scheduled_at } : {}),
  });

  if (op) {
    if (lookup.found) {
      if (op.status !== "CONFIRMED") d.journal.confirmExternal(op.operation_id, { provider_ref: videoId!, receipt: { reconciled: true } });
    } else {
      d.journal.markFailed(op.operation_id, "not found on provider");
    }
  }

  let stageState: string | undefined;
  const stage = d.store.listStageRuns(job.run_id).find((s) => s.stage_key === "upload");
  if (stage) {
    releaseReconciledStage({ store: d.store, planner: d.planner, clock: d.clock }, stage.stage_run_id);
    stageState = d.store.getStageRun(stage.stage_run_id)?.state;
  }

  // A job put back to PROCESSING expects the run's `schedule` stage to pick it up. If neither `upload` nor
  // `schedule` is in a state the run can still move from (the run finished or failed long ago, e.g. the video
  // was uploaded by hand), nothing will ever book the slot -- say so instead of leaving a job that looks fine.
  let note: string | undefined;
  if (to === "PROCESSING") {
    const stages = d.store.listStageRuns(job.run_id).filter((s) => s.stage_key === "upload" || s.stage_key === "schedule");
    if (!stages.some((s) => LIVE_STAGE_STATES.has(s.state))) {
      note = NO_LIVE_STAGE_NOTE;
      const current = d.store.getPublicationJob(jobId)!;
      d.store.updatePublicationJob({ ...current, note });
    }
  }

  return {
    job_id: jobId, from: "NEEDS_RECONCILIATION", to, video_id: videoId,
    ...(stageState !== undefined ? { stage_state: stageState } : {}), ...(note !== undefined ? { note } : {}),
  };
}
