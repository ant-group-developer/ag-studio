import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectConfigSchema } from "@harness/contracts";
import {
  ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, MIGRATIONS_DIR, NullMediaProber, Planner, Redactor,
  SourceCatalog, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow,
} from "@harness/core";
import { AgentExecutor, ExecutorRegistry, GateExecutor, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "@harness/worker";

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "acc12-"));
  const store = new SqliteStateStore(join(dir, "state.db"));
  store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dir);
  const controller = new Controller({ store, registry, planner, clock: store.clock });
  const executors = new ExecutorRegistry();
  executors.register("script", new ScriptExecutor(fakeScriptCommands()));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  executors.register("gate", new GateExecutor());
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
  const logger = createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" });
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock: store.clock, materialize: "reference" });
  const worker = new Worker({ store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness: loadHarnessConfig(HARNESS_ROOT), project, dataRoot: dir, owner: "w1", capabilities: ["write_workspace", "read_source"], logger, clock: store.clock, workflows: (ref) => loadWorkflow(HARNESS_ROOT, ref), profiles: (id) => loadProfile(HARNESS_ROOT, id), resourceCapacity: { cpu: 2, gpu: 1 } });
  return { dir, store, planner, catalog, worker };
}

async function drain(worker: Worker, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) if ((await worker.runOnce()) === "idle") return;
  throw new Error("did not drain");
}

// Simulates a profile revision bump without touching any file under production-profiles/: profile2 is
// profile1 (loaded straight off disk) with only `revision` and `overrides.lease_seconds` changed in memory,
// exactly the shape a real "cartoon@2" would take. No adapter or planner API needs the file to exist.
describe("18.3 #12 an old run stays explainable after its profile advances a revision", () => {
  it("run 1 keeps profile_snapshot revision 1, its own effective config and artifact reproducibility; run 2 on revision 2 is a distinct variant that reuses nothing and does not touch run 1's artifacts", async () => {
    const w = makeWorld();
    const raw = join(w.dir, "raw.txt");
    writeFileSync(raw, "raw bytes");
    const { source } = await w.catalog.ingest({ path: raw });
    const content = w.catalog.createContent({ source_ids: [source.source_id], title: "Episode" });

    const profile1 = loadProfile(HARNESS_ROOT, "cartoon"); // revision 1, overrides.lease_seconds: 120
    const profile2 = { ...profile1, revision: 2, overrides: { ...profile1.overrides, lease_seconds: 150 } };
    const workflow = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const harness = loadHarnessConfig(HARNESS_ROOT);

    const { variant: variant1 } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile: profile1, options: {} });
    const run1 = w.planner.plan({ workflow, profile: profile1, harness, projectId: "project-main", portfolioId: "portfolio-main", content, variant: variant1 });
    w.planner.enqueue(run1.run_id);
    await drain(w.worker);
    expect(w.store.getRun(run1.run_id)?.state).toBe("SUCCEEDED");

    const { variant: variant2 } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile: profile2, options: {} });
    expect(variant2.variant_id).not.toBe(variant1.variant_id); // profile revision is part of the variant key
    const run2 = w.planner.plan({ workflow, profile: profile2, harness, projectId: "project-main", portfolioId: "portfolio-main", content, variant: variant2 });
    w.planner.enqueue(run2.run_id);
    await drain(w.worker);
    expect(w.store.getRun(run2.run_id)?.state).toBe("SUCCEEDED");

    // run 1 reads back exactly as it ran, unaffected by the profile moving to revision 2 or by run 2 at all
    const run1After = w.store.getRun(run1.run_id)!;
    expect(run1After.profile_snapshot).toEqual({ id: "cartoon", revision: 1 });
    expect(run1After.effective_config_snapshot.lease_seconds).toBe(120); // profile1's override, captured at plan time

    const produce1 = w.store.listStageRuns(run1.run_id).find((s) => s.stage_key === "produce")!;
    const [artifact1] = w.store.listArtifacts({ stage_run_id: produce1.stage_run_id, status: "ACCEPTED" });
    expect(artifact1?.reproducibility.production_profile).toBe("cartoon@1");
    const manifestPath1 = join(dirname(fileURLToPath(artifact1!.uri)), "manifest.json");
    const manifest1 = JSON.parse(readFileSync(manifestPath1, "utf8")) as { reproducibility: { production_profile: string } };
    expect(manifest1.reproducibility.production_profile).toBe("cartoon@1");

    const createdEvent = w.store.listEvents({ run_id: run1.run_id }).find((e) => e.event_type === "run.created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.payload.options).toBeDefined();

    // run 2 is explainable at its own revision, and shares nothing with run 1 (a fresh variant)
    const run2After = w.store.getRun(run2.run_id)!;
    expect(run2After.profile_snapshot.revision).toBe(2);
    expect(run2After.effective_config_snapshot.lease_seconds).toBe(150);
    expect(w.store.listEvents({ run_id: run2.run_id }).some((e) => e.event_type === "stage.reused")).toBe(false);

    const produce2 = w.store.listStageRuns(run2.run_id).find((s) => s.stage_key === "produce")!;
    const [artifact2] = w.store.listArtifacts({ stage_run_id: produce2.stage_run_id, status: "ACCEPTED" });
    expect(artifact2?.reproducibility.production_profile).toBe("cartoon@2");
    expect(artifact2?.artifact_id).not.toBe(artifact1?.artifact_id);

    // invalidation never crosses a variant boundary: run 1's artifact is still ACCEPTED after run 2 finishes
    expect(w.store.getArtifact(artifact1!.artifact_id)?.status).toBe("ACCEPTED");
  });
});
