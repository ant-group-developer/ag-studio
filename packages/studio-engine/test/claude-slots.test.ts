/**
 * Chat replies take a `claude` slot in the same `lease` table worker stages use, so one cap covers the API, the
 * worker and every worker process. A reply that finds the cap full leaves a "waiting" row that also counts against
 * the cap: the next slot a stage frees goes to the reply, not to the next stage.
 */
import { describe, expect, it } from "vitest";
import { newId, type Run, type StageRun } from "@harness/contracts";
import { acquireChatSlot, claudeUsage, heartbeatChatSlot, releaseChatSlot, type StudioEngineCore } from "../src/index.js";
import { world } from "./helpers.js";

const SHA = "sha256:" + "a".repeat(64);
const T0 = "2026-10-06T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

function readyClaudeStage(core: StudioEngineCore, key: string): StageRun {
  const now = core.clock.now();
  const run: Run = {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "ag-studio", portfolio_id: "studio",
    workflow_release: { id: "w", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio-production", revision: 1 },
    options: {}, state: "READY", effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0, created_at: now, updated_at: now,
  };
  core.store.insertRun(run);
  const stage: StageRun = {
    schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: key,
    executor: { type: "agent", skill: "studio-rnd" }, depends_on: [], depends_on_optional: [], requires_resources: ["claude"], required_capabilities: [],
    required_checks: ["schema-valid"], retry: { max_attempts: 2, backoff_seconds: [0], retry_on: ["transient"] },
    stage_config: {}, state: "READY", attempt_count: 0, result_failures: 0, ready_at: now, created_at: now, updated_at: now,
  };
  core.store.insertStageRun(stage);
  return stage;
}

const claim = (core: StudioEngineCore, cap: number) =>
  core.store.claim({ owner: "w", capabilities: [], now: core.clock.now(), leaseSeconds: 90, resourceCapacity: { claude: cap } });

describe("chat slots on the lease table", () => {
  it("a running reply counts against the cap worker stages are claimed under", () => {
    const { core, db } = world();
    readyClaudeStage(core, "rnd");
    expect(acquireChatSlot(db, "turn-1", 1, T0)).toBe(true);
    expect(acquireChatSlot(db, "turn-1", 1, T0)).toBe(true); // asking again while holding it keeps it
    expect(core.store.countLeasedResources()).toEqual({ claude: 1 });
    expect(claim(core, 1)).toBeUndefined();
    releaseChatSlot(db, "turn-1");
    expect(claim(core, 1)?.stageRun.stage_key).toBe("rnd");
  });

  it("a reply waiting for a full cap gets the next free slot ahead of the stages queued", () => {
    const { core, db } = world();
    readyClaudeStage(core, "rnd-a");
    readyClaudeStage(core, "rnd-b");
    const a = claim(core, 1)!;
    expect(acquireChatSlot(db, "turn-1", 1, T0)).toBe(false);
    expect(claudeUsage(db)).toEqual({ running: 1, waiting: 1 });
    core.store.releaseLease(a.stageRun.stage_run_id, a.lease.fencing_token); // stage done: one slot free
    expect(claim(core, 1)).toBeUndefined(); // the waiting reply holds it
    expect(acquireChatSlot(db, "turn-1", 1, T0)).toBe(true);
    expect(claudeUsage(db)).toEqual({ running: 1, waiting: 0 });
    releaseChatSlot(db, "turn-1");
    expect(claim(core, 1)?.stageRun.stage_key).toBe("rnd-b");
  });

  it("two waiting replies do not block each other once slots free up", () => {
    const { db } = world();
    expect(acquireChatSlot(db, "turn-1", 1, T0)).toBe(true);
    expect(acquireChatSlot(db, "turn-2", 2, T0)).toBe(true);
    expect(acquireChatSlot(db, "turn-3", 2, T0)).toBe(false);
    expect(acquireChatSlot(db, "turn-4", 2, T0)).toBe(false);
    releaseChatSlot(db, "turn-1");
    expect(acquireChatSlot(db, "turn-3", 2, T0)).toBe(true);
    expect(acquireChatSlot(db, "turn-4", 2, T0)).toBe(false);
    expect(claudeUsage(db)).toEqual({ running: 2, waiting: 1 });
  });

  it("a slot from a process that died runs out and the reaper clears it without error", () => {
    const { core, db } = world();
    expect(acquireChatSlot(db, "turn-1", 2, T0, 60)).toBe(true);
    expect(acquireChatSlot(db, "turn-2", 1, T0, 60)).toBe(false);
    heartbeatChatSlot(db, "turn-1", later(50), 60);
    expect(core.store.reapExpiredLeases(later(70))).toEqual([]);
    expect(claudeUsage(db)).toEqual({ running: 1, waiting: 0 }); // the wait expired, the heartbeated slot did not
    expect(core.store.reapExpiredLeases(later(200))).toEqual([]);
    expect(core.store.countLeasedResources()).toEqual({});
  });
});
