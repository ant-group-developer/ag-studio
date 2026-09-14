import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshPublishWorld, jobs, pickAndPlan, readQueue, status, withStore } from "../integration/publish-helpers.js";

// Acceptance 26: the mirror image of acceptance 21 -- when the publisher has no record of the lost upload at
// all (the lookup file returns `found: false` for both the video-id key it never had and the "title:<title>"
// key), reconcile must give up and hand the job back to READY rather than guessing, so the workflow retries
// the upload exactly once through the normal READY path (never anything but that one retry).
describe.skipIf(!hasFfmpeg())("acceptance 26: reconcile finding nothing sends the job back to READY, retried exactly once", () => {
  it("lost -> reconcile (not found) -> READY/FAILED op/READY stage -> ok drain -> SCHEDULED, queue ends at 2 lines", () => {
    const world = freshPublishWorld({ uploadMode: "lost" }); // o.lookup defaults to {} -> every lookup is found:false
    const { runId } = pickAndPlan(world, "channel-one");
    drain(world.channel, world.secretsEnv);

    const job = jobs(world, "channel-one")[0]!;
    expect(job.state).toBe("NEEDS_RECONCILIATION");
    const repo = world.repos["channel-one"]!;
    expect(readQueue(repo)).toHaveLength(1);

    const reconcile = cli(world.channel, ["publish", "reconcile", job.publication_job_id, "--json"], world.secretsEnv);
    expect(reconcile.code, reconcile.err).toBe(0);
    const report = JSON.parse(reconcile.out) as { to: string };
    expect(report.to).toBe("READY");

    const jobAfter = jobs(world, "channel-one")[0]!;
    expect(jobAfter.state).toBe("READY");

    const opStatus = withStore(world.channel, (store) => {
      const fresh = store.getPublicationJob(job.publication_job_id)!;
      return fresh.operation_id ? store.getExternalOperation(fresh.operation_id)?.status : undefined;
    });
    expect(opStatus).toBe("FAILED");

    const st = status(world.channel, runId);
    const uploadStage = st.stages.find((s) => s.stage_key === "upload")!;
    expect(uploadStage.state).toBe("READY");

    drain(world.channel, { ...world.secretsEnv, FAKE_UPLOAD_MODE: "ok" });
    const jobFinal = jobs(world, "channel-one")[0]!;
    expect(jobFinal.state).toBe("SCHEDULED");

    // one line from the original "lost" attempt, one from the real retry -- exactly one re-upload, not zero
    // (a stuck job) and not more than one (a duplicate video on the channel).
    const queueFinal = readQueue(repo);
    expect(queueFinal).toHaveLength(2);
  }, 300_000);
});
