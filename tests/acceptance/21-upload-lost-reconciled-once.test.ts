import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshPublishWorld, jobs, packageFor, pickAndPlan, readQueue, status } from "../integration/publish-helpers.js";

// Acceptance 21: `FAKE_UPLOAD_MODE=lost` writes the legacy queue line and exits 1 -- the stage outcome is
// "unknown" (controller ruling from Task 5), so the job/operation/stage park at NEEDS_RECONCILIATION with no
// video_id ever recorded on the job. `publish reconcile` must therefore look the video up by title (the
// PlaywrightPublisher lookup-file convention: a "title:<title>" key), not by video_id. Once reconciled to
// PROCESSING with the video id the queue already has, a later successful drain must never upload a second
// time -- `upload`'s own idempotent short-circuit for a PROCESSING job is what the queue-length assertion
// below is really testing.
describe.skipIf(!hasFfmpeg())("acceptance 21: an upload lost mid-flight is reconciled by title, never uploaded twice", () => {
  it("lost -> NEEDS_RECONCILIATION -> reconcile by title -> PROCESSING -> ok drain -> SCHEDULED, queue stays at 1 line", () => {
    const world = freshPublishWorld({ uploadMode: "lost" });
    const { runId } = pickAndPlan(world, "channel-one");
    drain(world.channel, world.secretsEnv);

    const st = status(world.channel, runId);
    const uploadStage = st.stages.find((s) => s.stage_key === "upload")!;
    expect(uploadStage.state).toBe("NEEDS_RECONCILIATION");

    const job = jobs(world, "channel-one")[0]!;
    expect(job.state).toBe("NEEDS_RECONCILIATION");
    expect(job.youtube_video_id).toBeNull(); // the job never learned a video_id -- the queue is the only record

    const repo = world.repos["channel-one"]!;
    const queueAfterLost = readQueue(repo);
    expect(queueAfterLost).toHaveLength(1);
    const lostVideoId = queueAfterLost[0]!.videoId;

    const pkg = packageFor(world.channel, job.publication_job_id);
    writeFileSync(world.secretsEnv.HARNESS_PUBLISHER_LOOKUP_FILE!, JSON.stringify({
      [`title:${pkg.metadata.title}`]: { found: true, video_id: lostVideoId, visibility: "private" },
    }));

    const reconcile = cli(world.channel, ["publish", "reconcile", job.publication_job_id, "--json"], world.secretsEnv);
    expect(reconcile.code, reconcile.err).toBe(0);
    const report = JSON.parse(reconcile.out) as { to: string; video_id: string | null };
    expect(report.to).toBe("PROCESSING");
    expect(report.video_id).toBe(lostVideoId);

    const jobAfterReconcile = jobs(world, "channel-one")[0]!;
    expect(jobAfterReconcile.state).toBe("PROCESSING");
    expect(jobAfterReconcile.youtube_video_id).toBe(lostVideoId);

    drain(world.channel, { ...world.secretsEnv, FAKE_UPLOAD_MODE: "ok" });
    const jobAfterUpload = jobs(world, "channel-one")[0]!;
    expect(jobAfterUpload.state).toBe("SCHEDULED");

    // The upload stage's idempotent PROCESSING short-circuit fired instead of calling the publisher again --
    // this is the whole point of the acceptance: reconciling a lost upload must never re-upload it.
    const queueAfterUpload = readQueue(repo);
    expect(queueAfterUpload).toHaveLength(1);
  }, 300_000);
});
