import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, isHarnessError, ProjectConfigSchema, type AgentRuntime, type ExecutorRef, type MediaProber, type ProductionProfile, type ProjectConfig, type Publisher, type ScriptCommand, type ScriptsRegistry, type SourcesRegistry } from "@harness/contracts";
import { ArtifactRegistry, type AutoAcceptConfig, BUILTIN_CHECKERS, buildSnapshot, ChannelRegistry, Controller, distributionCheckers, type DoctorRow, EnvSecretResolver, ExternalOperationJournal, HARNESS_ROOT, LibraryFs, libraryCheckers, listWorkflowRefs, loadChannels, type LoadedWorkflow, loadProfile, loadScriptsRegistry, loadSourcesRegistry, loadWorkflow, mediaCheckers, MIGRATIONS_DIR, NullMediaProber, Planner, Redactor, resolveWorkflowScope, runDoctor, scriptCommandsFrom, SourceCatalog, SqliteStateStore, SystemClock, Verifier, createLogger, loadHarnessConfig, writeSnapshotFile, type HarnessLogger, type LibraryRole, type LogLevel } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, GateExecutor, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeProvider, FakePublisher, fakeScriptCommands } from "@harness/adapter-fake";
import { FfprobeMediaProber } from "@harness/adapter-ffprobe";
import { CliAgentRuntime, RUNTIME_COMMANDS } from "@harness/adapter-agent-cli";
import { PlaywrightPublisher } from "@harness/adapter-youtube-playwright";
import { builtinMediaCommands } from "./commands/media.js";
import { cliArgv } from "./self.js";

export interface AppContext {
  store: SqliteStateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; executors: ExecutorRegistry;
  journal: ExternalOperationJournal; provider: FakeProvider; harness: ReturnType<typeof loadHarnessConfig>; project: ProjectConfig; projectDir: string;
  dataRoot: string; logger: HarnessLogger; clock: SystemClock; secrets: EnvSecretResolver; migrationsDir: string; workflows: (ref: string) => LoadedWorkflow;
  profiles: (id: string) => ProductionProfile; catalog: SourceCatalog; resourceCapacity: Record<string, number>; executorVersionFor: (ref: ExecutorRef) => string;
  scripts: ScriptsRegistry | undefined; sources: SourcesRegistry | undefined; proberAvailable: boolean; harnessRoot: string; prober: MediaProber;
  /** A malformed `executors/scripts.yaml` / `source-catalog/sources.yaml` must not stop `doctor` (or any other
   * command) from running: the registry stays `undefined` and the loader's message lands here, so `doctor` can
   * report it as a failing row and the commands that really need the registry can throw it themselves. */
  configErrors: { scripts?: string; sources?: string };
  /** Names the "script" executor resolves right now: built-in fakes plus any project scripts.yaml override. */
  scriptCommandNames: string[];
  /** Only present when `project.yaml` declares `library`; the filesystem handle and role/sync interval the
   * kho commands, doctor's library rows, and the worker's periodic sync all share. `autoAccept` is the raw
   * `project.yaml` config (present whenever `library.auto_accept` is set, even when `enabled: false`) --
   * `computeDoctorRows`/`writeDashboardSnapshot` below read it directly; `commands/worker.ts` turns it into
   * the full `AutoAcceptDeps` the `Worker` needs, gated on `library.role === "studio" && ...enabled`. */
  library?: { fs: LibraryFs; role: LibraryRole; syncSeconds: number; autoAccept?: AutoAcceptConfig };
  /** Always present (empty when the project declares no `channels/`), same pattern as `scripts`/`sources`
   * above -- a malformed `channel.yaml` must not stop every other command from running. */
  channels: ChannelRegistry;
  /** `loadChannels` errors swallowed the same way as `configErrors.scripts`/`.sources`: `doctor` reports them,
   * and a publish command that actually needs a channel re-throws via `requireChannel`. */
  channelErrors: string[];
  /** Chosen by `project.yaml`'s `adapters.publisher`/`adapters.agent`; the only place either adapter is picked. */
  publisher: Publisher;
  agentRuntime: AgentRuntime;
  publication: { verifySeconds: number; graceHours: number };
  dashboard: { port: number; refreshSeconds: number };
  close(): void;
}

/**
 * The four `library-production`/`style-study` script stages that touch the kho (spec §3.2 stages 1, 4, 9, 11)
 * are built in rather than wrapper scripts an ops project must supply: each just re-invokes this very CLI as
 * `harness --project <projectDir> library stage <name>`, which reads `stage-request.json` from the workspace
 * `ScriptExecutor` already set up (`HARNESS_WORKSPACE`) via `@harness/script-sdk`'s `start()`.
 */
