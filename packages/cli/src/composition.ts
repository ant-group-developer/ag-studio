import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, isHarnessError, ProjectConfigSchema, type AgentRuntime, type ChannelPackage, type ExecutorRef, type MediaConfig, type MediaEngine, type MediaEngineProbe, type MediaProber, type ProductionProfile, type ProjectConfig, type Publisher, type ScriptCommand, type ScriptsRegistry, type SourcesRegistry, type StatsCollector } from "@harness/contracts";
import { ArtifactRegistry, type AutoAcceptConfig, BUILTIN_CHECKERS, buildSnapshot, ChannelRegistry, compositionCheckers, Controller, distributionCheckers, type DoctorRow, EnvSecretResolver, ExternalOperationJournal, fullEpisodePath, HARNESS_ROOT, learningCheckers, LibraryFs, libraryCheckers, listWorkflowRefs, loadChannels, type LoadedWorkflow, loadProfile, loadScriptsRegistry, loadSourcesRegistry, loadWorkflow, matchCollection, mediaCheckers, MIGRATIONS_DIR, NullMediaProber, Planner, probeNvenc, Redactor, resolveWorkflowScope, runDoctor, scriptCommandsFrom, SourceCatalog, SqliteStateStore, SystemClock, Verifier, createLogger, loadHarnessConfig, writeSnapshotFile, type HarnessLogger, type LibraryRole, type LogLevel } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, GateExecutor, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeMediaEngine, FakeProvider, FakePublisher, FakeStatsCollector, fakeScriptCommands } from "@harness/adapter-fake";
import { FfprobeMediaProber, probeDurationSync } from "@harness/adapter-ffprobe";
import { CliAgentRuntime, RUNTIME_COMMANDS } from "@harness/adapter-agent-cli";
import { PythonMediaEngine, type PythonMediaEngineOptions } from "@harness/adapter-media-python";
import { PlaywrightPublisher, PlaywrightStatsCollector } from "@harness/adapter-youtube-playwright";
import { builtinMediaCommands } from "./commands/media.js";
import { gpuCurrentlyLeased, mediaProbeCacheKey, resolveFfmpegCapabilities, resolveMediaProbe, resolveNvencProbe } from "./media-probe-cache.js";
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
  /** Chosen by `project.yaml`'s `adapters.publisher`/`adapters.agent`/`adapters.stats`; the only place any
   * of the three adapters is picked. */
  publisher: Publisher;
  agentRuntime: AgentRuntime;
  /** Sub-project 3B: `StatsCollector` chosen by `project.yaml`'s `adapters.stats`. */
  stats: StatsCollector;
  /** Sub-project 5A: `MediaEngine` chosen by `project.yaml`'s `adapters.media` -- `PythonMediaEngine` (real
   * WhisperX transcribe / OmniVoice tts, requires `media.python`) or `FakeMediaEngine` (default, CI). */
  media: MediaEngine;
  /** `project.yaml`'s `media` block verbatim (device, transcribe/tts/scene/watch settings) -- stages that
   * need the raw config (not just the engine) read it from here. */
  mediaConfig: MediaConfig;
  publication: { verifySeconds: number; graceHours: number };
  dashboard: { port: number; refreshSeconds: number };
  /** Sub-project 3B: `project.yaml`'s `learning.collect_seconds`/`collect_batch` -- how often and how many
   * jobs per sweep the worker's `collectStats` (Task 3) considers. */
  learning: { collectSeconds: number; collectBatch: number };
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
 * The `channel-publish` script stages (fetch, build-package, upload, schedule; spec §3) plus the sub-project
 * 3B `channel-brief`/`demand`/`create-requests` stages shared by `channel-publish@1.1.0` and
 * `channel-planning@1.0.0` (spec §4.2) are built in the same way as the library ones above: each re-invokes
 * this CLI as `harness --project <projectDir> publish stage <name>`, reading `stage-request.json` from the
 * `ScriptExecutor`-provided workspace.
 */
