import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { AttemptSchema, ArtifactSchema, RunSchema, StageRunSchema, EventSchema, LeaseSchema } from "../src/entities.js";

const now = "2026-09-11T00:00:00.000Z";

describe("entities", () => {
  it("round-trips a Run", () => {
    const run = {
      schema_version: "harness.run/v1",
      run_id: newId("run"),
      project_id: "project-main",
      portfolio_id: "portfolio-main",
      workflow_release: { id: "sample-three-stage", version: "1.0.0", digest: "sha256:" + "a".repeat(64) },
      profile_snapshot: { id: "cartoon", revision: 1 },
      state: "DRAFT",
      effective_config_snapshot: { lease_seconds: 90 },
      effective_config_digest: "sha256:" + "b".repeat(64),
      total_cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    expect(RunSchema.parse(run)).toEqual(run);
  });

  it("rejects unknown keys and bad ids", () => {
    const base = StageRunSchema.parse({
      schema_version: "harness.stage-run/v1",
      stage_run_id: newId("stage_run"),
      run_id: newId("run"),
      stage_key: "produce",
      executor: { type: "script", script: "fake-stage" },
      depends_on: [],
      required_capabilities: ["write_workspace"],
      required_checks: ["schema-valid"],
      retry: { max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] },
      stage_config: {},
      state: "PENDING",
      attempt_count: 0,
      result_failures: 0,
      created_at: now,
      updated_at: now,
    });
    expect(StageRunSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(StageRunSchema.safeParse({ ...base, run_id: "run_bad" }).success).toBe(false);
    expect(StageRunSchema.safeParse({ ...base, state: "FLYING" }).success).toBe(false);
  });

  it("requires sha256 checksums and Z timestamps", () => {
    const attempt = {
      schema_version: "harness.attempt/v1",
      attempt_id: newId("attempt"),
      stage_run_id: newId("stage_run"),
      run_id: newId("run"),
      lease_owner: "worker-1",
      fencing_token: 1,
      state: "CLAIMED",
      started_at: now,
      created_at: now,
      updated_at: now,
    };
    expect(AttemptSchema.safeParse(attempt).success).toBe(true);
    expect(AttemptSchema.safeParse({ ...attempt, started_at: "2026-09-11T00:00:00+07:00" }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ checksum: "md5:abc" }).success).toBe(false);
  });

  it("parses Event and Lease", () => {
    expect(EventSchema.safeParse({
      schema_version: "harness.event/v1", event_id: newId("event"), occurred_at: now,
      run_id: newId("run"), stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null,
      channel_id: null, content_id: null, variant_id: null, workflow_release: "sample@1.0.0",
      severity: "info", event_type: "run.created", payload: {},
    }).success).toBe(true);
    expect(LeaseSchema.safeParse({
      stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), owner: "w", expires_at: now, fencing_token: 1,
    }).success).toBe(true);
  });
});
