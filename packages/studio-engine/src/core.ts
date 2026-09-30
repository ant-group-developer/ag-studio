/**
 * The Studio engine's shared core: the harness state store on `studio.db`, the workflow/profile registry and
 * the verifier with Studio's checkers. The API (plans runs, submits gates) and the worker (executes stages)
 * both build exactly this, so a gate submitted from the web is verified by the same checkers a worker uses.
 */
import { mkdirSync } from "node:fs";
import {
  ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, isTerminal, loadHarnessConfig, loadProfile, loadWorkflow, MIGRATIONS_DIR,
  Planner, SqliteStateStore, studioCheckers, SystemClock, Verifier, type LoadedWorkflow,
} from "@harness/core";
import type { Clock, HarnessConfig, ProductionProfile } from "@harness/contracts";

/**
 * The two Studio series workflows: `plan` (one run per production, plans all episodes) and
 * `episode` (one run per episode, builds and renders one episode).
 */
export const STUDIO_WORKFLOWS = {
  plan: { workflow: "ag-studio-series-plan@1.0.0", profile: "studio-production" },
  episode: { workflow: "ag-studio-episode@1.0.0", profile: "studio-production" },
} as const;
export type StudioWorkflowKind = keyof typeof STUDIO_WORKFLOWS;

export const STUDIO_PROJECT_ID = "ag-studio";
export const STUDIO_PORTFOLIO_ID = "studio";
/** `claude`: one subscription call at a time. `farm`: stages waiting on ag-farm, not using this node's cpu. */
export const STUDIO_RESOURCES = { claude: 1, farm: 8, cpu: 2 };

export interface StudioEngineCoreOptions {
  /** `studio.db`: harness state + Studio tables. */
  dbPath: string;
  /** Workspaces and artifacts. */
  dataRoot: string;
  harnessRoot?: string;
  /** ffmpeg for the loudness part of `studio-render-valid`; absent = loudness not measured. */
  ffmpeg?: string;
  clock?: Clock;
}

export interface StudioEngineCore {
  store: SqliteStateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; clock: Clock;
  harness: HarnessConfig; workflows: (ref: string) => LoadedWorkflow; profiles: (id: string) => ProductionProfile;
  dataRoot: string; harnessRoot: string;
  close(): void;
}

export function createStudioEngineCore(o: StudioEngineCoreOptions): StudioEngineCore {
  const harnessRoot = o.harnessRoot ?? HARNESS_ROOT;
  mkdirSync(o.dataRoot, { recursive: true });
  const clock = o.clock ?? new SystemClock();
  const store = new SqliteStateStore(o.dbPath, clock);
  store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, o.dataRoot);
  const controller = new Controller({ store, registry, planner, clock });
  const verifier = new Verifier([...BUILTIN_CHECKERS, ...studioCheckers(o.ffmpeg ? { ffmpeg: o.ffmpeg } : {})]);
  const cache = new Map<string, LoadedWorkflow>();
  const workflows = (ref: string) => {
    let w = cache.get(ref);
    if (!w) { w = loadWorkflow(harnessRoot, ref); cache.set(ref, w); }
    return w;
  };
  const profiles = (id: string) => loadProfile(harnessRoot, id);
  return {
    store, planner, controller, registry, verifier, clock, harness: loadHarnessConfig(harnessRoot), workflows, profiles,
    dataRoot: o.dataRoot, harnessRoot, close: () => store.close(),
  };
}

/**
 * Cancel every non-terminal run whose workflow is not one of the two current Studio workflows.
 * Called once at worker start so the dev DB's old segment-based runs don't block new runs.
 */
export function cancelLegacyRuns(core: StudioEngineCore): void {
  const knownWorkflows: Set<string> = new Set(Object.values(STUDIO_WORKFLOWS).map((w) => w.workflow));
  // listRuns is not always available on the store; use a raw query through the underlying store if needed
  const runs = (core.store as unknown as { db?: { prepare: (s: string) => { all: (...p: unknown[]) => unknown[] } } })
    .db?.prepare("SELECT run_id, state, workflow_release FROM runs")?.all() as Array<{ run_id: string; state: string; workflow_release: string }> ?? [];
  for (const row of runs) {
    if (isTerminal("run", row.state)) continue;
    let workflowId: string | undefined;
    try {
      const rel = JSON.parse(row.workflow_release) as { id?: string; version?: string };
      workflowId = rel.id && rel.version ? `${rel.id}@${rel.version}` : undefined;
    } catch { /* ignore parse errors */ }
    if (!workflowId || !knownWorkflows.has(workflowId)) {
      try { core.planner.cancel(row.run_id); } catch { /* already terminal or not found */ }
    }
  }
}
