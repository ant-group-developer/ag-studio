import {
  DemandSchema,
  type Clock, type Demand, type ExecutorRef, type HarnessConfig, type LibraryClaim, type LibraryItem,
  type ProductionProfile, type Run, type StateStore,
} from "@harness/contracts";
import type { AutoAcceptLogger } from "../library/auto-accept.js";
import { startPlannedRun } from "../library/start-run.js";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import { nextSlot, type SlotPolicy } from "../distribution/publication.js";
import type { LoadedChannel } from "../distribution/channels.js";
import { isTerminal } from "../state/transitions.js";
import { recentlyEmitted } from "./metrics.js";

function slotPolicyOf(channel: LoadedChannel): SlotPolicy {
  const p = channel.config.publication;
  return { timezone: p.timezone, publish_times: p.publish_times, max_daily_uploads: p.max_daily_uploads, min_gap_hours: p.min_gap_hours };
}

/** Every run of the given workflow id whose content belongs to this channel (`ContentItem.library_channel_id
 * === channel_id`). Mirrors auto-accept's `requestIdForRun` pattern of joining through `run.content_id`. */
export function channelWorkflowRuns(store: StateStore, channelId: string, workflowId: string): Run[] {
  const out: Run[] = [];
  for (const run of store.listRuns({})) {
    if (run.workflow_release.id !== workflowId) continue;
    if (!run.content_id) continue;
    const content = store.getContentItem(run.content_id);
    if (content?.library_channel_id !== channelId) continue;
    out.push(run);
  }
  return out;
}

/** Active (non-terminal) `channel-publish` runs of this channel. */
export function activeChannelPublishRuns(store: StateStore, channelId: string): Run[] {
  return channelWorkflowRuns(store, channelId, "channel-publish").filter((r) => !isTerminal("run", r.state));
}

export function channelDemand(d: {
  store: StateStore; clock: Clock; channel: LoadedChannel; libraryItems: LibraryItem[]; libraryClaimsOf: (itemId: string) => LibraryClaim[];
}): Demand {
  const channelId = d.channel.config.channel_id;
  const now = d.clock.now();
  const policy = slotPolicyOf(d.channel);

  const jobs = d.store.listPublicationJobs({ channel_id: channelId });
  const taken = jobs
    .filter((j) => j.state === "SCHEDULED" || j.state === "PUBLISHED")
    .map((j) => j.scheduled_at ?? j.published_at)
    .filter((t): t is string => t != null);

  // `nextSlot` throws CONFIG_INVALID when no free slot exists within its own 60-day search window (an
  // exceptionally packed publish policy) -- channelDemand must never throw for that, so a channel simply gets
  // fewer slots (and therefore less computed demand) instead of blowing up the caller.
  const slots: string[] = [];
  const takenForSlots = [...taken];
  for (let i = 0; i < d.channel.config.planning.lookahead_slots; i++) {
    let slot: string;
    try {
      slot = nextSlot(policy, takenForSlots, now);
    } catch {
      break;
    }
    slots.push(slot);
    takenForSlots.push(slot);
  }

  const jobsCovered = jobs.filter((j) => j.state === "PROCESSING" || j.state === "SCHEDULED").length;
  const runsCovered = activeChannelPublishRuns(d.store, channelId).length;

  const requestsOfChannel = [...d.store.listContentRequests({ status: "open" }), ...d.store.listContentRequests({ status: "claimed" })]
    .filter((r) => r.requested_by.channel_id === channelId);

  // An approved item carrying a request_id counts as covered by matching that request's *owning channel*, not
  // by the request's current status: `applyReview` moves a request to `fulfilled` the moment its item is
  // approved (`fulfillRequest`), so by the time an item can even be `approved` its own originating request has
  // almost always already left open|claimed -- restricting to open|claimed here would miss nearly every
  // request-targeted approved item and inflate `needed`. `requestsCovered`/`open_requests` below stay scoped
  // to open|claimed on purpose: those count requests the studio is still actively working, not items already
  // sitting in the kho.
  const itemsCovered = d.libraryItems.filter((item) => {
    if (item.status !== "approved") return false;
    if (d.libraryClaimsOf(item.item_id).some((c) => c.channel_id === channelId)) return false;
    if (item.request_id) return d.store.getContentRequest(item.request_id)?.requested_by.channel_id === channelId;
    return true;
  }).length;

  const requestsCovered = requestsOfChannel.length;

  const covered = jobsCovered + runsCovered + itemsCovered + requestsCovered;
  const needed = Math.max(0, slots.length - covered);
  const open_requests = requestsOfChannel.filter((r) => r.status === "open").length;

  const demand: Demand = {
    schema_version: "harness.demand/v1",
    channel_id: channelId,
    needed,
    slots,
    covered: { jobs: jobsCovered, runs: runsCovered, items: itemsCovered, requests: requestsCovered },
    open_requests,
    max_open_requests: d.channel.config.planning.max_open_requests,
  };
  return DemandSchema.parse(demand);
}

