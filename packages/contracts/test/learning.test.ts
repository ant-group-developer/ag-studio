import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { ChannelConfigSchema, ProductionProfileSchema, ProjectConfigSchema } from "../src/config.js";
import { HypothesisSchema } from "../src/distribution.js";
import {
  ChannelBriefSchema, ChannelLearnedSchema, DemandSchema, TopicProposalSchema, VideoMetricsSchema,
} from "../src/learning.js";

const now = "2026-09-14T00:00:00.000Z";

const MINIMAL_CHANNEL_CONFIG = {
  schema_version: "harness.channel-config/v1",
  channel_id: "channel-a",
  display_name: "Channel A",
  portfolio_id: "portfolio-main",
  repo_dir: "E:/channels/channel-a",
  youtube: { expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", account_email_ref: "secret://youtube/channel-a-email" },
  publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"] },
};

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1",
  hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market", note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png" },
  rejected: [{ title: "Alt Title", why: "weaker hook" }],
  expected: { metric: "ctr", target: 0.05, horizon_hours: 72 },
  created_at: now,
};

function videoMetrics(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "harness.video-metrics/v1",
    metric_id: newId("video_metrics"),
    publication_job_id: newId("publication_job"),
    channel_id: "channel-a",
    video_id: "yt-video-1",
    collected_at: now,
    age_hours: 72,
    source: "studio",
    views: 1000,
    impressions: 20000,
    ctr_pct: 5,
    avg_view_sec: 120,
    retention30_pct: 40,
    ...overrides,
  };
}

describe("VideoMetricsSchema", () => {
  it("parses a valid sample", () => {
    const parsed = VideoMetricsSchema.parse(videoMetrics());
    expect(parsed.views).toBe(1000);
  });
  it("rejects ctr_pct over 100", () => {
    expect(VideoMetricsSchema.safeParse(videoMetrics({ ctr_pct: 101 })).success).toBe(false);
  });
  it("accepts nullable impressions/ctr_pct/avg_view_sec/retention30_pct", () => {
    const parsed = VideoMetricsSchema.parse(videoMetrics({ impressions: null, ctr_pct: null, avg_view_sec: null, retention30_pct: null }));
    expect(parsed.impressions).toBeNull();
  });
});

describe("ChannelLearnedSchema", () => {
  it("parses a valid sample with winners and history", () => {
    const parsed = ChannelLearnedSchema.parse({
      schema_version: "harness.channel-learned/v1",
      channel_id: "channel-a",
      updated_at: now,
      sample_size: 10,
      metric: "ctr",
      medians: { views_72h: 5000, ctr_pct: 4.5, avg_view_pct: 40 },
      winners: {
        angles: [{ value: "myth-busting", supported: 3, refuted: 1, lift: 0.2 }],
        title_patterns: [{ value: "number+question+short", supported: 2, refuted: 0, lift: 0.5 }],
        overlay: [{ value: "1-2", supported: 4, refuted: 2, lift: 0.1 }],
      },
      standard: { angle: "myth-busting", title_pattern: "number+question+short", overlay_lines: "1-2", note: "based on 10 episodes" },
      history: [{ at: now, standard: { angle: "myth-busting" } }],
    });
    expect(parsed.winners.angles[0]?.value).toBe("myth-busting");
    expect(parsed.history).toHaveLength(1);
  });
  it("defaults standard.note and history to empty", () => {
    const parsed = ChannelLearnedSchema.parse({
      schema_version: "harness.channel-learned/v1", channel_id: "channel-a", updated_at: now, sample_size: 0, metric: null,
      medians: { views_72h: null, ctr_pct: null, avg_view_pct: null },
      winners: { angles: [], title_patterns: [], overlay: [] },
      standard: {},
    });
    expect(parsed.standard.note).toBe("");
    expect(parsed.history).toEqual([]);
  });
});