export function builtinPublishCommands(argv: string[], projectDir: string): Record<string, ScriptCommand> {
  const names = ["fetch", "build-package", "upload", "schedule", "channel-brief", "demand", "create-requests"] as const;
  const commands: Record<string, ScriptCommand> = {};
  for (const name of names) commands[`publish-${name}`] = { argv: [...argv, "--project", projectDir, "publish", "stage", name], cwd: "." };
  return commands;
}

/**
 * Sub-project 3B Task 6: `CollectDeps.durationOf` -- the video duration (seconds) `evaluateHypotheses`/
 * `learnChannelStandard` need for `avg_view_pct`. Nothing in the control plane stores a committed package's
 * duration (`buildUploadManifest`, `packages/core/src/distribution/packages.ts`, never records one), but
 * `build-package`'s own naming convention (`packages/cli/src/commands/publish-stage.ts` `buildPackageStage`)
 * is fully derivable from the package row alone: the committed video always lands at
 * `fullEpisodePath(pkg)`, the single shared constant `buildPackageStage` writes to and this probes -- a
 * rename in one can no longer silently break the other. Probed with `probeDurationSync` (a synchronous
 * ffprobe call -- `durationOf` has no `await` point available to it); a missing file, a missing ffprobe
 * binary, or a probe failure all return `null` ("unknown"), never throw.
 */
export function durationOfPackage(pkg: ChannelPackage): number | null {
  const videoPath = fullEpisodePath(pkg);
  if (!existsSync(videoPath)) return null;
  return probeDurationSync(videoPath);
}

export function loadProject(projectDir: string): ProjectConfig {
  const file = join(projectDir, "project.yaml");
  if (!existsSync(file)) throw new HarnessError("NOT_FOUND", `project.yaml not found in ${projectDir}`, { projectDir });
  return ProjectConfigSchema.parse(parse(readFileSync(file, "utf8")));
}

/**
 * Resolves the `python`/`transcribePython`/`ttsPython` fields `PythonMediaEngine` needs from `project.yaml`'s
 * `media` block: `media.python` is the shared default, `media.transcribe.python`/`media.tts.python` override
 * it per stage. `media.python` alone is enough to run either stage (the required top-level `python` field can
 * come from it directly); with no top-level default, BOTH per-engine overrides must be set instead -- one of
 * them is used as the required `python` field (either is fine, since `transcribe()`/`synthesize()` each still
 * resolve their own override first), but whichever stage is left with neither a top-level default nor its own
 * override throws `CONFIG_INVALID` naming exactly that missing key, caught here once instead of failing deep
 * inside the first `transcribe`/`synthesize` call (or worse, spawning `undefined` as a command).
 */
