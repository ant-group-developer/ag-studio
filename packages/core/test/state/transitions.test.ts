import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type Run } from "@harness/contracts";
import { assertTransition, isTerminal, TRANSITIONS } from "../../src/state/transitions.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "a".repeat(64);
const run = (): Run => ({
  schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf",
  workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 },
  state: "DRAFT", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now,
});
const evt = (run_id: string, event_type: string) => ({
  run_id, stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null,
  variant_id: null, workflow_release: null, severity: "info" as const, event_type, payload: {},
});

describe("transition tables", () => {
  it("allow every blueprint path", () => {
    const ok: [keyof typeof TRANSITIONS, string, string][] = [
      ["run", "DRAFT", "READY"], ["run", "READY", "RUNNING"], ["run", "RUNNING", "SUCCEEDED"], ["run", "RUNNING", "WAITING"],
      ["stage_run", "PENDING", "READY"], ["stage_run", "READY", "CLAIMED"], ["stage_run", "CLAIMED", "RUNNING"], ["stage_run", "RUNNING", "VERIFYING"],
      ["stage_run", "VERIFYING", "SUCCEEDED"], ["stage_run", "VERIFYING", "FAILED"], ["stage_run", "FAILED", "READY"], ["stage_run", "RUNNING", "WAITING_EXTERNAL"],
      ["stage_run", "WAITING_EXTERNAL", "NEEDS_RECONCILIATION"], ["stage_run", "NEEDS_RECONCILIATION", "READY"], ["stage_run", "RUNNING", "READY"],
      ["attempt", "CLAIMED", "RUNNING"], ["attempt", "RUNNING", "ABANDONED"], ["artifact", "PROVISIONAL", "ACCEPTED"],
      ["external_operation", "INTENT_RECORDED", "DISPATCHED"], ["external_operation", "DISPATCHED", "NEEDS_RECONCILIATION"], ["external_operation", "NEEDS_RECONCILIATION", "CONFIRMED"],
    ];
    for (const [k, f, t] of ok) expect(() => assertTransition(k, f, t), `${k} ${f}->${t}`).not.toThrow();
  });
  it("forbid illegal paths", () => {
    const bad: [keyof typeof TRANSITIONS, string, string][] = [
      ["run", "DRAFT", "RUNNING"], ["run", "SUCCEEDED", "RUNNING"], ["stage_run", "PENDING", "CLAIMED"], ["stage_run", "READY", "SUCCEEDED"],
      ["stage_run", "SUCCEEDED", "READY"], ["attempt", "SUCCEEDED", "RUNNING"], ["artifact", "ACCEPTED", "PROVISIONAL"], ["artifact", "REJECTED", "ACCEPTED"],
      ["external_operation", "CONFIRMED", "DISPATCHED"],
    ];
    for (const [k, f, t] of bad) {
      expect(() => assertTransition(k, f, t), `${k} ${f}->${t}`).toThrow();
      try { assertTransition(k, f, t); } catch (e) { expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true); }
    }
  });
  it("knows terminal states", () => {
    expect(isTerminal("stage_run", "SUCCEEDED")).toBe(true);
    expect(isTerminal("stage_run", "READY")).toBe(false);
    expect(isTerminal("run", "CANCELLED")).toBe(true);
  });
});

describe("store.transition", () => {
  it("updates state, data and appends an event atomically", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    store.transition("run", r.run_id, "DRAFT", "READY", evt(r.run_id, "run.enqueued"));
    expect(store.getRun(r.run_id)?.state).toBe("READY");
    expect(store.listEvents({ run_id: r.run_id }).map((e) => e.event_type)).toEqual(["run.enqueued"]);
  });
  it("throws STALE_STATE when the row is not in the expected state and writes nothing", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    expect(() => store.transition("run", r.run_id, "READY", "RUNNING", evt(r.run_id, "run.started"))).toThrow(/not in state READY/);
    expect(store.listEvents({ run_id: r.run_id })).toHaveLength(0);
    expect(store.getRun(r.run_id)?.state).toBe("DRAFT");
  });
  it("throws INVALID_TRANSITION before touching the database", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    expect(() => store.transition("run", r.run_id, "DRAFT", "SUCCEEDED", evt(r.run_id, "run.finished"))).toThrow(/DRAFT -> SUCCEEDED/);
    expect(store.getRun(r.run_id)?.state).toBe("DRAFT");
  });
});
