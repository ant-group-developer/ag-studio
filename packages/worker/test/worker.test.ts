import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema, type Executor, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "../src/worker.js";

function makeWorld(opts: { scriptExecutor?: Executor; owner?: string; clock?: FixedClock; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "wk-"));
  const clock = opts.clock ?? new FixedClock(new Date().toISOString());
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dir);
  const controller = new Controller({ store, registry, planner, clock });
  const executors = new ExecutorRegistry();
  executors.register("script", opts.scriptExecutor ?? new ScriptExecutor(fakeScriptCommands()));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
  const logger = createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" });
  const worker = new Worker({ store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness, project, dataRoot: dir, owner: opts.owner ?? "w1", capabilities: ["write_workspace", "read_source"], logger, clock });
  return { dir, clock, store, planner, worker };
}
function planAndEnqueue(w: ReturnType<typeof makeWorld>, stageOverrides: Record<string, Record<string, unknown>> = {}) {
  const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
  for (const s of w.store.listStageRuns(run.run_id)) {
    const extra = stageOverrides[s.stage_key];
    w.store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] }, ...(extra ? { stage_config: { ...s.stage_config, ...extra } } : {}) });
  }
  w.planner.enqueue(run.run_id);
  return run;
}
async function drain(w: ReturnType<typeof makeWorld>, max = 20) {
  for (let i = 0; i < max; i++) { if ((await w.worker.runOnce()) === "idle") return i; }
  throw new Error("did not drain");
}

describe("Worker", () => {
  it("runs the sample workflow end to end with fake adapters", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    await drain(w);
    expect(w.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    const stages = w.store.listStageRuns(run.run_id);
    expect(stages.map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    const finalize = stages.find((s) => s.stage_key === "finalize")!;
    const [art] = w.store.listArtifacts({ stage_run_id: finalize.stage_run_id, status: "ACCEPTED" });
    expect(art?.lineage.input_artifacts).toHaveLength(2);
    expect(art?.type).toBe("final_text");
    expect(w.store.getRun(run.run_id)?.total_cost_usd).toBeCloseTo(0.04, 5);
  });
  it("retries a transient failure with a new attempt and workspace", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w, { produce: { fail_transient_times: 1 } });
    await drain(w);
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(produce.state).toBe("SUCCEEDED");
    expect(produce.attempt_count).toBe(2);
    const attempts = w.store.listAttempts(produce.stage_run_id);
    expect(attempts.map((a) => a.state)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(attempts[0]!.workspace_uri).not.toBe(attempts[1]!.workspace_uri);
  });
  it("a worker that dies mid-stage loses its lease; a second worker finishes; the first cannot commit", async () => {
    const clock = new FixedClock(new Date().toISOString());
    let release!: () => void;
    const hanging: Executor = { version: "hang@1", execute: () => new Promise<StageResult>((resolve) => { release = () => resolve({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const dead = makeWorld({ scriptExecutor: hanging, owner: "dead", clock });
    const run = planAndEnqueue(dead);
    const pending = dead.worker.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(91);
    const alive = makeWorld({ owner: "alive", clock, dir: dead.dir });
    await drain(alive);
    release();
    expect(await pending).toBe("lost");
    expect(alive.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    const produce = alive.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(alive.store.listAttempts(produce.stage_run_id).map((a) => [a.lease_owner, a.state])).toEqual([["dead", "ABANDONED"], ["alive", "SUCCEEDED"]]);
    expect(alive.store.listArtifacts({ stage_run_id: produce.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
  });
  it("cancels the current attempt on abort and requeues the stage", async () => {
    const ac = new AbortController();
    const hanging: Executor = { version: "hang@1", execute: (_r, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("aborted")))) };
    const w = makeWorld({ scriptExecutor: hanging });
    const run = planAndEnqueue(w);
    const p = w.worker.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await p;
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(produce.state).toBe("READY");
    expect(w.store.listAttempts(produce.stage_run_id)[0]?.state).toBe("CANCELLED");
    expect(w.store.getLease(produce.stage_run_id)).toBeUndefined();
  });
});
