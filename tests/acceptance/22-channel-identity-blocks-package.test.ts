import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshPublishWorld, jobs, pickAndPlan, readQueue, status } from "../integration/publish-helpers.js";

// Acceptance 22: a channel's legacy repo drifting out of sync with channel.yaml (someone logged the legacy
// upload profile into the wrong YouTube account) must be caught before anything is ever uploaded --
// `channel-identity` re-reads `channel.config.json` at verify time (not from the build-package receipt), so
// mutating it after build-package's own script already ran, but before the worker verifies its output,
// reproduces exactly that drift.
//
// build-package's own script logic (publish-stage.ts) has no identity check of its own -- it creates the
// ChannelPackage/PublicationJob rows and writes package-receipt.json unconditionally, then the *verifier*
// evaluates required_checks against that receipt afterward and fails the stage_run. So the job this run
// creates is NOT absent (`publish list` still shows it, parked in READY -- nothing will ever advance it,
// since the run never gets past build-package), only the queue stays untouched.
describe.skipIf(!hasFfmpeg())("acceptance 22: a channel-identity mismatch blocks the package before any upload", () => {
  it("build-package FAILED on channel-identity; the job is stuck at READY, never queued", () => {
    const world = freshPublishWorld({ uploadMode: "ok" });
    const { runId } = pickAndPlan(world, "channel-one");

    const repo = world.repos["channel-one"]!;
    const cfgPath = join(repo, "channel.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { youtube: { channelId: string } };
    cfg.youtube.channelId = "UCwrongwrongwrongwrongwrong1";
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    drain(world.channel, world.secretsEnv);

    const st = status(world.channel, runId);
    const buildPackage = st.stages.find((s) => s.stage_key === "build-package")!;
    expect(buildPackage.state).toBe("FAILED");
    expect(buildPackage.attempts.at(-1)?.failure_kind).toBe("result"); // a required check failed, not the script itself

    const events = cli(world.channel, ["events", "tail", "--run", runId, "--json"], world.secretsEnv);
    expect(events.code, events.err).toBe(0);
    const rows = JSON.parse(events.out) as { event_type: string; payload: { checks?: { check_id: string; verdict: string; evidence?: Record<string, unknown> }[] } }[];
    const failedEvent = rows.find((r) => r.event_type === "stage.failed");
    expect(failedEvent).toBeDefined();
    const identityCheck = failedEvent?.payload.checks?.find((c) => c.check_id === "channel-identity");
    expect(identityCheck?.verdict).toBe("fail");
    expect(JSON.stringify(identityCheck?.evidence)).toContain("channelId mismatch");

    // build-package's own script always creates the job (a side effect of its own execution, independent of
    // the checks the verifier runs on its output afterward) -- it is stuck at READY, not absent.
    const channelJobs = jobs(world, "channel-one");
    expect(channelJobs).toHaveLength(1);
    expect(channelJobs[0]!.state).toBe("READY");

    // upload never got a chance to run: the run is stuck at build-package, so the legacy queue is untouched.
    expect(readQueue(repo)).toHaveLength(0);
  }, 300_000);
});
