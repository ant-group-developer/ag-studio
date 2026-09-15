import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, freshPublishWorld, seedPublishedEpisode } from "../integration/publish-helpers.js";

// Acceptance 38 (spec §2.5): the legacy `channel-metrics.jsonl` register a channel kept before the harness
// existed can be imported as history. Lines are matched to publication jobs by `youtube_video_id`; a line for
// a video this channel never published through the harness is dropped and counted, never guessed at. Imported
// rows are marked `manual`, which is also why they do not satisfy the collector's own due rule -- a manual
// row is history, not an answer to "did the collect sweep run".
describe("acceptance 38: importing the legacy metrics ledger keeps what matches and reports what does not", () => {
  it("3 lines, 2 matching -> imported 2, skipped 1, both rows sourced manual", () => {
    const world = freshPublishWorld();
    const ep15 = seedPublishedEpisode(world, { channelId: "channel-one", episodeNo: 15, videoId: "vid-ep15", title: "Tập 15" });
    const ep16 = seedPublishedEpisode(world, { channelId: "channel-one", episodeNo: 16, videoId: "vid-ep16", title: "Tập 16" });

    const jsonlPath = join(mkdtempSync(join(tmpdir(), "legacy-metrics-")), "channel-metrics.jsonl");
    writeFileSync(jsonlPath, [
      JSON.stringify({ videoId: "vid-ep15", views: 4200, impressions: 51000, ctr_pct: 8.2, avg_view_sec: 96, collectedAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }),
      JSON.stringify({ videoId: "vid-ep16", views: 3100, impressions: 40000, ctr_pct: 7.1, avg_view_sec: 88, collectedAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }),
      JSON.stringify({ videoId: "vid-from-another-era", views: 999 }),
    ].join("\n") + "\n");

    const imported = cli(world.channel, ["channel", "metrics", "import", "channel-one", jsonlPath, "--json"], world.secretsEnv);
    expect(imported.code, imported.err).toBe(0);
    const report = JSON.parse(imported.out) as { imported: number; skipped: { videoId: string; why: string }[] };
    expect(report.imported).toBe(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.videoId).toBe("vid-from-another-era");
    expect(report.skipped[0]!.why).toContain("no matching publication job");

    const stats = JSON.parse(cli(world.channel, ["channel", "stats", "channel-one", "--json"], world.secretsEnv).out) as {
      episode_no: number; publication_job_id: string; snapshots: number; views: number | null; ctr_pct: number | null; source: string | null;
    }[];
    expect(stats).toHaveLength(2);
    expect(stats.find((r) => r.publication_job_id === ep15.jobId)).toMatchObject({ episode_no: 15, snapshots: 1, views: 4200, ctr_pct: 8.2, source: "manual" });
    expect(stats.find((r) => r.publication_job_id === ep16.jobId)).toMatchObject({ episode_no: 16, snapshots: 1, views: 3100, ctr_pct: 7.1, source: "manual" });

    // a manual row is not a collect: both jobs are still due for the collector's own 72h snapshot
    const collect = cli(world.channel, ["channel", "collect", "--channel", "channel-one", "--json"], world.secretsEnv);
    expect(collect.code, collect.err).toBe(0);
    expect((JSON.parse(collect.out) as { collected: unknown[] }).collected).toHaveLength(2);
  }, 120_000);
});