export function builtinLibraryCommands(argv: string[], projectDir: string): Record<string, ScriptCommand> {
  const names = ["intake", "style-export", "export", "apply-review"] as const;
  const commands: Record<string, ScriptCommand> = {};
  for (const name of names) commands[`library-${name}`] = { argv: [...argv, "--project", projectDir, "library", "stage", name], cwd: "." };
  return commands;
}

/**
 * The four `channel-publish` script stages (fetch, build-package, upload, schedule; spec §3) are built in the
 * same way as the library ones above: each re-invokes this CLI as `harness --project <projectDir> publish
 * stage <name>`, reading `stage-request.json` from the `ScriptExecutor`-provided workspace.
 */
export function builtinPublishCommands(argv: string[], projectDir: string): Record<string, ScriptCommand> {
  const names = ["fetch", "build-package", "upload", "schedule"] as const;
  const commands: Record<string, ScriptCommand> = {};
  for (const name of names) commands[`publish-${name}`] = { argv: [...argv, "--project", projectDir, "publish", "stage", name], cwd: "." };
  return commands;
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
  const configErrors: { scripts?: string; sources?: string } = {};
  const guard = <T>(key: "scripts" | "sources", load: () => T | undefined): T | undefined => {
    try { return load(); }
    catch (e) {
      if (!isHarnessError(e, "CONFIG_INVALID")) throw e;
      configErrors[key] = e.message;
      return undefined;
    }
  };
  const scripts = guard("scripts", () => loadScriptsRegistry(projectDir));
  const sources = guard("sources", () => loadSourcesRegistry(projectDir));
  const channelErrors: string[] = [];
  let loadedChannels: ReturnType<typeof loadChannels> = [];
  try { loadedChannels = loadChannels(projectDir, project); }
  catch (e) { if (!isHarnessError(e, "CONFIG_INVALID")) throw e; channelErrors.push(e.message); }
  const channels = new ChannelRegistry(loadedChannels);
  const publisher: Publisher = project.adapters.publisher === "playwright"
    ? new PlaywrightPublisher({ redact: (s) => redactor.redact(s), ...(process.env.HARNESS_PUBLISHER_LOOKUP_FILE ? { lookupFile: process.env.HARNESS_PUBLISHER_LOOKUP_FILE } : {}) })
    : new FakePublisher();
  const agentRuntime: AgentRuntime = project.adapters.agent === "cli"
    ? new CliAgentRuntime({ runtime: project.runtime, skillsDir: join(harnessRoot, "skills"), redact: (s) => redactor.redact(s), ...(project.adapters.agent_argv ? { argv: project.adapters.agent_argv } : {}) })
    : new FakeAgentRuntime({ journal });
  const argv = cliArgv();
  // an ops-project entry with the same name as a built-in (fake or library/publish/media) wins, so ops projects can override them
  const commands = { ...fakeScriptCommands(), ...builtinLibraryCommands(argv, projectDir), ...builtinPublishCommands(argv, projectDir), ...builtinMediaCommands(argv, projectDir), ...(scripts ? scriptCommandsFrom(scripts, projectDir) : {}) };
  executors.register("script", new ScriptExecutor(commands, { projectDir, secrets, cliArgv: argv }));
  executors.register("agent", new AgentExecutor(agentRuntime));
  executors.register("gate", new GateExecutor());
  const workflows = (ref: string) => loadWorkflow(harnessRoot, ref);
  const profiles = (id: string) => loadProfile(harnessRoot, id);
  const proberAvailable = FfprobeMediaProber.isAvailable();
  const prober = proberAvailable ? new FfprobeMediaProber() : new NullMediaProber();
  const catalog = new SourceCatalog({ store, dataRoot, prober, clock, materialize: project.source.materialize });
  const library = project.library
    ? {
        fs: new LibraryFs({ root: resolve(projectDir, project.library.root), role: project.library.role }), role: project.library.role, syncSeconds: project.library.sync_seconds,
        ...(project.library.auto_accept ? { autoAccept: project.library.auto_accept } : {}),
      }
    : undefined;
  return {
    store, planner, controller, registry,
    verifier: new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(prober, { available: proberAvailable }), ...libraryCheckers(prober, { available: proberAvailable }), ...distributionCheckers({ store, channels, secrets })]),
    executors, journal, provider, harness, project, projectDir, dataRoot, logger, clock, secrets, migrationsDir: MIGRATIONS_DIR, workflows, profiles, catalog,
    resourceCapacity: project.resources, executorVersionFor: (ref: ExecutorRef) => executors.resolve(ref).version, scripts, sources, configErrors, proberAvailable, harnessRoot, prober,
    scriptCommandNames: Object.keys(commands), ...(library ? { library } : {}), channels, channelErrors, publisher, agentRuntime,
    publication: { verifySeconds: project.publication.verify_seconds, graceHours: project.publication.verify_grace_hours },
    dashboard: { port: project.dashboard.port, refreshSeconds: project.dashboard.refresh_seconds },
    close: () => store.close(),
  };
}

