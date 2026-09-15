import { describe, expect, it } from "vitest";
import { newId } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import {
  backdatePublished, cli, drain, freshPublishWorld, jobs, librarySync, pickAndPlan, statsFile, status, writeLibraryItem, writeLookup,
} from "../integration/publish-helpers.js";

// Acceptance 33 (spec §6): YouTube Studio refusing to answer -- a "verify it's you" wall -- must never stop
// the channel from publishing. The blocked collect writes no `video_metrics` row at all (a blocked sweep is
// not a zero-views sweep), raises `stats.blocked` once, surfaces it on the dashboard as `stats_blocked`, and
// the very next episode still goes out on schedule.
describe.skipIf(!hasFfmpeg())("acceptance 33: a blocked stats collect does not stop the channel publishing", () => {
  it("collect reports the channel blocked, records nothing, alerts -- and the next episode still reaches SCHEDULED", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok" });

    // ---- episode 1: published for real, then aged past the 72h learning horizon ----
    const { runId } = pickAndPlan(world, "channel-one");
    drain(world.channel, world.secretsEnv);
    const job1 = jobs(world, "channel-one")[0]!;
    expect(job1.state, JSON.stringify(status(world.channel, runId).stages)).toBe("SCHEDULED");

    const videoId = job1.youtube_video_id!;
    const publishedAt = backdatePublished(world, job1.publication_job_id, 80);
    writeLookup(world, { [videoId]: { found: true, video_id: videoId, visibility: "public", publish_at: publishedAt } });
    const verify = cli(world.channel, ["publish", "verify", "--json"], world.secretsEnv);
    expect(verify.code, verify.err).toBe(0);
    expect(jobs(world, "channel-one")[0]!.state).toBe("PUBLISHED");

    // ---- the collect sweep hits a login wall ----
    statsFile(world, { [videoId]: { kind: "blocked", reason: "verify" } });
    const collect = cli(world.channel, ["channel", "collect", "--channel", "channel-one", "--json"], world.secretsEnv);
    expect(collect.code, collect.err).toBe(0); // blocked is not a failure: exit 0, the report says what happened
    const report = JSON.parse(collect.out) as { collected: unknown[]; blocked: string[]; failed: unknown[] };
    expect(report.blocked).toEqual(["channel-one"]);
    expect(report.collected).toEqual([]);
    expect(report.failed).toEqual([]);

    const stats = JSON.parse(cli(world.channel, ["channel", "stats", "channel-one", "--json"], world.secretsEnv).out) as { snapshots: number; views: number | null }[];
    expect(stats).toHaveLength(1);
    expect(stats[0]!.snapshots, "a blocked collect must record no snapshot at all").toBe(0);
    expect(stats[0]!.views).toBeNull();

    const snapshot = JSON.parse(cli(world.channel, ["dashboard", "snapshot", "--json"], world.secretsEnv).out) as {
      alerts: { kind: string; channel_id?: string; message: string }[];
    };
    const alert = snapshot.alerts.find((a) => a.kind === "stats_blocked" && a.channel_id === "channel-one");
    expect(alert, JSON.stringify(snapshot.alerts)).toBeDefined();
    expect(alert!.message).toContain("verify");

    // ---- publishing is untouched: the next episode goes all the way to SCHEDULED ----
    const nextItemId = newId("library_item");
    writeLibraryItem(world.lib, {
      itemId: nextItemId, styleId: world.styleId, status: "approved", titleHint: "Chợ nổi Cái Răng buổi chiều",
      extraFiles: [{ path: "thumb-01.png", body: "fake png bytes for thumb 1", mime_type: "image/png" }],
    });
    librarySync(world.channel);

    const { runId: runId2 } = pickAndPlan(world, "channel-one", nextItemId);
    drain(world.channel, world.secretsEnv);
    const st2 = status(world.channel, runId2);
    for (const s of st2.stages) expect(s.state, `${s.stage_key}: ${JSON.stringify(s.attempts.at(-1))}`).toBe("SUCCEEDED");
    const job2 = jobs(world, "channel-one").find((j) => j.publication_job_id !== job1.publication_job_id);
    expect(job2, JSON.stringify(jobs(world, "channel-one"))).toBeDefined();
    expect(job2!.state).toBe("SCHEDULED");
  }, 300_000);
});
