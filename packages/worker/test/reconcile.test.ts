import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, ExternalOperationJournal, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow, reconcileRun } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeProvider, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "../src/worker.js";

describe("reconcile after a lost connection", () => {
  it("does not dispatch twice and finishes the run after reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-"));
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    const store = new SqliteStateStore(join(dir, "state.db"), clock); store.migrate(MIGRATIONS_DIR);
    const planner = new Planner(store);
    const provider = new FakeProvider(); provider.lostAfterDispatch = true;
    const journal = new ExternalOperationJournal(store, provider, clock);
    const executors = new ExecutorRegistry();
    executors.register("script", new ScriptExecutor(fakeScriptCommands()));
    executors.register("agent", new AgentExecutor(new FakeAgentRuntime({ journal })));
    const project = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "codex", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
    const worker = new Worker({ store, planner, controller: new Controller({ store, registry: new ArtifactRegistry(store, dir), planner, clock }), registry: new ArtifactRegistry(store, dir), verifier: new Verifier(BUILTIN_CHECKERS), executors, harness: loadHarnessConfig(HARNESS_ROOT), project, dataRoot: dir, owner: "w", capabilities: ["write_workspace", "read_source"], logger: createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" }), clock, workflows: (ref) => loadWorkflow(HARNESS_ROOT, ref), profiles: (id) => loadProfile(HARNESS_ROOT, id), resourceCapacity: {} });
    const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
    for (const s of store.listStageRuns(run.run_id)) store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] }, stage_config: s.stage_key === "review" ? { ...s.stage_config, external_operation: true } : s.stage_config });
    planner.enqueue(run.run_id);
    while ((await worker.runOnce()) !== "idle") { /* drain */ }
    const review = () => store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")!;
    expect(review().state).toBe("NEEDS_RECONCILIATION");
    expect(store.getRun(run.run_id)?.state).toBe("WAITING");
    expect(provider.dispatchCount).toBe(1);
    const report = await reconcileRun({ store, provider, planner, clock }, run.run_id);
    expect(report).toEqual([{ operation_id: expect.stringMatching(/^op_/), status: "CONFIRMED", stage_key: "review", stageState: "READY" }]);
    provider.lostAfterDispatch = false;
    while ((await worker.runOnce()) !== "idle") { /* drain */ }
    expect(store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    expect(provider.dispatchCount).toBe(1);
    expect(store.listExternalOperations({ stage_run_id: review().stage_run_id })).toHaveLength(1);
  });
});