function subdirsWith(root: string, filename: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, filename)))
    .map((d) => d.name)
    .sort();
}

/**
 * The full `DoctorRow[]` `harness doctor` reports: workflow-scope resolution (`project.yaml.workflows`, or a
 * scan of every `workflow.yaml` under the harness install's `workflows/` dir when unset) and profile loading,
 * followed by `runDoctor`'s own checks. Shared between `commands/doctor.ts` (prints these rows) and
 * `writeDashboardSnapshot` below (turns the failing ones into `alerts[].kind === "doctor"`, design §6.1) so
 * the ~20-line input assembly is not duplicated between the two call sites.
 */
export function computeDoctorRows(ctx: AppContext): DoctorRow[] {
  const extraRows: DoctorRow[] = [];
  const scope = ctx.project.workflows;
  let workflows: { ref: string; loaded: LoadedWorkflow }[];
  if (scope) {
    const scoped = resolveWorkflowScope(scope, ctx.workflows);
    workflows = scoped.workflows;
    extraRows.push(...scoped.rows);
  } else {
    // listWorkflowRefs (core/orchestration/registry.ts) finds both `workflows/<id>/` (legacy, unversioned) and
    // `workflows/<id>@<version>/` directories; a ref it could not resolve a usable id/version for at all is
    // already dropped there, so any throw here is a genuine WORKFLOW_INVALID from actually loading the ref.
    workflows = [];
    for (const ref of listWorkflowRefs(ctx.harnessRoot)) {
      try { workflows.push({ ref, loaded: ctx.workflows(ref) }); }
      catch (e) { extraRows.push({ check: `workflow:${ref}`, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    }
  }
  extraRows.push({ check: "workflows", ok: true, detail: scope ? `scoped to project.yaml workflows: ${scope.join(", ")}` : "all workflows in harness" });

  const allProfiles: ProductionProfile[] = [];
  for (const dir of subdirsWith(join(ctx.harnessRoot, "production-profiles"), "profile.yaml")) {
    try { allProfiles.push(ctx.profiles(dir)); }
    catch (e) { extraRows.push({ check: `profile:${dir}:load`, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  }
  const profiles = scope ? allProfiles.filter((p) => scope.includes(p.workflow_release)) : allProfiles;

  return [
    ...extraRows,
    ...runDoctor({
      projectDir: ctx.projectDir, project: ctx.project, harness: ctx.harness, scripts: ctx.scripts, builtinScripts: ctx.scriptCommandNames, workflows, profiles,
      secrets: ctx.secrets, proberAvailable: ctx.proberAvailable, store: ctx.store, migrationsDir: ctx.migrationsDir, configErrors: ctx.configErrors,
      ...(ctx.library
        ? {
            library: {
              fs: ctx.library.fs, role: ctx.library.role,
              ...(ctx.library.autoAccept
                ? {
                    autoAccept: {
                      config: ctx.library.autoAccept,
                      sourceCount: ctx.store.listSourceItems({ collection: ctx.library.autoAccept.source_collection }).length,
                      agentIsFake: ctx.project.adapters.agent === "fake",
                    },
                  }
                : {}),
            },
          }
        : {}),
      channels: { loaded: ctx.channels.list(), errors: ctx.channelErrors, secrets: ctx.secrets },
      agent: ctx.project.adapters.agent === "cli"
        ? {
            kind: "cli", runtime: ctx.project.runtime,
            argv0: ctx.project.adapters.agent_argv?.[0] ?? RUNTIME_COMMANDS[ctx.project.runtime].argv[0]!,
            isAvailable: (argv0: string) => CliAgentRuntime.isAvailable(ctx.project.runtime, argv0),
          }
        : { kind: "fake", runtime: ctx.project.runtime, argv0: ctx.project.runtime, isAvailable: () => true },
      publisher: { name: ctx.publisher.name },
    }),
  ];
}

/** `runDoctor` (via `computeDoctorRows`) + `buildSnapshot` + `writeSnapshotFile`: the one place a dashboard
 * snapshot gets written, called by both `harness dashboard snapshot|serve` and the worker's periodic refresh
 * (Task 9's `WorkerDeps.dashboard.write`). */
export async function writeDashboardSnapshot(ctx: AppContext): Promise<string> {
  const doctorRows = computeDoctorRows(ctx);
  const snapshot = buildSnapshot({
    store: ctx.store, channels: ctx.channels.list(), doctorRows, clock: ctx.clock,
    gateWindowSeconds: ctx.harness.resource_wait_warn_seconds, project_id: ctx.project.project_id,
    ...(ctx.library ? { library: { fs: ctx.library.fs, ...(ctx.library.autoAccept ? { autoAccept: ctx.library.autoAccept } : {}) } } : {}),
  });
  return writeSnapshotFile(ctx.dataRoot, snapshot);
}