export function mediaEngineOptions(project: ProjectConfig, harnessRoot: string, redact: (s: string) => string): PythonMediaEngineOptions {
  const top = project.media.python;
  const transcribePython = project.media.transcribe.python;
  const ttsPython = project.media.tts.python;

  const python = top ?? transcribePython ?? ttsPython;
  if (!python) throw new HarnessError("CONFIG_INVALID", 'project.yaml media.python is required when adapters.media is "python" (or set both media.transcribe.python and media.tts.python)', { field: "media.python" });
  if (!top && !transcribePython) throw new HarnessError("CONFIG_INVALID", 'project.yaml media.transcribe.python is required when adapters.media is "python" and media.python is not set', { field: "media.transcribe.python" });
  if (!top && !ttsPython) throw new HarnessError("CONFIG_INVALID", 'project.yaml media.tts.python is required when adapters.media is "python" and media.python is not set', { field: "media.tts.python" });

  return {
    python,
    enginesDir: join(harnessRoot, "engines", "python"),
    device: project.media.device,
    transcribe: project.media.transcribe,
    tts: project.media.tts,
    redact,
    ...(transcribePython ? { transcribePython } : {}),
    ...(ttsPython ? { ttsPython } : {}),
  };
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
  // `HARNESS_FAKE_STATS_FILE` reaches `FakeStatsCollector` ONLY: a test env var must never be able to make
  // the real collector answer a real channel's stats from a JSON file (recorded as a genuine
  // `source: "studio"` snapshot) just because it was left set in an operator's shell -- final-review finding,
  // sub-project 3B. Reading from a file is what `adapters.stats: fake` is for.
  const stats: StatsCollector = project.adapters.stats === "playwright"
    ? new PlaywrightStatsCollector({ redact: (s) => redactor.redact(s) })
    : new FakeStatsCollector({ ...(process.env.HARNESS_FAKE_STATS_FILE ? { file: process.env.HARNESS_FAKE_STATS_FILE } : {}) });
  // Sub-project 5A: the only place a MediaEngine is chosen (spec: Global constraints). See
  // `mediaEngineOptions` for how `media.python`/`media.transcribe.python`/`media.tts.python` resolve.
  const media: MediaEngine = project.adapters.media === "python"
    ? new PythonMediaEngine(mediaEngineOptions(project, harnessRoot, (s) => redactor.redact(s)))
    : new FakeMediaEngine();
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
    verifier: new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(prober, { available: proberAvailable, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg" }), ...libraryCheckers(prober, { available: proberAvailable }), ...compositionCheckers({ prober, available: proberAvailable, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg" }), ...distributionCheckers({ store, channels, secrets }), ...learningCheckers({ store })]),
    executors, journal, provider, harness, project, projectDir, dataRoot, logger, clock, secrets, migrationsDir: MIGRATIONS_DIR, workflows, profiles, catalog,
    resourceCapacity: project.resources, executorVersionFor: (ref: ExecutorRef) => executors.resolve(ref).version, scripts, sources, configErrors, proberAvailable, harnessRoot, prober,
    scriptCommandNames: Object.keys(commands), ...(library ? { library } : {}), channels, channelErrors, publisher, agentRuntime, stats, media, mediaConfig: project.media,
    publication: { verifySeconds: project.publication.verify_seconds, graceHours: project.publication.verify_grace_hours },
    dashboard: { port: project.dashboard.port, refreshSeconds: project.dashboard.refresh_seconds },
    learning: { collectSeconds: project.learning.collect_seconds, collectBatch: project.learning.collect_batch },
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

/** Collection-mode `library:auto_accept` doctor input (sub-project 5A Task 9 fix round): every kho collection
 * matching at least one of `patterns` that has at least one non-restricted source, with that source count --
 * `doctor.ts`'s `checkLibraryAutoAccept` stays pure, so this scan lives here instead. */
function autoAcceptMatchingCollections(store: AppContext["store"], patterns: string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of store.listSourceItems()) {
    if (s.rights_status === "restricted") continue;
    if (!patterns.some((p) => matchCollection(s.collection, p))) continue;
    counts.set(s.collection, (counts.get(s.collection) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, count]) => ({ name, count }));
}

/** `library.auto_accept.workflow_release ?? the "studio" profile's own workflow_release` -- the release the
 * autopilot loop actually plans against right now (sub-project 5A Task 8's rollback knob, task 9's `media:engine`
 * row). `undefined` when there is no auto_accept config at all, or (defensively) when the "studio" profile
 * itself fails to load -- `checkProfiles`/`profile:studio:workflow` already reports that failure on its own row. */
function effectiveAutopilotRelease(ctx: AppContext): string | undefined {
  const autoAccept = ctx.library?.autoAccept;
  if (!autoAccept) return undefined;
  if (autoAccept.workflow_release) return autoAccept.workflow_release;
  try { return ctx.profiles("studio").workflow_release; }
  catch { return undefined; }
}

