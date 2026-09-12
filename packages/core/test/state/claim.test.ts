import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { addSeconds, FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../../src/index.js";
import { openTempStore, seedStage } from "../helpers.js";

const claimWith = (store: SqliteStateStore, owner: string, caps: string[] = ["write_workspace"]) =>
  store.claim({ owner, capabilities: caps, now: store.clock.now(), leaseSeconds: 90 });

describe("claim", () => {
  it("lets exactly one connection win each READY stage", () => {
    const { store, dir, clock } = openTempStore();
    seedStage(store, { key: "a" }); seedStage(store, { key: "b" });
    const w1 = new SqliteStateStore(join(dir, "state.db"), clock);
    const w2 = new SqliteStateStore(join(dir, "state.db"), clock);
    const w3 = new SqliteStateStore(join(dir, "state.db"), clock);
    const claims = [claimWith(w1, "w1"), claimWith(w2, "w2"), claimWith(w3, "w3")];
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(2);
    expect(new Set(won.map((c) => c!.stageRun.stage_run_id)).size).toBe(2);
    expect(won.map((c) => c!.lease.fencing_token)).toEqual([1, 1]);
    expect(won[0]!.stageRun.state).toBe("CLAIMED");
    expect(won[0]!.attempt.state).toBe("CLAIMED");
    expect(store.getRun(won[0]!.stageRun.run_id)?.state).toBe("RUNNING");
  });

  it("skips stages whose capabilities the worker lacks or whose not_before is in the future", () => {
    const { store } = openTempStore();
    seedStage(store, { key: "tts", caps: ["call_tts"] });
    expect(claimWith(store, "w", ["write_workspace"])).toBeUndefined();
    expect(claimWith(store, "w", ["write_workspace", "call_tts"])).toBeDefined();
    const { stage } = seedStage(store, { key: "later" });
    store.updateStageRun({ ...stage, not_before: addSeconds(store.clock.now(), 60) });
    expect(claimWith(store, "w")).toBeUndefined();
    (store.clock as FixedClock).advance(61);
    expect(claimWith(store, "w")).toBeDefined();
  });

  it("heartbeats only with the current fencing token", () => {
    const { store } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w")!;
    const later = addSeconds(store.clock.now(), 90);
    expect(store.heartbeat(c.attempt.attempt_id, 1, later)).toBe(true);
    expect(store.getLease(c.stageRun.stage_run_id)?.expires_at).toBe(later);
    expect(store.heartbeat(c.attempt.attempt_id, 99, later)).toBe(false);
  });

  it("reaps expired leases, requeues the stage and rejects the old token", () => {
    const { store, clock } = openTempStore();
    seedStage(store);
    const first = claimWith(store, "w1")!;
    clock.advance(91);
    const reaped = store.reapExpiredLeases(clock.now());
    expect(reaped).toEqual([{ stage_run_id: first.stageRun.stage_run_id, attempt_id: first.attempt.attempt_id, owner: "w1", requeued: true }]);
    expect(store.getAttempt(first.attempt.attempt_id)?.state).toBe("ABANDONED");
    const stage = store.getStageRun(first.stageRun.stage_run_id)!;
    expect(stage.state).toBe("READY");
    expect(stage.attempt_count).toBe(1);
    expect(stage.last_failure_kind).toBe("abandoned");
    expect(store.getLease(stage.stage_run_id)).toBeUndefined();
    const second = claimWith(store, "w2")!;
    expect(second.lease.fencing_token).toBe(2);
    expect(() => store.assertFencing(stage.stage_run_id, 1)).toThrow();
    try { store.assertFencing(stage.stage_run_id, 1); } catch (e) { expect(isHarnessError(e, "FENCING_REJECTED")).toBe(true); }
    expect(() => store.assertFencing(stage.stage_run_id, 2)).not.toThrow();
  });

  it("fails the stage when abandoned attempts exhaust max_attempts", () => {
    const { store, clock } = openTempStore();
    seedStage(store, { retry: { max_attempts: 1 } });
    claimWith(store, "w1");
    clock.advance(91);
    const [r] = store.reapExpiredLeases(clock.now());
    expect(r?.requeued).toBe(false);
    expect(store.getStageRun(r!.stage_run_id)?.state).toBe("FAILED");
  });

  it("reports requeued=false and leaves the stage alone when it is not in an active state", () => {
    const { store, clock } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w1")!;
    const ev = { run_id: c.stageRun.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "WAITING_HUMAN", ev);
    clock.advance(91);
    const [r] = store.reapExpiredLeases(clock.now());
    expect(r).toEqual({ stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, owner: "w1", requeued: false });
    expect(store.getStageRun(c.stageRun.stage_run_id)?.state).toBe("WAITING_HUMAN");
    expect(store.getAttempt(c.attempt.attempt_id)?.state).toBe("ABANDONED");
    expect(store.getLease(c.stageRun.stage_run_id)).toBeUndefined();
  });

  it("cancels a cancel-requested stage when its lease expires instead of requeueing it", () => {
    const { store, clock } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w1")!;
    const ev = { run_id: c.stageRun.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "CANCEL_REQUESTED", ev);
    clock.advance(91);
    const [r] = store.reapExpiredLeases(clock.now());
    expect(r).toEqual({ stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, owner: "w1", requeued: false });
    expect(store.getStageRun(c.stageRun.stage_run_id)?.state).toBe("CANCELLED");
    expect(store.getAttempt(c.attempt.attempt_id)?.state).toBe("ABANDONED");
    expect(store.getLease(c.stageRun.stage_run_id)).toBeUndefined();
  });

  it("releaseLease removes the lease only for the matching token", () => {
    const { store } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w")!;
    store.releaseLease(c.stageRun.stage_run_id, 5);
    expect(store.getLease(c.stageRun.stage_run_id)).toBeDefined();
    store.releaseLease(c.stageRun.stage_run_id, 1);
    expect(store.getLease(c.stageRun.stage_run_id)).toBeUndefined();
  });
});
