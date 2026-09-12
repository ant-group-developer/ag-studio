import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Artifact } from "@harness/contracts";
import { acceptedInputsFor, FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "@harness/core";

describe("18.3 #5 distribution never reads PROVISIONAL artifacts", () => {
  it("acceptedInputsFor filters by ACCEPTED even when PROVISIONAL and REJECTED rows exist upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc-"));
    const store = new SqliteStateStore(join(dir, "state.db"), new FixedClock("2026-09-11T00:00:00.000Z")); store.migrate(MIGRATIONS_DIR);
    const now = "2026-09-11T00:00:00.000Z"; const sha = "sha256:" + "a".repeat(64);
    const runId = newId("run");
    store.insertRun({ schema_version: "harness.run/v1", run_id: runId, project_id: "p", portfolio_id: "pf", workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 }, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now });
    const mk = (key: string, deps: string[]) => { const s = { schema_version: "harness.stage-run/v1" as const, stage_run_id: newId("stage_run"), run_id: runId, stage_key: key, executor: { type: "script" as const, script: "x" }, depends_on: deps, depends_on_optional: [], requires_resources: [], required_capabilities: [], required_checks: [], retry: { max_attempts: 1, backoff_seconds: [0], retry_on: [] }, stage_config: {}, state: "PENDING" as const, attempt_count: 0, result_failures: 0, created_at: now, updated_at: now }; store.insertStageRun(s); return s; };
    const up = mk("produce", []); const down = mk("finalize", ["produce"]);
    const art = (status: Artifact["status"]): Artifact => ({ schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: runId, stage_run_id: up.stage_run_id, attempt_id: newId("attempt"), type: "t", status, uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null }, checks: [], created_at: now, updated_at: now });
    for (const s of ["PROVISIONAL", "REJECTED", "ACCEPTED", "STALE"] as const) store.insertArtifact(art(s));
    const visible = acceptedInputsFor(store, down);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.status).toBe("ACCEPTED");
  });
});
