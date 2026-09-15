import { describe, expect, it } from "vitest";
import { newId, type Run, type Artifact } from "@harness/contracts";
import { openTempStore } from "../helpers.js";
import { MIGRATIONS_DIR, SqliteStateStore } from "../../src/index.js";
import { join } from "node:path";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "a".repeat(64);
function makeRun(): Run {
  return {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf",
    workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 },
    options: {}, state: "DRAFT", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now,
  };
}

describe("SqliteStateStore", () => {
  it("migrates once and creates 19 tables", () => {
    const { store, dir } = openTempStore();
    expect(store.tableNames().sort()).toEqual(["artifact", "attempt", "channel_learned", "channel_package", "channel_sequence", "check_result", "content_item", "content_request", "content_variant", "edit_style", "event", "external_operation", "lease", "library_item", "publication_job", "run", "schema_migrations", "source_item", "stage_run", "video_metrics"]);
    expect(store.migrate(MIGRATIONS_DIR)).toEqual([]);
    const again = new SqliteStateStore(join(dir, "state.db"));
    expect(again.migrate(MIGRATIONS_DIR)).toEqual([]);
  });

  it("round-trips a run and validates on read", () => {
    const { store } = openTempStore();
    const run = makeRun();
    store.insertRun(run);
    expect(store.getRun(run.run_id)).toEqual(run);
    store.updateRun({ ...run, total_cost_usd: 1.5 });
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(1.5);
    expect(store.listRuns({ state: "DRAFT" })).toHaveLength(1);
    expect(store.getRun("run_missing")).toBeUndefined();
  });

  it("filters artifacts by status", () => {
    const { store } = openTempStore();
    const base: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"),
      attempt_id: newId("attempt"), type: "t", status: "PROVISIONAL", uri: "file:///a", checksum: sha, size_bytes: 1, mime_type: "text/plain",
      lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: now, updated_at: now,
    };
    store.insertArtifact(base);
    store.insertArtifact({ ...base, artifact_id: newId("artifact"), status: "ACCEPTED" });
    expect(store.listArtifacts({ stage_run_id: base.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
    expect(store.listArtifacts({ stage_run_id: base.stage_run_id })).toHaveLength(2);
  });

  it("appends events with generated id and clock time", () => {
    const { store, clock } = openTempStore();
    const runId = newId("run");
    const e = store.appendEvent({ run_id: runId, stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "run.created", payload: { a: 1 } });
    expect(e.event_id).toMatch(/^evt_/);
    expect(e.occurred_at).toBe(clock.now());
    clock.advance(1);
    store.appendEvent({ ...e, event_type: "run.enqueued" });
    expect(store.listEvents({ run_id: runId }).map((x) => x.event_type)).toEqual(["run.created", "run.enqueued"]);
  });

  it("listEvents({ newest: true }) returns the newest rows in chronological order", () => {
    const { store, clock } = openTempStore();
    const runId = newId("run");
    const base = { run_id: runId, stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, payload: {} };
    for (const t of ["one", "two", "three", "four", "five"]) { store.appendEvent({ ...base, event_type: `run.${t}` }); clock.advance(1); }
    expect(store.listEvents({ run_id: runId, limit: 2, newest: true }).map((x) => x.event_type)).toEqual(["run.four", "run.five"]);
    expect(store.listEvents({ limit: 2, newest: true }).map((x) => x.event_type)).toEqual(["run.four", "run.five"]);
    expect(store.listEvents({ run_id: runId, limit: 2 }).map((x) => x.event_type)).toEqual(["run.one", "run.two"]);
  });

  it("listEvents({ event_type }) filters by the dedicated column, combinable with run_id and newest", () => {
    const { store } = openTempStore();
    const runA = newId("run");
    const runB = newId("run");
    const base = { stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, payload: {} };
    store.appendEvent({ ...base, run_id: runA, event_type: "run.started" });
    store.appendEvent({ ...base, run_id: runA, event_type: "request.auto_accepted" });
    store.appendEvent({ ...base, run_id: runB, event_type: "request.auto_accepted" });
    store.appendEvent({ ...base, run_id: runB, event_type: "run.started" });

    expect(store.listEvents({ event_type: "request.auto_accepted" }).map((x) => x.run_id).sort()).toEqual([runA, runB].sort());
    expect(store.listEvents({ event_type: "request.auto_accepted", run_id: runA })).toHaveLength(1);
    expect(store.listEvents({ event_type: "run.missing" })).toEqual([]);

    // the filter must still work once the matching event_type is far outnumbered by unrelated events --
    // this is what makes the auto-accept skip-dedup check (packages/core/src/library/auto-accept.ts) cheap
    // and correct regardless of how many other events a project has accumulated.
    for (let i = 0; i < 1200; i++) store.appendEvent({ ...base, run_id: runA, event_type: "noise.event" });
    expect(store.listEvents({ event_type: "request.auto_accepted", newest: true }).map((x) => x.run_id).sort()).toEqual([runA, runB].sort());
  });

  it("rolls back a transaction when the callback throws", () => {
    const { store } = openTempStore();
    const run = makeRun();
    expect(() => store.transaction(() => { store.insertRun(run); throw new Error("boom"); })).toThrow("boom");
    expect(store.getRun(run.run_id)).toBeUndefined();
    store.transaction(() => { store.insertRun(run); store.transaction(() => store.updateRun({ ...run, total_cost_usd: 2 })); });
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(2);
  });

  it("rolls back only the inner unit when the outer catches the inner throw", () => {
    const { store } = openTempStore();
    const a = makeRun(); const b = makeRun();
    store.transaction(() => {
      store.insertRun(a);
      try { store.transaction(() => { store.insertRun(b); throw new Error("inner"); }); } catch { /* swallowed on purpose */ }
    });
    expect(store.getRun(a.run_id)).toBeDefined();
    expect(store.getRun(b.run_id)).toBeUndefined();
  });
});
