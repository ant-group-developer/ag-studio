import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, freshLibraryWorld, requestCreate, requestStatus, status, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

/** All `request.auto_accepted` events for `requestId`, whatever the studio's mirror DB shows right now. */
function acceptedEventsFor(project: string, requestId: string): { replan_no: number; run_id: string }[] {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    return store.listEvents({ event_type: "request.auto_accepted" })
      .filter((e) => e.payload.request_id === requestId)
      .map((e) => ({ replan_no: e.payload.replan_no as number, run_id: e.payload.run_id as string }));
  } finally {
    store.close();
  }
}

// Acceptance 29: an agent stage that writes nothing (FAKE_AGENT_FAIL_STAGE targets survey-source the same
// way FAKE_AGENT_MODE=no-output would, see fixtures/fake-agent-cli.mjs) is a *contract* failure --
// CliAgentRuntime.runTask's `agent wrote no output/<name>` error carries `kind: "contract"` -- and
// controller.ts's `classifyFailure`/`scheduleRetry` never retries a contract failure (`retry_on` on this
// stage is `[transient, abandoned]`; `scheduleRetry` bails out before even looking at `backoff_seconds`
// because `stage.retry.retry_on.includes(kind)` is false). So the stage parks at WAITING_HUMAN after exactly
// one attempt, not two -- the task brief anticipated a *transient* failure needing two attempts and a 60s
// backoff wait; this test asserts the actual (faster, and correctly spec-compliant per AGENTS.md's own
// "kind==contract -> giao con người ngay") behaviour instead of forcing a wrong shape on it. See
// task-8-report.md for this as a documented deviation from the brief's literal wording, not a shortcut.
describe.skipIf(!hasFfmpeg())("acceptance 29: a contract-failing agent stage parks the run, it does not silently replan", () => {
  it("survey-source lands on WAITING_HUMAN after one attempt; the run is WAITING, the request stays claimed, and no second run is ever planned for it", () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    const env = { FAKE_AGENT_FAIL_STAGE: "survey-source" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(ingested.code, ingested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Một yêu cầu mà agent không ghi output", style: styleId, sourceHint: "main", voice: "none" });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "claimed", 60, env);
    expect(requestStatus(world, requestId).status).toBe("claimed");

    const acceptedBefore = acceptedEventsFor(world.studio, requestId);
    expect(acceptedBefore).toHaveLength(1);
    const runId = acceptedBefore[0]!.run_id;

    studioWorkerUntil(world, () => status(world.studio, runId).stages.find((s) => s.stage_key === "survey-source")?.state === "WAITING_HUMAN", 40, env);

    const final = status(world.studio, runId);
    const surveyStage = final.stages.find((s) => s.stage_key === "survey-source")!;
    expect(surveyStage.state).toBe("WAITING_HUMAN");
    expect(surveyStage.attempts, JSON.stringify(surveyStage.attempts)).toHaveLength(1);
    expect(surveyStage.attempts[0]!.failure_kind).toBe("contract");
    expect(final.run.state).toBe("WAITING");

    // no second ContentItem/run for this request: intake claimed it and the parked run holds the claim,
    // auto-accept skips it as "run-active" on every subsequent poll instead of planning a replan
    studioWorkerUntil(world, () => false, 20, env);
    expect(acceptedEventsFor(world.studio, requestId)).toHaveLength(1);
    expect(requestStatus(world, requestId).status).toBe("claimed");
    expect(status(world.studio, runId).stages.find((s) => s.stage_key === "survey-source")?.state).toBe("WAITING_HUMAN");
  }, 300_000);
});
