import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import {
  backdateScheduled, cli, drain, freshPublishWorld, jobs, pickAndPlan, readQueue, setVerifyGraceHours, status,
} from "../integration/publish-helpers.js";

// Acceptance 24: `publish verify` sweeps every overdue SCHEDULED job and settles it against whatever the
// publisher actually reports -- a video the legacy scheduler really did publish goes to PUBLISHED, one the
// provider no longer confirms (still private, no scheduled publish_at) parks NEEDS_RECONCILIATION for a
// human, and the dashboard's `alerts[]` surfaces that job with kind "reconcile" either way.
describe.skipIf(!hasFfmpeg())("acceptance 24: the verify sweep settles a due job and reconciles another", () => {
  it("public visibility -> PUBLISHED; private with no publish_at -> NEEDS_RECONCILIATION; dashboard alerts", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok" });

    const { runId: run1 } = pickAndPlan(world, "channel-one");
    drain(world.channel, world.secretsEnv);
    const job1 = jobs(world, "channel-one")[0]!;
    expect(job1.state, JSON.stringify(status(world.channel, run1).stages)).toBe("SCHEDULED");

    const { runId: run2 } = pickAndPlan(world, "channel-two");
    drain(world.channel, world.secretsEnv);
    const job2 = jobs(world, "channel-two")[0]!;
    expect(job2.state, JSON.stringify(status(world.channel, run2).stages)).toBe("SCHEDULED");

    // Both jobs were booked at a genuine future `nextSlot()`; hand-write them "overdue" (still today, in
    // either channel's own timezone) rather than waiting on real wall-clock time to pass.
    setVerifyGraceHours(world.channel, 0);
    const almostNow = new Date(Date.now() - 5 * 60_000).toISOString();
    backdateScheduled(world.channel, job1.publication_job_id, almostNow);
    backdateScheduled(world.channel, job2.publication_job_id, almostNow);

    const videoId1 = readQueue(world.repos["channel-one"]!)[0]!.videoId;
    const videoId2 = readQueue(world.repos["channel-two"]!)[0]!.videoId;
    writeFileSync(world.secretsEnv.HARNESS_PUBLISHER_LOOKUP_FILE!, JSON.stringify({
      [videoId1]: { found: true, video_id: videoId1, visibility: "public" },
      [videoId2]: { found: true, video_id: videoId2, visibility: "private" }, // no publish_at
    }));

    const verify = cli(world.channel, ["publish", "verify", "--json"], world.secretsEnv);
    expect(verify.code, verify.err).toBe(0);
    const report = JSON.parse(verify.out) as { published: string[]; reconcile: string[]; errors: unknown[] };
    expect(report.published).toEqual([job1.publication_job_id]);
    expect(report.reconcile).toEqual([job2.publication_job_id]);
    expect(report.errors).toEqual([]);

    const after1 = jobs(world, "channel-one")[0]!;
    const after2 = jobs(world, "channel-two")[0]!;
    expect(after1.state).toBe("PUBLISHED");
    expect(after2.state).toBe("NEEDS_RECONCILIATION");

    const snap = cli(world.channel, ["dashboard", "snapshot", "--json"], world.secretsEnv);
    expect(snap.code, snap.err).toBe(0);
    const snapshot = JSON.parse(snap.out) as { alerts: { kind: string; ref: string; channel_id?: string }[] };
    const reconcileAlert = snapshot.alerts.find((a) => a.kind === "reconcile" && a.ref === job2.publication_job_id);
    expect(reconcileAlert).toBeDefined();
    expect(reconcileAlert?.channel_id).toBe("channel-two");
    expect(snapshot.alerts.some((a) => a.kind === "reconcile" && a.ref === job1.publication_job_id)).toBe(false);
  }, 300_000);
});
