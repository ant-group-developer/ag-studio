import { describe, expect, it } from "vitest";
import type { ChannelLearned } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import { backdatePublished, cli, drain, freshPublishWorld, jobs, packageFor, pickAndPlan, statsFile, status, writeLookup } from "../integration/publish-helpers.js";

// Acceptance 34 (spec §3.1, §6): a `ctr` hypothesis judged on 10 impressions is judged on noise. Below the
// channel's `learning.min_impressions` (50) the verdict is `void` -- never `refuted` -- so a quiet episode
// cannot drag a channel standard around; the snapshot's `views` still count towards `medians.views_72h`, and
// with nothing `supported` anywhere the channel still has no standard at all.
//
// The hypothesis is a real one, written by the real `package` agent stage: `FAKE_METRIC=ctr` (fake-agent-cli.mjs,
// passed through by @harness/adapter-agent-cli's `FAKE_AGENT_TEST_ENV`) is what makes the fake agent pick `ctr`
// instead of its default `views_72h`.
describe.skipIf(!hasFfmpeg())("acceptance 34: a ctr hypothesis under the impression floor is void, not refuted", () => {
  it("collect records the snapshot, the hypothesis goes void, and no standard is learned", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok" });
    const env = { ...world.secretsEnv, FAKE_METRIC: "ctr" };

    const { runId } = pickAndPlan(world, "channel-one");
    drain(world.channel, env);
    const job = jobs(world, "channel-one")[0]!;
    expect(job.state, JSON.stringify(status(world.channel, runId).stages)).toBe("SCHEDULED");
    expect(packageFor(world.channel, job.publication_job_id).hypothesis.expected.metric).toBe("ctr");

    const videoId = job.youtube_video_id!;
    const publishedAt = backdatePublished(world, job.publication_job_id, 80);
    writeLookup(world, { [videoId]: { found: true, video_id: videoId, visibility: "public", publish_at: publishedAt } });
    expect(cli(world.channel, ["publish", "verify", "--json"], env).code).toBe(0);
    expect(jobs(world, "channel-one")[0]!.state).toBe("PUBLISHED");

    // 10 impressions: a real number from Studio, just far too few to mean anything (floor is 50)
    statsFile(world, { [videoId]: { kind: "ok", views: 100, impressions: 10, ctr_pct: 6, avg_view_sec: 3 } });
    const collect = cli(world.channel, ["channel", "collect", "--channel", "channel-one", "--json"], env);
    expect(collect.code, collect.err).toBe(0);
    const report = JSON.parse(collect.out) as { collected: unknown[]; evaluated: { evaluated: { status: string }[] }[] };
    expect(report.collected).toHaveLength(1);
    expect(report.evaluated.flatMap((e) => e.evaluated).map((e) => e.status)).toEqual(["void"]);

    const hypothesis = packageFor(world.channel, job.publication_job_id).hypothesis;
    expect(hypothesis.status, JSON.stringify(hypothesis)).toBe("void");
    expect(hypothesis.evaluated, "a void verdict is still a verdict: it records when and against what").toBeDefined();

    const learned = JSON.parse(cli(world.channel, ["channel", "learned", "channel-one", "--json"], env).out) as ChannelLearned;
    expect(learned.standard.angle).toBeUndefined();
    expect(learned.standard.title_pattern).toBeUndefined();
    expect(learned.standard.overlay_lines).toBeUndefined();
    expect(learned.standard.note).toContain("giả thuyết supported");
    expect(learned.sample_size, "a void hypothesis is not a sample").toBe(0);
    expect(learned.medians.views_72h, "the views still count towards the channel median").toBe(100);
    expect(learned.history).toEqual([]);
  }, 300_000);
});
