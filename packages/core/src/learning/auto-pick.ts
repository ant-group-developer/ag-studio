import type { Clock, ExecutorRef, HarnessConfig, LibraryItem, ProductionProfile, Run, StateStore } from "@harness/contracts";
import type { AutoAcceptLogger } from "../library/auto-accept.js";
import { claimItem } from "../library/review.js";
import type { LibraryFs } from "../library/files.js";
import type { Planner } from "../orchestration/planner.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import type { LoadedChannel } from "../distribution/channels.js";
import { activeChannelPublishRuns, channelDemand } from "./planning.js";

export interface AutoPickDeps {
  store: StateStore; fs: LibraryFs; clock: Clock; channel: LoadedChannel; catalog: SourceCatalog; planner: Planner;
  harness: HarnessConfig; projectId: string; portfolioId: string; profile: ProductionProfile; workflows: (ref: string) => LoadedWorkflow;
  executorVersionFor: (ref: ExecutorRef) => string; libraryItems: LibraryItem[]; logger: AutoAcceptLogger;
}

export type AutoPickSkipReason = "concurrency" | "no-candidate" | "pick-failed";

/** Most recently created run against this content, or `undefined` when none exists. */
function newestRunOf(store: StateStore, contentId: string): Run | undefined {
  return store.listRuns({}).filter((r) => r.content_id === contentId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0];
}

/**
 * Picks and claims the next library item for this channel (spec §4.4): approved, not already claimed by this
 * channel, and not an item whose channel-publish attempt already FAILED or is WAITING (a human needs to look
 * at it, not have auto-pick retry it forever). Candidates targeted by one of the channel's own requests come
 * first (oldest request first, regardless of that request's current status); untargeted items only count when
 * the channel still has open demand, newest-approved first. One transaction per pick, mirroring `autoAccept`;
 * a failure is caught, logged and reported as `pick-failed` rather than thrown.
 */
export async function autoPick(d: AutoPickDeps): Promise<{ picked?: { item_id: string; run_id: string }; skipped?: AutoPickSkipReason }> {
  const { store } = d;
  const channelId = d.channel.config.channel_id;

  if (activeChannelPublishRuns(store, channelId).length >= d.channel.config.auto_pick.max_concurrent_runs) {
    return { skipped: "concurrency" };
  }

  const demand = channelDemand({
    store, clock: d.clock, channel: d.channel, libraryItems: d.libraryItems,
    libraryClaimsOf: (itemId) => d.fs.listClaims(itemId),
  });

  const eligible = d.libraryItems.filter((item) => {
    if (item.status !== "approved") return false;
    if (d.fs.listClaims(item.item_id).some((c) => c.channel_id === channelId)) return false;
    const content = store.listContentItems().find((c) => c.library_item_id === item.item_id && c.library_channel_id === channelId);
    if (content) {
      const newest = newestRunOf(store, content.content_id);
      if (newest && (newest.state === "FAILED" || newest.state === "WAITING")) return false;
    }
    return true;
  });

  // Group (a) matches by *owning channel*, not by request status: an item's originating request is almost
  // always already `fulfilled` by the time the item reaches `approved` (`applyReview` -> `fulfillRequest`
  // moves it there), so filtering to `open|claimed` here would miss the very items this group exists for.
  const requestOf = (requestId: string) => store.getContentRequest(requestId);
  const groupA = eligible
    .filter((item) => item.request_id !== undefined && requestOf(item.request_id)?.requested_by.channel_id === channelId)
    .sort((a, b) => {
      const ca = requestOf(a.request_id!)!.created_at;
      const cb = requestOf(b.request_id!)!.created_at;
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });
  const groupB = demand.needed > 0
    ? eligible.filter((item) => item.request_id === undefined).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    : [];

  const candidate = groupA[0] ?? groupB[0];
  if (!candidate) return { skipped: "no-candidate" };

  try {
    const runId = store.transaction(() => {
      const { content } = claimItem(
        { store, fs: d.fs, clock: d.clock, catalog: d.catalog },
        { item_id: candidate.item_id, channel_id: channelId, portfolio_id: d.portfolioId },
      );
      const { variant } = d.catalog.getOrCreateVariant({ content_id: content.content_id, profile: d.profile, options: {} });
      const run = d.planner.plan({
        workflow: d.workflows(d.profile.workflow_release), profile: d.profile, harness: d.harness, projectId: d.projectId,
        portfolioId: d.portfolioId, runOverrides: {}, executorVersionFor: d.executorVersionFor, content, variant,
      });
      d.planner.enqueue(run.run_id);
      store.appendEvent({
        run_id: run.run_id, stage_run_id: null, attempt_id: null, project_id: d.projectId, portfolio_id: d.portfolioId,
        channel_id: channelId, content_id: content.content_id, variant_id: variant.variant_id, workflow_release: d.profile.workflow_release,
        severity: "info", event_type: "channel.auto_picked", payload: { channel_id: channelId, item_id: candidate.item_id, run_id: run.run_id },
      });
      return run.run_id;
    });
    return { picked: { item_id: candidate.item_id, run_id: runId } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    d.logger.error("autoPick: pick failed", { channel_id: channelId, item_id: candidate.item_id, error: message });
    store.appendEvent({
      run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: channelId,
      content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "channel.auto_pick_failed",
      payload: { channel_id: channelId, item_id: candidate.item_id, reason: message },
    });
    return { skipped: "pick-failed" };
  }
}