export function planningNeeded(demand: Demand): boolean {
  return demand.needed > 0 && demand.open_requests < demand.max_open_requests;
}

export interface PlanRequestsDeps {
  store: StateStore; clock: Clock; channel: LoadedChannel; catalog: SourceCatalog; planner: Planner; harness: HarnessConfig;
  projectId: string; portfolioId: string; profile: ProductionProfile; workflows: (ref: string) => LoadedWorkflow;
  executorVersionFor: (ref: ExecutorRef) => string; libraryItems: LibraryItem[]; libraryClaimsOf: (itemId: string) => LibraryClaim[];
  logger: AutoAcceptLogger;
}

export type PlanRequestsSkipReason = "covered" | "open-cap" | "run-active" | "cooldown" | "plan-failed";

/** UTC calendar date (`YYYY-MM-DD`) of an ISO timestamp -- used both for the `planning <channel_id> <date>`
 * content title and for the once-per-day `channel.planning_skipped` dedup key. */
function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Same-day (UTC) dedup for `channel.planning_skipped`: a reason already emitted for this channel today is
 * not re-emitted every poll. */
function skippedAlreadyEmittedToday(store: StateStore, channelId: string, reason: string, now: string): boolean {
  const today = utcDate(now);
  return store.listEvents({ event_type: "channel.planning_skipped", newest: true })
    .some((e) => e.payload.channel_id === channelId && e.payload.reason === reason && utcDate(e.occurred_at) === today);
}

/**
 * Starts a `channel-planning` run when the channel needs more episodes queued (spec §4.3). Never throws: every
 * read (including `channelDemand` itself) and the whole plan/enqueue transaction are covered by one `try`, so
 * any failure -- inside or outside the transaction -- is caught, logged, and recorded as `channel.planning_failed`
 * outside the (possibly rolled-back) transaction; the failure itself puts the channel into a 24h cooldown via
 * `recentlyEmitted` on the next call.
 */
export async function planRequestsRun(d: PlanRequestsDeps): Promise<{ started?: { run_id: string; needed: number }; skipped?: PlanRequestsSkipReason }> {
  const { store } = d;
  const channelId = d.channel.config.channel_id;
  const now = d.clock.now();

  try {
    const demand = channelDemand({ store, clock: d.clock, channel: d.channel, libraryItems: d.libraryItems, libraryClaimsOf: d.libraryClaimsOf });

    if (!planningNeeded(demand)) {
      const reason: PlanRequestsSkipReason = demand.needed <= 0 ? "covered" : "open-cap";
      if (!skippedAlreadyEmittedToday(store, channelId, reason, now)) {
        store.appendEvent({
          run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: channelId,
          content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "channel.planning_skipped",
          payload: { channel_id: channelId, reason },
        });
      }
      return { skipped: reason };
    }

    // Anchored with a trailing space so a sibling channel id that is a string-prefix of this one (e.g.
    // "channel-a" vs "channel-a-shorts") can never match; also requires the run to actually be the
    // `channel-planning` workflow, not merely a run whose content happens to share the title convention.
    // Any *non-terminal* such run blocks a new one outright (still working); a *terminal* one blocks only for
    // the rest of today (`content.title` embeds `utcDate(now)`) -- a planning run that finished (successfully
    // or not) without covering demand must not be retried every poll for the rest of the day.
    const titlePrefix = `planning ${channelId} `;
    const todayTitle = `${titlePrefix}${utcDate(now)}`;
    const runActive = store.listRuns({}).some((run) => {
      if (run.workflow_release.id !== "channel-planning") return false;
      if (!run.content_id) return false;
      const content = store.getContentItem(run.content_id);
      if (!content?.title.startsWith(titlePrefix)) return false;
      if (!isTerminal("run", run.state)) return true;
      return content.title === todayTitle;
    });
    if (runActive) return { skipped: "run-active" };

    if (recentlyEmitted(store, "channel.planning_failed", now, (payload) => payload.channel_id === channelId)) {
      return { skipped: "cooldown" };
    }

    const runId = store.transaction(() => {
      const content = d.catalog.createContent({ source_ids: [], title: todayTitle, library_channel_id: channelId });
      const run = startPlannedRun(
        {
          store, catalog: d.catalog, planner: d.planner, harness: d.harness, projectId: d.projectId, portfolioId: d.portfolioId,
          profile: d.profile, workflows: d.workflows, executorVersionFor: d.executorVersionFor,
        },
        content,
        {
          event_type: "channel.planning_started", channel_id: channelId,
          payload: (runId) => ({ channel_id: channelId, needed: demand.needed, run_id: runId }),
        },
      );
      return run.run_id;
    });
    return { started: { run_id: runId, needed: demand.needed } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    d.logger.error("planRequestsRun: plan failed", { channel_id: channelId, error: message });
    store.appendEvent({
      run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: channelId,
      content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "channel.planning_failed",
      payload: { channel_id: channelId, reason: message },
    });
    return { skipped: "plan-failed" };
  }
}
