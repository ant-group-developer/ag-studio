import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, isHarnessError, ProjectConfigSchema, type AgentRuntime, type ExecutorRef, type MediaConfig, type MediaEngine, type MediaEngineProbe, type MediaProber, type ProductionProfile, type ProjectConfig, type ScriptsRegistry, type SourcesRegistry } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, compositionCheckers, Controller, type DoctorRow, EnvSecretResolver, ExternalOperationJournal, HARNESS_ROOT, libraryCheckers, listWorkflowRefs, type LoadedWorkflow, loadProfile, loadScriptsRegistry, loadSourcesRegistry, loadWorkflow, mediaCheckers, MIGRATIONS_DIR, NullMediaProber, Planner, probeNvenc, Redactor, resolveWorkflowScope, runDoctor, scriptCommandsFrom, SourceCatalog, SqliteStateStore, SystemClock, Verifier, createLogger, loadHarnessConfig, LibraryFs, type HarnessLogger, type LibraryRole, type LogLevel } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, GateExecutor, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeMediaEngine, FakeProvider, fakeScriptCommands } from "@harness/adapter-fake";
import { FfprobeMediaProber } from "@harness/adapter-ffprobe";
import { CliAgentRuntime, RUNTIME_COMMANDS } from "@harness/adapter-agent-cli";
import { PythonMediaEngine, type PythonMediaEngineOptions } from "@harness/adapter-media-python";
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
   * kho commands, doctor's library rows, and the worker's periodic sync all share. */
  library?: { fs: LibraryFs; role: LibraryRole; syncSeconds: number };
  agentRuntime: AgentRuntime;
  /** Sub-project 5A: `MediaEngine` chosen by `project.yaml`'s `adapters.media` -- `PythonMediaEngine` (real
   * WhisperX transcribe / OmniVoice tts, requires `media.python`) or `FakeMediaEngine` (default, CI). */
  media: MediaEngine;
  /** `project.yaml`'s `media` block verbatim (device, transcribe/tts/scene/watch settings) -- stages that
   * need the raw config (not just the engine) read it from here. */
  mediaConfig: MediaConfig;
  close(): void;
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
  const agentRuntime: AgentRuntime = project.adapters.agent === "cli"
    ? new CliAgentRuntime({ runtime: project.runtime, skillsDir: join(harnessRoot, "skills"), redact: (s) => redactor.redact(s), ...(project.adapters.agent_argv ? { argv: project.adapters.agent_argv } : {}) })
    : new FakeAgentRuntime({ journal });
  // Sub-project 5A: the only place a MediaEngine is chosen (spec: Global constraints). See
  // `mediaEngineOptions` for how `media.python`/`media.transcribe.python`/`media.tts.python` resolve.
  const media: MediaEngine = project.adapters.media === "python"
    ? new PythonMediaEngine(mediaEngineOptions(project, harnessRoot, (s) => redactor.redact(s)))
    : new FakeMediaEngine();
  const argv = cliArgv();
  // an ops-project entry with the same name as a built-in (fake or media) wins, so ops projects can override them
  const commands = { ...fakeScriptCommands(), ...builtinMediaCommands(argv, projectDir), ...(scripts ? scriptCommandsFrom(scripts, projectDir) : {}) };
  executors.register("script", new ScriptExecutor(commands, { projectDir, secrets, cliArgv: argv }));
  executors.register("agent", new AgentExecutor(agentRuntime));
  executors.register("gate", new GateExecutor());
  const workflows = (ref: string) => loadWorkflow(harnessRoot, ref);
  const profiles = (id: string) => loadProfile(harnessRoot, id);
  const proberAvailable = FfprobeMediaProber.isAvailable();
  const prober = proberAvailable ? new FfprobeMediaProber() : new NullMediaProber();
  const catalog = new SourceCatalog({ store, dataRoot, prober, clock, materialize: project.source.materialize });
  const library = project.library
    ? { fs: new LibraryFs({ root: resolve(projectDir, project.library.root), role: project.library.role }), role: project.library.role, syncSeconds: project.library.sync_seconds }
    : undefined;
  return {
    store, planner, controller, registry,
    verifier: new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(prober, { available: proberAvailable, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg" }), ...libraryCheckers(prober, { available: proberAvailable }), ...compositionCheckers({ prober, available: proberAvailable, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg" })]),
    executors, journal, provider, harness, project, projectDir, dataRoot, logger, clock, secrets, migrationsDir: MIGRATIONS_DIR, workflows, profiles, catalog,
    resourceCapacity: project.resources, executorVersionFor: (ref: ExecutorRef) => executors.resolve(ref).version, scripts, sources, configErrors, proberAvailable, harnessRoot, prober,
    scriptCommandNames: Object.keys(commands), ...(library ? { library } : {}), agentRuntime, media, mediaConfig: project.media,
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
 * followed by `runDoctor`'s own checks.
 *
 * Async (sub-project 5A Task 9): `media:python|packages|device|models` need `MediaEngine.probe()`, which spawns
 * a python child process -- awaited here, once, only when `adapters.media === "python"`, so `doctor.ts` itself
 * stays a pure/sync row builder over a plain `MediaEngineProbe` literal.
 *
 * `opts.mediaProbe` (coordinator review, Task 9 fix round): `"fresh"` (the default -- `harness doctor` run by
 * hand) always spawns a probe. `"cached"` reuses a still-fresh result from the module-level cache in
 * `media-probe-cache.ts` instead of spawning a torch-importing subprocess; `opts.nowMs` is injectable so
 * tests never need real timers.
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
  const render = await mediaRenderInput(ctx, mediaProbeMode, nowMs);

  return [
    ...extraRows,
    ...runDoctor({
      projectDir: ctx.projectDir, project: ctx.project, harness: ctx.harness, scripts: ctx.scripts, builtinScripts: ctx.scriptCommandNames, workflows, profiles,
      secrets: ctx.secrets, proberAvailable: ctx.proberAvailable, store: ctx.store, migrationsDir: ctx.migrationsDir, configErrors: ctx.configErrors,
      ...(ctx.library ? { library: { fs: ctx.library.fs, role: ctx.library.role } } : {}),
      agent: ctx.project.adapters.agent === "cli"
        ? {
            kind: "cli", runtime: ctx.project.runtime,
            argv0: ctx.project.adapters.agent_argv?.[0] ?? RUNTIME_COMMANDS[ctx.project.runtime].argv[0]!,
            isAvailable: (argv0: string) => CliAgentRuntime.isAvailable(ctx.project.runtime, argv0),
          }
        : { kind: "fake", runtime: ctx.project.runtime, argv0: ctx.project.runtime, isAvailable: () => true },
      ...(media ? { media } : {}),
      ...(render !== undefined ? { render } : {}),
    }),
  ];
}
