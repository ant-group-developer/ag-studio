import { ChannelBriefSchema, type ChannelBrief, type Clock, type LibraryItem, type StateStore } from "@harness/contracts";
import type { LoadedChannel } from "../distribution/channels.js";

/**
 * Assembles the `channel-brief.json` handed to the `package` stage (spec §3.3) and to `channel-planning`'s
 * `channel-brief` stage: everything a channel-aware agent needs to write metadata/hypotheses/topics that build
 * on what the channel already knows, without ever exposing a secret. `channel.publication` carries only
 * `timezone`/`publish_times` (never `youtube.account_email_ref`), and `channel.seo` is the channel's plain-text
 * SEO config -- neither field can ever contain a `secret://` string, which a dedicated test asserts on the
 * serialized JSON.
 */
export function buildChannelBrief(d: { store: StateStore; clock: Clock; channel: LoadedChannel; item?: LibraryItem | null }): ChannelBrief {
  const channelId = d.channel.config.channel_id;

  const learned = d.store.getChannelLearned(channelId) ?? null;

  const hypotheses = [...d.store.listChannelPackages({ channel_id: channelId, status: "committed" })]
    .sort((a, b) => b.episode_no - a.episode_no)
    .slice(0, 10)
    .map((pkg) => ({
      hypothesis_id: pkg.hypothesis.hypothesis_id,
      episode_no: pkg.episode_no,
      chosen: {
        title: pkg.hypothesis.chosen.title,
        angle: pkg.hypothesis.chosen.angle,
        overlay_text: pkg.hypothesis.chosen.overlay_text,
      },
      expected: pkg.hypothesis.expected,
      status: pkg.hypothesis.status,
      ...(pkg.hypothesis.evaluated ? { metric_value: pkg.hypothesis.evaluated.metric_value } : {}),
    }));

  const publishedJobs = d.store.listPublicationJobs({ channel_id: channelId, state: "PUBLISHED" })
    .filter((j): j is typeof j & { published_at: string } => j.published_at != null)
    .filter((j) => d.store.listVideoMetrics({ publication_job_id: j.publication_job_id }).length > 0)
    .sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0))
    .slice(0, 10);

  const recent_metrics: ChannelBrief["recent_metrics"] = [];
  for (const job of publishedJobs) {
    const pkg = d.store.getChannelPackage(job.package_id);
    if (!pkg) continue; // brief resolution: a job without a package is skipped
    const metrics = d.store.listVideoMetrics({ publication_job_id: job.publication_job_id });
    const latest = metrics.reduce((a, b) => (b.age_hours > a.age_hours ? b : a));
    recent_metrics.push({
      episode_no: pkg.episode_no,
      title: pkg.metadata.title,
      views: latest.views,
      impressions: latest.impressions,
      ctr_pct: latest.ctr_pct,
      avg_view_sec: latest.avg_view_sec,
      age_hours: latest.age_hours,
    });
  }

  const open_requests = [...d.store.listContentRequests({ status: "open" }), ...d.store.listContentRequests({ status: "claimed" })]
    .filter((r) => r.requested_by.channel_id === channelId)
    .map((r) => ({ request_id: r.request_id, topic: r.topic, status: r.status as "open" | "claimed" }));

  const brief: ChannelBrief = {
    schema_version: "harness.channel-brief/v1",
    generated_at: d.clock.now(),
    channel: {
      channel_id: channelId,
      display_name: d.channel.config.display_name,
      seo: d.channel.config.seo,
      publication: { timezone: d.channel.config.publication.timezone, publish_times: d.channel.config.publication.publish_times },
    },
    learned,
    hypotheses,
    recent_metrics,
    open_requests,
    item: d.item
      ? { item_id: d.item.item_id, title_hint: d.item.title_hint, summary: d.item.summary, duration_seconds: d.item.duration_seconds }
      : null,
  };

  return ChannelBriefSchema.parse(brief);
}