/** `DoctorInput.mediaEngineOnFake` (sub-project 5A Task 9): only when this project actually runs the studio
 * autopilot loop on the fake engine -- `adapters.media: "fake"` on a studio project with `auto_accept.enabled`.
 * `doctor.ts`'s `checkMediaEngineOnFake` decides from the release string alone whether that is actually a
 * problem (library-production@1.2.0+ needs the real engine; older releases don't). */
function mediaEngineOnFakeInput(ctx: AppContext): { effectiveRelease: string } | undefined {
  if (ctx.project.adapters.media !== "fake") return undefined;
  if (ctx.library?.role !== "studio" || !ctx.library.autoAccept?.enabled) return undefined;
  const effectiveRelease = effectiveAutopilotRelease(ctx);
  return effectiveRelease ? { effectiveRelease } : undefined;
}

/** `DoctorInput.render` (sub-project 5B Task 9): the ffmpeg binary this project would actually spawn for
 * `media-render`, same `process.env.FFMPEG_PATH ?? "ffmpeg"` convention `buildContext`'s own
 * `mediaCheckers`/`compositionCheckers` wiring uses just above. Studio role only, regardless of
 * `adapters.media` -- ffmpeg compose/render never goes through the Python engine. `null` (not `undefined`)
 * when `resolveFfmpegCapabilities` could not even run ffmpeg -- `doctor.ts`'s `checkMediaRender` turns that
 * into the "ffmpeg not runnable" row; `undefined` (this function's own return when role is not "studio")
 * means no row is added at all. */
async function mediaRenderInput(ctx: AppContext, mode: "fresh" | "cached", nowMs: () => number): Promise<{ filters: string[]; encoders: string[]; nvenc: boolean | null } | null | undefined> {
  if (ctx.library?.role !== "studio") return undefined;
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const caps = await resolveFfmpegCapabilities({ ffmpeg, mode, nowMs });
  if (!caps) return null;
  const nvenc = await resolveNvencProbe({ ffmpeg, probe: probeNvenc, nowMs });
  return { filters: caps.filters, encoders: caps.encoders, nvenc };
}

/**
 * The full `DoctorRow[]` `harness doctor` reports: workflow-scope resolution (`project.yaml.workflows`, or a
 * scan of every `workflow.yaml` under the harness install's `workflows/` dir when unset) and profile loading,
 * followed by `runDoctor`'s own checks. Shared between `commands/doctor.ts` (prints these rows) and
 * `writeDashboardSnapshot` below (turns the failing ones into `alerts[].kind === "doctor"`, design §6.1) so
 * the ~20-line input assembly is not duplicated between the two call sites.
 *
 * Async (sub-project 5A Task 9): `media:python|packages|device|models` need `MediaEngine.probe()`, which spawns
 * a python child process -- awaited here, once, only when `adapters.media === "python"`, so `doctor.ts` itself
 * stays a pure/sync row builder over a plain `MediaEngineProbe` literal.
 *
 * `opts.mediaProbe` (coordinator review, Task 9 fix round): `"fresh"` (the default -- `harness doctor` run by
 * hand) always spawns a probe. `"cached"` (`writeDashboardSnapshot` below, called on every worker idle poll)
 * reuses a still-fresh result from the module-level cache in `media-probe-cache.ts` instead of spawning a
 * torch-importing subprocess roughly once a minute forever; `opts.nowMs` is injectable so tests never need
 * real timers.
 */
