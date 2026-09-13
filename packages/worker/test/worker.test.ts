import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionProfileSchema, ProjectConfigSchema, WorkflowDefinitionSchema, type Executor, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, NullMediaProber, Planner, Redactor, SourceCatalog, SqliteStateStore, Verifier, addSeconds, createLogger, loadHarnessConfig, loadProfile, loadWorkflow } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, GateExecutor, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker, type WorkerDeps } from "../src/worker.js";

function makeWorld(opts: { scriptExecutor?: Executor; owner?: string; clock?: FixedClock; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "wk-"));
  const clock = opts.clock ?? new FixedClock("2026-09-11T00:00:00.000Z");
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dir);
  const controller = new Controller({ store, registry, planner, clock });
  const executors = new ExecutorRegistry();
  executors.register("script", opts.scriptExecutor ?? new ScriptExecutor(fakeScriptCommands()));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  executors.register("gate", new GateExecutor());
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
  const logger = createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" });
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "reference" });
  const deps: WorkerDeps = { store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness, project, dataRoot: dir, owner: opts.owner ?? "w1", capabilities: ["write_workspace", "read_source"], logger, clock, workflows: (ref) => loadWorkflow(HARNESS_ROOT, ref), profiles: (id) => loadProfile(HARNESS_ROOT, id), resourceCapacity: { cpu: 2, gpu: 1 } };
  const worker = new Worker(deps);
  return { dir, clock, store, planner, worker, deps, catalog, executors };
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
/** `produce` is byte-identical in both workflows below, so its cache key (and therefore reuse) matches across them. */
const PRODUCE = { key: "produce", executor: { type: "script", script: "fake-stage" }, required_capabilities: ["write_workspace"], required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "script_text", mime_type: "text/plain" }], config: { content: "draft script" } };
const wfOne = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "one-stage", version: "1.0.0", defaults: { lease_seconds: 90 }, stages: [PRODUCE] }), digest: "sha256:" + "a".repeat(64) };
const wfTwo = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "two-stage", version: "1.0.0", defaults: { lease_seconds: 90 }, stages: [PRODUCE, { key: "finalize", executor: { type: "script", script: "fake-stage" }, depends_on: ["produce"], required_capabilities: ["write_workspace"], required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "final_text", mime_type: "text/plain" }], config: { content: "final" } }] }), digest: "sha256:" + "b".repeat(64) };

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
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    let release!: () => void;
    const hanging: Executor = { version: "hang@1", execute: () => new Promise<StageResult>((resolve) => { release = () => resolve({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const dead = makeWorld({ scriptExecutor: hanging, owner: "dead", clock });
    const run = planAndEnqueue(dead);
    const pending = dead.worker.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(121); // past the run-scoped lease (cartoon snapshot: 120s)
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
  it("marks the stage CANCELLED on abort when the run was cancelled while it ran", async () => {
    const ac = new AbortController();
    const hanging: Executor = { version: "hang@1", execute: (_r, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("aborted")))) };
    const w = makeWorld({ scriptExecutor: hanging });
    const run = planAndEnqueue(w);
    const pending = w.worker.runOnce(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    w.planner.cancel(run.run_id);
    const produceId = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!.stage_run_id;
    expect(w.store.getStageRun(produceId)?.state).toBe("CANCEL_REQUESTED");
    ac.abort();
    expect(await pending).toBe("done");
    expect(w.store.getStageRun(produceId)?.state).toBe("CANCELLED");
    expect(w.store.listAttempts(produceId)[0]?.state).toBe("CANCELLED");
    expect(w.store.getLease(produceId)).toBeUndefined();
    expect(w.store.getRun(run.run_id)?.state).toBe("CANCELLED");
  });
  it("does not requeue a stage it no longer owns when it is aborted", async () => {
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    const ac = new AbortController();
    const hanging: Executor = { version: "hang@1", execute: (_r, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("aborted")))) };
    const w = makeWorld({ scriptExecutor: hanging, clock, owner: "first" });
    const run = planAndEnqueue(w);
    const pending = w.worker.runOnce(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    const produceId = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!.stage_run_id;
    clock.advance(121);
    w.store.reapExpiredLeases(clock.now());
    const second = w.store.claim({ owner: "second", capabilities: ["write_workspace", "read_source"], now: clock.now(), leaseSeconds: 90 })!;
    expect(second.stageRun.stage_run_id).toBe(produceId);
    ac.abort();
    expect(await pending).toBe("lost");
    expect(w.store.getStageRun(produceId)?.state).toBe("CLAIMED"); // still the second worker's, not requeued
    expect(w.store.getLease(produceId)?.owner).toBe("second");
    expect(w.store.listAttempts(produceId).map((a) => a.state)).toEqual(["ABANDONED", "CLAIMED"]);
  });
  it("honours the run-scoped lease_seconds from the effective config snapshot", async () => {
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    let release!: () => void;
    const hanging: Executor = { version: "hang@1", execute: () => new Promise<StageResult>((resolve) => { release = () => resolve({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const w = makeWorld({ scriptExecutor: hanging, clock });
    const run = planAndEnqueue(w);
    expect(w.store.getRun(run.run_id)?.effective_config_snapshot.lease_seconds).toBe(120); // cartoon profile, harness default is 90
    const pending = w.worker.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(w.store.getLease(produce.stage_run_id)?.expires_at).toBe(addSeconds(clock.now(), 120));
    release();
    await pending;
  });
  it("does not accumulate abort listeners across claimed stages", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    const run = planAndEnqueue(w);
    const p = w.worker.runForever(ac.signal);
    for (let i = 0; i < 200 && w.store.getRun(run.run_id)?.state !== "SUCCEEDED"; i++) await new Promise((r) => setTimeout(r, 25));
    expect(w.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    const pending = getEventListeners(ac.signal, "abort").length; // old code: one stale listener per claimed stage (3 here)
    ac.abort();
    await p;
    expect(pending).toBeLessThanOrEqual(1);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
  it("does not accumulate abort listeners across idle polls", async () => {
    const w = makeWorld();
    const ac = new AbortController();
    const p = w.worker.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 4500)); // poll_seconds = 2 → at least two idle sleeps completed, a third pending
    const pending = getEventListeners(ac.signal, "abort").length;
    ac.abort();
    await p;
    expect(pending).toBeLessThanOrEqual(1); // old code: one stale listener per completed sleep (>= 3 here)
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
  it("settles a cancelled run after reaping the lease of its last cancel-requested stage", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    const claim = w.store.claim({ owner: "dead", capabilities: ["write_workspace"], now: w.clock.now(), leaseSeconds: 90 })!;
    const ev = { run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    w.store.transaction(() => {
      w.store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
      w.store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    });
    w.planner.cancel(run.run_id);
    expect(w.store.getRun(run.run_id)?.state).toBe("CANCEL_REQUESTED");
    w.clock.advance(121);
    expect(await w.worker.runOnce()).toBe("idle");
    expect(w.store.getStageRun(claim.stageRun.stage_run_id)?.state).toBe("CANCELLED");
    expect(w.store.getRun(run.run_id)?.state).toBe("CANCELLED");
  });
  it("turns a workspace setup failure into a transient attempt failure and requeues the stage", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    writeFileSync(join(w.dir, "blocker"), "not a directory");
    const broken = new Worker({ ...w.deps, dataRoot: join(w.dir, "blocker") });
    expect(await broken.runOnce()).toBe("done");
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(w.store.listAttempts(produce.stage_run_id)[0]?.state).toBe("FAILED");
    expect(w.store.listAttempts(produce.stage_run_id)[0]?.failure_kind).toBe("transient");
    expect(produce.state).toBe("READY");
    expect(w.store.getLease(produce.stage_run_id)).toBeUndefined();
  });
  it("passes options, source items and held resources to the executor request", async () => {
    const w = makeWorld();
    const raw = join(w.dir, "raw.txt"); writeFileSync(raw, "src");
    const { source } = await w.catalog.ingest({ path: raw });
    const content = w.catalog.createContent({ source_ids: [source.source_id], title: "c" });
    const { variant } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile: loadProfile(HARNESS_ROOT, "cartoon"), options: {} });
    const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content, variant });
    for (const s of w.store.listStageRuns(run.run_id)) w.store.updateStageRun({ ...s, requires_resources: s.stage_key === "produce" ? ["cpu"] : [] });
    w.planner.enqueue(run.run_id);
    let seen: StageRequest | undefined;
    w.executors.register("script", { version: "spy", execute: async (req) => { seen = req; return { schema_version: "harness.stage-result/v1", attempt_id: req.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: "spy", details: {} }] }; } });
    await w.worker.runOnce();
    expect(seen?.options).toEqual({});
    expect(seen?.source_items.map((s) => s.source_id)).toEqual([source.source_id]);
    expect(seen?.resources).toEqual(["cpu"]);
  });
  it("records every source of the content in artifact lineage, in order", async () => {
    const w = makeWorld();
    const a = join(w.dir, "a.txt"); writeFileSync(a, "aaa");
    const b = join(w.dir, "b.txt"); writeFileSync(b, "bbb");
    const s1 = (await w.catalog.ingest({ path: a })).source;
    const s2 = (await w.catalog.ingest({ path: b })).source;
    const profile = loadProfile(HARNESS_ROOT, "cartoon");
    const content = w.catalog.createContent({ source_ids: [s1.source_id, s2.source_id], title: "c" });
    const { variant } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content, variant });
    w.planner.enqueue(run.run_id);
    expect(await w.worker.runOnce()).toBe("done");
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    const [art] = w.store.listArtifacts({ stage_run_id: produce.stage_run_id, status: "ACCEPTED" });
    expect(art!.lineage.source_items).toEqual([s1.source_id, s2.source_id]); // used to record only run.source_id
  });
  it("does no resource bookkeeping on an idle poll when no READY stage requires a resource", async () => {
    const w = makeWorld();
    planAndEnqueue(w); // the sample workflow declares no requires_resources
    let calls = 0;
    const real = w.store.countLeasedResources.bind(w.store);
    w.store.countLeasedResources = () => { calls++; return real(); };
    const idle = new Worker({ ...w.deps, capabilities: [] }); // claims nothing: produce needs write_workspace
    expect(await idle.runOnce()).toBe("idle");
    expect(calls).toBe(1); // only claim()'s own count; the starvation check used to add a second one every poll
  });
  it("warns once per window while a READY stage is starved of a resource", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    for (const s of w.store.listStageRuns(run.run_id)) w.store.updateStageRun({ ...s, requires_resources: s.stage_key === "produce" ? ["gpu"] : [] });
    const produceId = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!.stage_run_id;
    const starved = new Worker({ ...w.deps, resourceCapacity: { gpu: 0 } });
    const warns = () => w.store.listEvents({ run_id: run.run_id }).filter((e) => e.event_type === "stage.waiting_resource");

    expect(await starved.runOnce()).toBe("idle");
    expect(warns()).toHaveLength(0); // still inside resource_wait_warn_seconds (600)
    w.clock.advance(601);
    expect(await starved.runOnce()).toBe("idle");
    expect(warns()).toHaveLength(1);
    expect(warns()[0]!.stage_run_id).toBe(produceId);
    expect(warns()[0]!.payload.resources).toEqual(["gpu"]);
    expect(await starved.runOnce()).toBe("idle");
    expect(warns()).toHaveLength(1); // deduped inside the same window
    w.clock.advance(601);
    expect(await starved.runOnce()).toBe("idle");
    expect(warns()).toHaveLength(2);
  });
  it("sends the resolved profile options to the executor even when the run has no variant", async () => {
    const w = makeWorld();
    const profile = ProductionProfileSchema.parse({ schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "sample-three-stage@1.0.0", options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" } });
    const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
    expect(run.variant_id).toBeUndefined();
    expect(w.store.getRun(run.run_id)?.options).toEqual({ voice: "none" });
    w.planner.enqueue(run.run_id);
    let seen: StageRequest | undefined;
    w.executors.register("script", { version: "spy", execute: async (req) => { seen = req; return { schema_version: "harness.stage-result/v1", attempt_id: req.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: "spy", details: {} }] }; } });
    await w.worker.runOnce();
    expect(seen?.options).toEqual({ voice: "none" }); // used to be {} whenever there was no variant
  });
  it("parks a stage WAITING_HUMAN when the artifact it reused went STALE before it ran", async () => {
    const w = makeWorld();
    const worker = new Worker({ ...w.deps, workflows: (ref) => (ref.startsWith("one-stage") ? wfOne : wfTwo) });
    const profile = loadProfile(HARNESS_ROOT, "cartoon");
    const content = w.catalog.createContent({ source_ids: [], title: "c" });
    const { variant } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    const version = w.executors.resolve({ type: "script", script: "fake-stage" }).version;
    const plan = (workflow: typeof wfOne) => w.planner.plan({ workflow, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content, variant, executorVersionFor: () => version });

    const runA = plan(wfOne);
    w.planner.enqueue(runA.run_id);
    expect(await worker.runOnce()).toBe("done");
    expect(w.store.getRun(runA.run_id)?.state).toBe("SUCCEEDED");
    const produceA = w.store.listStageRuns(runA.run_id)[0]!;
    const [artA] = w.store.listArtifacts({ stage_run_id: produceA.stage_run_id, status: "ACCEPTED" });

    const runB = plan(wfTwo);
    expect(w.store.listStageRuns(runB.run_id).map((s) => [s.stage_key, s.state])).toEqual([["produce", "SUCCEEDED"], ["finalize", "PENDING"]]);
    expect(w.store.listStageRuns(runB.run_id)[0]?.reused_artifact_ids).toEqual([artA!.artifact_id]);
    w.planner.enqueue(runB.run_id);
    const finalizeId = w.store.listStageRuns(runB.run_id)[1]!.stage_run_id;
    expect(w.store.getStageRun(finalizeId)?.state).toBe("READY");

    // something else supersedes run A's artifact while run B still has finalize to run
    const ev = { run_id: runA.run_id, stage_run_id: produceA.stage_run_id, attempt_id: null, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "warn" as const, event_type: "artifact.stale", payload: {} };
    w.store.transaction(() => w.store.transition("artifact", artA!.artifact_id, "ACCEPTED", "STALE", ev));

    expect(await worker.runOnce()).toBe("done");
    expect(w.store.getStageRun(finalizeId)?.state).toBe("WAITING_HUMAN");
    const attempt = w.store.listAttempts(finalizeId)[0]!;
    expect([attempt.state, attempt.failure_kind]).toEqual(["FAILED", "contract"]);
    expect(w.store.getRun(runB.run_id)?.state).toBe("WAITING");
    expect(w.store.listArtifacts({ stage_run_id: finalizeId })).toHaveLength(0);
  });
});
