import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, freshLibraryWorld, requestCreate, requestStatus, setMaxReplans, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

/** Every `request.auto_accepted` event this request has, whatever the studio's mirror DB shows right now. */
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

/** True once both replans (0 and 1) have a terminal run -- the point past which nothing more will ever
 * happen for this request (a third run would only appear if `autoAccept` had a bug). Driving on this
 * predicate rather than a fixed iteration count means the test finishes as soon as the studio is actually
 * done, however many real `worker --once` calls that took (each is a fresh subprocess -- a machine under
 * heavy parallel test load needs more of them per unit of wall time, not more of them in total, but a
 * generous `max` still leaves headroom for genuine contention). */
function bothRunsTerminal(project: string, requestId: string): boolean {
  const accepted = acceptedEventsFor(project, requestId);
  if (accepted.length < 2) return false;
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    return accepted.every((e) => {
      const state = store.getRun(e.run_id)?.state;
      return state === "SUCCEEDED" || state === "FAILED";
    });
  } finally {
    store.close();
  }
}

// Acceptance 28: FAKE_REVIEW_MODE=reject-always with `max_replans: 1` -- the studio replans exactly once
// (replan_no 0 then 1, same as acceptance 27) before `autoAccept` sees `finishedRunCounts > max_replans` and
// starts skipping the request as "exhausted" forever. The dashboard's own `request_stuck` alert
// (packages/core/src/dashboard/snapshot.ts) keys off that identical count, so this is also the acceptance
// test for that alert firing on a real stuck request rather than a hand-seeded one.
describe.skipIf(!hasFfmpeg())("acceptance 28: a request that keeps failing review gets stuck, not retried forever", () => {
  it("replans exactly twice, then stays open and flagged request_stuck no matter how many more idle polls run", () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    setMaxReplans(world.studio, 1);
    const env = { FAKE_REVIEW_MODE: "reject-always" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(ingested.code, ingested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Một yêu cầu luôn bị từ chối", style: styleId, sourceHint: "main", voice: "none" });

    // drives until both replans (0 and 1) reach a terminal run, not a fixed iteration count -- see
    // bothRunsTerminal's own comment for why. 400 is a generous ceiling for a heavily loaded machine.
    studioWorkerUntil(world, () => bothRunsTerminal(world.studio, requestId), 400, env);

    const accepted = acceptedEventsFor(world.studio, requestId);
    expect(accepted.map((e) => e.replan_no).sort()).toEqual([0, 1]);
    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      for (const e of accepted) expect(store.getRun(e.run_id)?.state, e.run_id).toBe("SUCCEEDED");
    } finally {
      store.close();
    }

    expect(requestStatus(world, requestId).status).toBe("open");

    const snapshot = JSON.parse(cli(world.studio, ["dashboard", "snapshot", "--json"]).out) as {
      alerts: { kind: string; ref: string; message: string }[];
    };
    const stuck = snapshot.alerts.find((a) => a.kind === "request_stuck" && a.ref === requestId);
    expect(stuck, JSON.stringify(snapshot.alerts)).toBeDefined();

    // five more idle polls: still no third run, the request is still open
    studioWorkerUntil(world, () => false, 5, env);
    expect(acceptedEventsFor(world.studio, requestId)).toHaveLength(2);
    expect(requestStatus(world, requestId).status).toBe("open");

    // `request.auto_accept_exhausted` (spec §5.4) fired exactly once for this request, however many idle
    // polls have seen it since -- final-review finding I-4, which added the event the docs already named.
    const after = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const exhausted = after.listEvents({ event_type: "request.auto_accept_exhausted" }).filter((e) => e.payload.request_id === requestId);
      expect(exhausted, JSON.stringify(exhausted)).toHaveLength(1);
      expect(exhausted[0]!.payload).toMatchObject({ request_id: requestId, finished_runs: 2, max_replans: 1 });
    } finally {
      after.close();
    }
  }, 600_000);
});
