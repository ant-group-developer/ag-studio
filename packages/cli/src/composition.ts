import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, ProjectConfigSchema, type ExecutorRef, type ProductionProfile, type ProjectConfig, type ScriptsRegistry } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, EnvSecretResolver, ExternalOperationJournal, HARNESS_ROOT, loadProfile, loadScriptsRegistry, loadWorkflow, MIGRATIONS_DIR, NullMediaProber, Planner, Redactor, scriptCommandsFrom, SourceCatalog, SqliteStateStore, SystemClock, Verifier, createLogger, loadHarnessConfig, type HarnessLogger, type LoadedWorkflow, type LogLevel } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeProvider, fakeScriptCommands } from "@harness/adapter-fake";
import { cliArgv } from "./self.js";

export interface AppContext {
  store: SqliteStateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; executors: ExecutorRegistry;
  journal: ExternalOperationJournal; provider: FakeProvider; harness: ReturnType<typeof loadHarnessConfig>; project: ProjectConfig; projectDir: string;
  dataRoot: string; logger: HarnessLogger; clock: SystemClock; secrets: EnvSecretResolver; migrationsDir: string; workflows: (ref: string) => LoadedWorkflow;
  profiles: (id: string) => ProductionProfile; catalog: SourceCatalog; resourceCapacity: Record<string, number>; executorVersionFor: (ref: ExecutorRef) => string;
  scripts: ScriptsRegistry | undefined; close(): void;
}

export function loadProject(projectDir: string): ProjectConfig {
  const file = join(projectDir, "project.yaml");
  if (!existsSync(file)) throw new HarnessError("NOT_FOUND", `project.yaml not found in ${projectDir}`, { projectDir });
  return ProjectConfigSchema.parse(parse(readFileSync(file, "utf8")));
}

export function buildContext(o: { projectDir: string; harnessRoot?: string; owner?: string; capabilities?: string[]; logLevel?: LogLevel }): AppContext {
  const harnessRoot = o.harnessRoot ?? HARNESS_ROOT;
  const projectDir = resolve(o.projectDir);
  const project = loadProject(projectDir);
  const dataRoot = isAbsolute(project.data_root) ? project.data_root : resolve(projectDir, project.data_root);
  const harness = loadHarnessConfig(harnessRoot);
  const clock = new SystemClock();
  const secrets = new EnvSecretResolver();
  const redactor = new Redactor(() => secrets.resolvedValues());
  const logger = createLogger({ redactor, level: o.logLevel ?? ((process.env.HARNESS_LOG_LEVEL as LogLevel | undefined) ?? "info"), sink: (l) => process.stderr.write(l + "\n"), bindings: { project_id: project.project_id } });
  const store = new SqliteStateStore(join(dataRoot, "state", "harness.db"), clock);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dataRoot);
  const controller = new Controller({ store, registry, planner, clock });
  const provider = new FakeProvider();
  const journal = new ExternalOperationJournal(store, provider, clock);
  const executors = new ExecutorRegistry();
  const scripts = loadScriptsRegistry(projectDir);
  // an ops-project entry with the same name as a fake wins, so ops projects can override the built-in fakes
  const commands = { ...fakeScriptCommands(), ...(scripts ? scriptCommandsFrom(scripts, projectDir) : {}) };
  executors.register("script", new ScriptExecutor(commands, { projectDir, secrets, cliArgv: cliArgv() }));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime({ journal })));
  const workflows = (ref: string) => loadWorkflow(harnessRoot, ref);
  const profiles = (id: string) => loadProfile(harnessRoot, id);
  const catalog = new SourceCatalog({ store, dataRoot, prober: new NullMediaProber(), clock, materialize: project.source.materialize });
  return { store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, journal, provider, harness, project, projectDir, dataRoot, logger, clock, secrets, migrationsDir: MIGRATIONS_DIR, workflows, profiles, catalog, resourceCapacity: project.resources, executorVersionFor: (ref: ExecutorRef) => executors.resolve(ref).version, scripts, close: () => store.close() };
}
