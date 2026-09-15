import { describe, expect, it } from "vitest";
import { newId, ChannelBriefSchema } from "@harness/contracts";
import { buildChannelBrief } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, insertPublishedJob, makeChannel, makeCommittedPackage, makeHypothesis, makeLibraryItem, makeMetric } from "./fixtures.js";

describe("buildChannelBrief", () => {
  it("returns nulls/empty arrays for a channel with no history, and parses", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();

    const brief = buildChannelBrief({ store, clock, channel });

    expect(brief.learned).toBeNull();
    expect(brief.hypotheses).toEqual([]);
    expect(brief.recent_metrics).toEqual([]);
    expect(brief.open_requests).toEqual([]);
    expect(brief.item).toBeNull();
    expect(brief.channel).toEqual({
      channel_id: "channel-a", display_name: "Channel A",
      seo: channel.config.seo,
      publication: { timezone: "America/New_York", publish_times: ["13:00"] },
    });
    expect(() => ChannelBriefSchema.parse(brief)).not.toThrow();
  });

  it("takes the 10 newest committed packages by episode_no desc as hypotheses", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    for (let i = 1; i <= 12; i++) {
      store.insertChannelPackage(makeCommittedPackage({ episode_no: i, hypothesis: makeHypothesis({ chosen: { title: `Ep ${i}`, angle: "a", overlay_text: [], thumbnail_candidate: "c.png" } }) }));
    }

    const brief = buildChannelBrief({ store, clock, channel });

    expect(brief.hypotheses).toHaveLength(10);
    expect(brief.hypotheses.map((h) => h.episode_no)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(brief.hypotheses[0]!.chosen.title).toBe("Ep 12");
    // no evaluated -> metric_value key must be absent, not undefined
    expect("metric_value" in brief.hypotheses[0]!).toBe(false);
  });

  it("includes metric_value only when the hypothesis was evaluated", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    store.insertChannelPackage(makeCommittedPackage({
      episode_no: 1,
      hypothesis: makeHypothesis({ status: "supported", evaluated: { at: T0, metric_value: 150, metric_id: newId("video_metrics") } }),
    }));

    const brief = buildChannelBrief({ store, clock, channel });
    expect(brief.hypotheses[0]!.metric_value).toBe(150);
    expect(brief.hypotheses[0]!.status).toBe("supported");
  });

  it("picks the latest snapshot per job for the 10 newest published jobs that have metrics, skipping jobs without a package", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();

    const pkg1 = makeCommittedPackage({ episode_no: 1 });
    store.insertChannelPackage(pkg1);
    const job1 = insertPublishedJob(store, { published_at: "2026-09-01T00:00:00.000Z", package_id: pkg1.package_id, youtube_video_id: "yt-1" });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job1.publication_job_id, age_hours: 72, views: 100 }));
    store.insertVideoMetrics(makeMetric({ publication_job_id: job1.publication_job_id, age_hours: 168, views: 200 }));

    // published, has metrics, but its package_id points nowhere -- skipped entirely
    const job2 = insertPublishedJob(store, { published_at: "2026-09-05T00:00:00.000Z", package_id: newId("channel_package"), youtube_video_id: "yt-2" });
    store.insertVideoMetrics(makeMetric({ publication_job_id: job2.publication_job_id, age_hours: 72, views: 999 }));

    // published but no metrics at all -- excluded
    const pkg3 = makeCommittedPackage({ episode_no: 3 });
    store.insertChannelPackage(pkg3);
    insertPublishedJob(store, { published_at: "2026-09-03T00:00:00.000Z", package_id: pkg3.package_id, youtube_video_id: "yt-3" });

    const brief = buildChannelBrief({ store, clock, channel });

    expect(brief.recent_metrics).toHaveLength(1);
    expect(brief.recent_metrics[0]).toMatchObject({ episode_no: 1, title: "Episode 1", views: 200, age_hours: 168 });
  });

  it("carries the picked item, and never leaks a secret:// string anywhere in the serialized brief", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    const item = makeLibraryItem({ title_hint: "Great Wall Secrets", duration_seconds: 500 });

    const brief = buildChannelBrief({ store, clock, channel, item });

    expect(brief.item).toEqual({ item_id: item.item_id, title_hint: item.title_hint, summary: item.summary, duration_seconds: 500 });
    expect(JSON.stringify(brief)).not.toContain("secret://");
  });

  it("open_requests are the channel's own open|claimed requests only", () => {
    const { store, clock } = openTempStore(T0);
    const channel = makeChannel();
    store.upsertContentRequest({
      schema_version: "harness.content-request/v1", request_id: newId("content_request"),
      requested_by: { portfolio_id: "portfolio-main", channel_id: "channel-a" }, topic: "Mine", voice: "none", language: "vi",
      count: 1, status: "open", item_ids: [], notes: "", created_at: T0, updated_at: T0,
    });
    store.upsertContentRequest({
      schema_version: "harness.content-request/v1", request_id: newId("content_request"),
      requested_by: { portfolio_id: "portfolio-main", channel_id: "channel-b" }, topic: "Not mine", voice: "none", language: "vi",
      count: 1, status: "open", item_ids: [], notes: "", created_at: T0, updated_at: T0,
    });

    const brief = buildChannelBrief({ store, clock, channel });
    expect(brief.open_requests).toHaveLength(1);
    expect(brief.open_requests[0]!.topic).toBe("Mine");
  });
});
