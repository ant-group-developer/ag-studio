import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Run, type StageRun, type RetryPolicy } from "@harness/contracts";
import { FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../src/index.js";

export function openTempStore(startIso = "2026-09-11T00:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const clock = new FixedClock(startIso);
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  return { store, dir, clock };
}

const SHA = "sha256:" + "a".repeat(64);
export function seedStage(store: SqliteStateStore, opts: { key?: string; caps?: string[]; retry?: Partial<RetryPolicy>; runId?: string; depends_on?: string[]; state?: StageRun["state"] } = {}) {
  const now = store.clock.now();
  const runId = opts.runId ?? newId("run");
  if (!opts.runId) {
    const run: Run = {
      schema_version: "harness.run/v1", run_id: runId, project_id: "project-main", portfolio_id: "portfolio-main",
      workflow_release: { id: "sample-three-stage", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "cartoon", revision: 1 },
      state: "READY", effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0, created_at: now, updated_at: now,
    };
    store.insertRun(run);
  }
  const stage: StageRun = {
    schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: runId, stage_key: opts.key ?? "produce",
    executor: { type: "script", script: "fake-stage" }, depends_on: opts.depends_on ?? [], required_capabilities: opts.caps ?? [],
    required_checks: ["schema-valid"], retry: { max_attempts: 3, backoff_seconds: [0, 0, 0], retry_on: ["transient", "abandoned"], ...opts.retry },
    stage_config: {}, state: opts.state ?? "READY", attempt_count: 0, result_failures: 0, ready_at: now, created_at: now, updated_at: now,
  };
  store.insertStageRun(stage);
  return { runId, stage };
}
