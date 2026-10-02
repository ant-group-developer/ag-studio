/**
 * The Studio engine's shared core: the harness state store on `studio.db`, the workflow/profile registry and
 * the verifier with Studio's checkers. The API (plans runs, submits gates) and the worker (executes stages)
 * both build exactly this, so a gate submitted from the web is verified by the same checkers a worker uses.
 */
import { mkdirSync } from "node:fs";
import {
  ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, isTerminal, listWorkflowRefs, loadHarnessConfig, loadProfile, loadWorkflow, MIGRATIONS_DIR,
  Planner, SqliteStateStore, studioCheckers, SystemClock, Verifier, type LoadedWorkflow,
} from "@harness/core";
import type { Clock, HarnessConfig, ProductionProfile } from "@harness/contracts";

/**
 * The two Studio series workflows: `plan` (one run per production, plans all episodes) and
 * `episode` (one run per episode, builds and renders one episode).
 */
export const STUDIO_WORKFLOWS = {
  plan: { workflow: "ag-studio-series-plan@2.0.0", profile: "studio-production" },
  episode: { workflow: "ag-studio-episode@1.1.0", profile: "studio-production" },
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
 * Cancel every non-terminal run whose workflow is not a Studio series workflow release on disk.
 * Called once at worker start so the dev DB's old segment-based runs don't block new runs.
 */
/** The Studio workflow ids: every release of them on disk stays runnable. */
const STUDIO_WORKFLOW_IDS = ["ag-studio-series-plan", "ag-studio-episode"];

/**
 * Every Studio workflow release on disk (`workflows/ag-studio-*@*`). `STUDIO_WORKFLOWS` only says what a NEW run
 * uses; a run keeps executing the release it was planned with, so a release is retired only by deleting its folder
 * (and a released folder is never edited: runs read it by id and version, with no digest check).
 */
export function studioWorkflowRefs(harnessRoot: string): string[] {
  return listWorkflowRefs(harnessRoot).filter((ref) => STUDIO_WORKFLOW_IDS.includes(ref.split("@")[0]!));
}

export function cancelLegacyRuns(core: StudioEngineCore): string[] {
  const known = new Set<string>([...Object.values(STUDIO_WORKFLOWS).map((w) => w.workflow), ...studioWorkflowRefs(core.harnessRoot)]);
  const cancelled: string[] = [];
  for (const run of core.store.listRuns()) {
    if (isTerminal("run", run.state) || run.state === "CANCEL_REQUESTED") continue;
    if (known.has(`${run.workflow_release.id}@${run.workflow_release.version}`)) continue;
    core.planner.cancel(run.run_id);
    cancelled.push(run.run_id);
  }
  return cancelled;
}
