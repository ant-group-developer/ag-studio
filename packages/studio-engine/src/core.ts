/**
 * The Studio engine's shared core: the harness state store on `studio.db`, the workflow/profile registry and
 * the verifier with Studio's checkers. The API (plans runs, submits gates) and the worker (executes stages)
 * both build exactly this, so a gate submitted from the web is verified by the same checkers a worker uses.
 */
import { mkdirSync } from "node:fs";
import {
  ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, MIGRATIONS_DIR,
  Planner, SqliteStateStore, studioCheckers, SystemClock, Verifier, type LoadedWorkflow,
} from "@harness/core";
import type { Clock, HarnessConfig, ProductionProfile } from "@harness/contracts";

export const STUDIO_WORKFLOW = "ag-studio-production@1.0.0";
export const STUDIO_PROFILE = "studio-production";
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
