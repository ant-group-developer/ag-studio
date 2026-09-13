import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema, type Executor, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "@harness/worker";

function worker(dir: string, clock: FixedClock, owner: string, script?: Executor) {
  const store = new SqliteStateStore(join(dir, "state.db"), clock); store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store); const registry = new ArtifactRegistry(store, dir);
  const executors = new ExecutorRegistry();
  executors.register("script", script ?? new ScriptExecutor(fakeScriptCommands())); executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "pf", display_name: "x" }] });
  const w = new Worker({ store, planner, controller: new Controller({ store, registry, planner, clock }), registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness: loadHarnessConfig(HARNESS_ROOT), project, dataRoot: dir, owner, capabilities: ["write_workspace", "read_source"], logger: createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" }), clock, workflows: (ref) => loadWorkflow(HARNESS_ROOT, ref), profiles: (id) => loadProfile(HARNESS_ROOT, id), resourceCapacity: {} });
  return { store, planner, w };
}

describe("18.3 #2 and #3 worker dies mid-render; lease expires; old worker cannot commit", () => {
  it("second worker reruns safely and the late result is fenced out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acc-")); const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    let finishLate!: () => void;
    const hanging: Executor = { version: "hang", execute: () => new Promise<StageResult>((res) => { finishLate = () => res({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "succeeded", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const dead = worker(dir, clock, "dead", hanging);
    const run = dead.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" });
    for (const s of dead.store.listStageRuns(run.run_id)) dead.store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] } });
    dead.planner.enqueue(run.run_id);
    const late = dead.w.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(dead.store.getLease(dead.store.listStageRuns(run.run_id)[0]!.stage_run_id)?.owner).toBe("dead");
    clock.advance(121); // past the run-scoped lease (cartoon snapshot: 120s)
    const alive = worker(dir, clock, "alive");
    while ((await alive.w.runOnce()) !== "idle") { /* drain */ }
    finishLate();
    expect(await late).toBe("lost");
    const produce = alive.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(alive.store.listAttempts(produce.stage_run_id).map((a) => [a.lease_owner, a.state, a.fencing_token])).toEqual([["dead", "ABANDONED", 1], ["alive", "SUCCEEDED", 2]]);
    expect(alive.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    expect(alive.store.listArtifacts({ run_id: run.run_id, status: "ACCEPTED" })).toHaveLength(3);
  });
});