describe("ChannelBriefSchema", () => {
  it("parses a valid sample", () => {
    const parsed = ChannelBriefSchema.parse({
      schema_version: "harness.channel-brief/v1",
      generated_at: now,
      channel: {
        channel_id: "channel-a", display_name: "Channel A",
        seo: { language: "vi" },
        publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"] },
      },
      learned: null,
      hypotheses: [{
        hypothesis_id: newId("hypothesis"), episode_no: 3,
        chosen: { title: "Why This Works", angle: "myth-busting", overlay_text: ["hook"] },
        expected: { metric: "ctr", target: 0.05, horizon_hours: 72 },
        status: "open",
      }],
      recent_metrics: [{ episode_no: 2, title: "Prior Episode", views: 1000, impressions: 20000, ctr_pct: 5, avg_view_sec: 120, age_hours: 72 }],
      open_requests: [{ request_id: newId("content_request"), topic: "topic X", status: "open" }],
      item: { item_id: newId("library_item"), title_hint: "hint", summary: "summary", duration_seconds: 480 },
    });
    expect(parsed.channel.seo.language).toBe("vi");
    expect(parsed.item?.duration_seconds).toBe(480);
  });
  it("accepts a null item and empty arrays", () => {
    const parsed = ChannelBriefSchema.parse({
      schema_version: "harness.channel-brief/v1", generated_at: now,
      channel: { channel_id: "channel-a", display_name: "Channel A", seo: {}, publication: { timezone: "UTC", publish_times: [] } },
      learned: null, hypotheses: [], recent_metrics: [], open_requests: [], item: null,
    });
    expect(parsed.item).toBeNull();
  });
});

describe("TopicProposalSchema", () => {
  it("parses a valid sample and defaults angle", () => {
    const parsed = TopicProposalSchema.parse({
      schema_version: "harness.topic-proposal/v1",
      topics: [{ topic: "a topic long enough", why: "audience demand" }],
    });
    expect(parsed.topics[0]?.angle).toBe("");
  });
  it("rejects an empty topics array", () => {
    expect(TopicProposalSchema.safeParse({ schema_version: "harness.topic-proposal/v1", topics: [] }).success).toBe(false);
  });
  it("rejects more than 10 topics", () => {
    const topics = Array.from({ length: 11 }, (_, i) => ({ topic: `topic number ${i} long enough`, why: "demand" }));
    expect(TopicProposalSchema.safeParse({ schema_version: "harness.topic-proposal/v1", topics }).success).toBe(false);
  });
});

describe("DemandSchema", () => {
  it("parses a valid sample", () => {
    const parsed = DemandSchema.parse({
      schema_version: "harness.demand/v1", channel_id: "channel-a", needed: 2,
      slots: [now], covered: { jobs: 1, runs: 1, items: 1, requests: 0 },
      open_requests: 0, max_open_requests: 3,
    });
    expect(parsed.needed).toBe(2);
  });
});

describe("HypothesisSchema.evaluated", () => {
  it("is optional and absent by default", () => {
    expect(HypothesisSchema.parse(SAMPLE_HYPOTHESIS).evaluated).toBeUndefined();
  });
  it("parses when present", () => {
    const parsed = HypothesisSchema.parse({
      ...SAMPLE_HYPOTHESIS,
      evaluated: { at: now, metric_value: 0.06, metric_id: newId("video_metrics") },
    });
    expect(parsed.evaluated?.metric_value).toBe(0.06);
  });
});

describe("ChannelConfigSchema learning/planning/auto_pick defaults", () => {
  it("applies defaults when a channel.yaml carries none of the new blocks", () => {
    const parsed = ChannelConfigSchema.parse(MINIMAL_CHANNEL_CONFIG);
    expect(parsed.learning.horizon_hours).toBe(72);
    expect(parsed.learning.recollect_hours).toEqual([168, 720]);
    expect(parsed.learning.min_impressions).toBe(50);
    expect(parsed.learning.min_samples).toBe(2);
    expect(parsed.planning.enabled).toBe(false);
    expect(parsed.planning.lookahead_slots).toBe(3);
    expect(parsed.planning.topics_per_run).toBe(3);
    expect(parsed.planning.max_open_requests).toBe(3);
    expect(parsed.planning.check_seconds).toBe(3600);
    expect(parsed.auto_pick.enabled).toBe(false);
    expect(parsed.auto_pick.max_concurrent_runs).toBe(1);
  });
});

describe("ProjectConfigSchema learning/adapters.stats defaults", () => {
  it("defaults learning.collect_seconds and adapters.stats for an old project.yaml", () => {
    const parsed = ProjectConfigSchema.parse({
      schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
      data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    });
    expect(parsed.learning.collect_seconds).toBe(1800);
    expect(parsed.learning.collect_batch).toBe(5);
    expect(parsed.adapters.stats).toBe("fake");
  });
});

describe("ProductionProfileSchema profile_id channel-planning", () => {
  it("accepts the channel-planning profile", () => {
    const parsed = ProductionProfileSchema.parse({
      schema_version: "harness.production-profile/v1", profile_id: "channel-planning", revision: 1, status: "active",
      workflow_release: "channel-planning@1.0.0",
    });
    expect(parsed.profile_id).toBe("channel-planning");
  });
});