export async function computeDoctorRows(ctx: AppContext, opts: { mediaProbe?: "fresh" | "cached"; nowMs?: () => number } = {}): Promise<DoctorRow[]> {
  const mediaProbeMode = opts.mediaProbe ?? "fresh";
  const nowMs = opts.nowMs ?? Date.now;
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

  let media: { pythonPath: string; device: string; probe: MediaEngineProbe } | undefined;
  if (ctx.project.adapters.media === "python") {
    const options = mediaEngineOptions(ctx.project, ctx.harnessRoot, (s) => s);
    const cacheKey = mediaProbeCacheKey(options);
    const gpuLeased = mediaProbeMode === "cached" && gpuCurrentlyLeased(ctx.store);
    const probe = await resolveMediaProbe({ engine: ctx.media, cacheKey, mode: mediaProbeMode, nowMs, gpuLeased });
    if (probe) media = { pythonPath: options.python, device: ctx.mediaConfig.device, probe };
  }
  const mediaEngineOnFake = mediaEngineOnFakeInput(ctx);
  const render = await mediaRenderInput(ctx, mediaProbeMode, nowMs);

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
                      ...(ctx.library.autoAccept.source_collections
                        ? { matchingCollections: autoAcceptMatchingCollections(ctx.store, ctx.library.autoAccept.source_collections) }
                        : {}),
                      ...(ctx.library.autoAccept.workflow_release
                        ? { pinnedWorkflowLoadable: (() => { try { ctx.workflows(ctx.library!.autoAccept!.workflow_release!); return true; } catch { return false; } })() }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      channels: { loaded: ctx.channels.list(), errors: ctx.channelErrors, secrets: ctx.secrets },
      ...(ctx.channels.list().length > 0
        ? { learning: { harnessRoot: ctx.harnessRoot, statsAdapter: ctx.project.adapters.stats, agentIsFake: ctx.project.adapters.agent === "fake", loadProfile: ctx.profiles, loadWorkflow: ctx.workflows } }
        : {}),
      agent: ctx.project.adapters.agent === "cli"
        ? {
            kind: "cli", runtime: ctx.project.runtime,
            argv0: ctx.project.adapters.agent_argv?.[0] ?? RUNTIME_COMMANDS[ctx.project.runtime].argv[0]!,
            isAvailable: (argv0: string) => CliAgentRuntime.isAvailable(ctx.project.runtime, argv0),
          }
        : { kind: "fake", runtime: ctx.project.runtime, argv0: ctx.project.runtime, isAvailable: () => true },
      publisher: { name: ctx.publisher.name },
      ...(media ? { media } : {}),
      ...(mediaEngineOnFake ? { mediaEngineOnFake } : {}),
      ...(render !== undefined ? { render } : {}),
    }),
  ];
}

/** `runDoctor` (via `computeDoctorRows`) + `buildSnapshot` + `writeSnapshotFile`: the one place a dashboard
 * snapshot gets written, called by both `harness dashboard snapshot|serve` and the worker's periodic refresh
 * (Task 9's `WorkerDeps.dashboard.write`). */
export async function writeDashboardSnapshot(ctx: AppContext): Promise<string> {
  // "cached": this runs on every worker idle poll (roughly every `dashboard.refreshSeconds`, forever) --
  // `harness doctor` itself (an operator asking on purpose) still always probes fresh (composition.ts's
  // `computeDoctorRows` default).
  const doctorRows = await computeDoctorRows(ctx, { mediaProbe: "cached" });
  const snapshot = buildSnapshot({
    store: ctx.store, channels: ctx.channels.list(), doctorRows, clock: ctx.clock,
    gateWindowSeconds: ctx.harness.resource_wait_warn_seconds, project_id: ctx.project.project_id,
    media: { engine: ctx.project.adapters.media, render_encoder_cfg: ctx.mediaConfig.render.encoder, resources_gpu: ctx.resourceCapacity.gpu ?? 0 },
    ...(ctx.library ? { library: { fs: ctx.library.fs, role: ctx.library.role, ...(ctx.library.autoAccept ? { autoAccept: ctx.library.autoAccept } : {}) } } : {}),
    ...(ctx.library ? { learning: { libraryItems: ctx.store.listLibraryItems({ status: "approved" }), libraryClaimsOf: (itemId: string) => ctx.library!.fs.listClaims(itemId) } } : {}),
  });
  return writeSnapshotFile(ctx.dataRoot, snapshot);
}
