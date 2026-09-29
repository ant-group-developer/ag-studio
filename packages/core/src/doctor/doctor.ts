import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessConfig, MediaEngineProbe, ProductionProfile, ProjectConfig, ScriptsRegistry, SecretResolver, StageDefinition, StateStore } from "@harness/contracts";
import { sha256FileSync } from "../artifacts/checksum.js";
import { EnvSecretResolver } from "../config/secrets.js";
import { loadBrand, type LoadedBrand } from "../library/brands.js";
import type { LibraryFs, LibraryRole } from "../library/files.js";
import type { LoadedWorkflow } from "../orchestration/registry.js";
import { loadSourcesRegistry, SOURCES_FILE } from "../source-catalog/sources-file.js";
import { parseWhen } from "../source-catalog/when.js";

export interface DoctorRow { check: string; ok: boolean; detail: string }

export interface DoctorInput {
  projectDir: string;
  project: ProjectConfig;
  harness: HarnessConfig;
  scripts: ScriptsRegistry | undefined;
  /** Names the runtime resolves even without a `scripts.yaml` entry (built-in fakes merged in by the CLI's
   * composition, e.g. "fake-stage") -- a script not found in `scripts` but listed here is not a real gap. */
  builtinScripts: string[];
  workflows: { ref: string; loaded: LoadedWorkflow }[];
  profiles: ProductionProfile[];
  secrets: SecretResolver;
  proberAvailable: boolean;
  store: StateStore;
  migrationsDir: string;
  /** Parse errors the composition root swallowed so one malformed config file does not abort every command
   * (`packages/cli/src/composition.ts`): a message here turns the matching `scripts`/`sources` row FAIL. */
  configErrors?: { scripts?: string; sources?: string };
  /** Only present when `project.yaml` declares `library`; adds the three `library:*` rows below.
   * `autoAccept` adds `library:auto_accept` too, but only on a `studio` project whose loop is `enabled`
   * -- pre-computed by the composition root (`sourceCount`/`agentIsFake`) rather than derived here, same as
   * `proberAvailable`/`configErrors` above. `matchingCollections`/`pinnedWorkflowLoadable` (sub-project 5A
   * Task 9 fix round) are collection-mode-only inputs, present when `config.source_collections` is set /
   * `config.workflow_release` is set respectively -- legacy mode (`source_collections` unset) never reads
   * either and is byte-identical to before. */
  library?: {
    fs: LibraryFs; role: LibraryRole;
  };
  /** Only present when the composition root has picked an agent runtime; checks `--version` only (never the
   * model) through the injected `isAvailable`, so doctor never has to import an adapter. */
  agent?: { kind: "cli" | "fake"; runtime: "claude" | "codex"; argv0: string; isAvailable: (argv0: string) => boolean };
  /** Sub-project 5A Task 9 (`media:python|packages|device|models`): only present when `adapters.media ===
   * "python"`. `MediaEngine.probe()` is async and spawns a python child process, so the composition root
   * awaits it once (`computeDoctorRows`) and hands the plain result here -- `doctor.ts` stays pure/sync and
   * never calls `probe()` itself. `pythonPath` is the configured `media.python` (or the transcribe/tts
   * override) doctor names when the probe could not even start the interpreter (`probe.python === null`). */
  media?: { pythonPath: string; device: string; probe: MediaEngineProbe };
  /** Sub-project 5A Task 9 (`media:engine`): only present when `adapters.media === "fake"` on a studio
   * project whose `library.auto_accept.enabled` is true -- the composition root resolves the effective
   * autopilot release (`auto_accept.workflow_release ?? the "studio" profile's own workflow_release`) since
   * doctor itself never loads a production profile. A release of `library-production@1.2.0` or later needs
   * the real Python engine to do anything useful; an older pinned release (e.g. a rollback to 1.1.0) still
   * runs fine on the fake engine, so `checkMediaEngineOnFake` below adds no row at all then. */
  mediaEngineOnFake?: { effectiveRelease: string };
  /** Sub-project 5B Task 9 (`media:render`): present only on a studio project (`library.role === "studio"`),
   * regardless of `adapters.media` -- ffmpeg compose/render is not gated on the Python engine at all. `null`
   * itself (not merely absent) means ffmpeg could not be probed (`resolveFfmpegCapabilities` returned `null`),
   * which `checkMediaRender` turns into the "ffmpeg not runnable" fail row; absent (`undefined`, the default)
   * means this project has no `library` or is `role: "channel"`, so no row is added at all. */
  render?: { filters: string[]; encoders: string[]; nvenc: boolean | null } | null;
}

const SCRIPT_FILE_RE = /\.(mjs|js|cjs|ts|py|sh)$/;

export interface WorkflowScopeResult { workflows: { ref: string; loaded: LoadedWorkflow }[]; rows: DoctorRow[] }

/** Resolves `project.yaml`'s `workflows` scope (the workflow releases this ops project actually runs) against
 * a loader, turning any ref that fails to load into a failing `workflow:<ref>` row instead of throwing --
 * `harness doctor` uses this when the scope is set so it checks only those releases (see `checkWorkflows`/
 * `checkProfiles` below, which only ever look at what's in `DoctorInput.workflows`/`.profiles`) instead of
 * every workflow installed in the harness. An unset scope means "check everything" and is resolved by the
 * caller via a directory scan instead (`packages/cli/src/commands/doctor.ts`), since that needs the harness
 * root's filesystem layout rather than a single ref lookup. */
export function resolveWorkflowScope(scope: readonly string[], loadWorkflow: (ref: string) => LoadedWorkflow): WorkflowScopeResult {
  const workflows: { ref: string; loaded: LoadedWorkflow }[] = [];
  const rows: DoctorRow[] = [];
  for (const ref of scope) {
    try { workflows.push({ ref, loaded: loadWorkflow(ref) }); }
    catch (e) { rows.push({ check: `workflow:${ref}`, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  }
  return { workflows, rows };
}

/** Checks a project + harness install for consistency without touching the network or mutating anything;
 * every fallible step (filesystem reads, secret resolution) is wrapped so one bad row never aborts the rest. */
export function runDoctor(i: DoctorInput): DoctorRow[] {
  return [
    checkMigrations(i),
    checkFfprobe(i),
    checkResources(i),
    ...checkWorkflows(i),
    ...checkProfiles(i),
    checkSources(i),
    ...(i.library
      ? [
          checkLibraryRoot(i.library), checkLibraryWrite(i.library), checkLibraryIndex(i.library), checkLibraryVoices(i.library),
          checkLibraryMusic(i.library, i.store),
          ...(i.library.role === "studio" ? [checkLibraryBrands(i.library)] : []),
        ]
      : []),
    ...(i.agent ? [checkAgentRuntime(i.agent)] : []),
    ...(i.media ? [checkMediaPython(i.media), checkMediaPackages(i.media), checkMediaDevice(i.media), checkMediaModels(i.media)] : []),
    ...(i.mediaEngineOnFake ? checkMediaEngineOnFake(i.mediaEngineOnFake) : []),
    ...(i.render !== undefined ? [checkMediaRender(i.render)] : []),
  ];
}

function checkMigrations(i: DoctorInput): DoctorRow {
  const files = existsSync(i.migrationsDir) ? readdirSync(i.migrationsDir).filter((f) => f.endsWith(".sql")).sort() : [];
  const applied = new Set(i.store.listAppliedMigrations());
  const pending = files.filter((f) => !applied.has(f));
  return { check: "migrations", ok: pending.length === 0, detail: pending.length === 0 ? `${files.length} migration(s) applied` : `pending migrations: ${pending.join(", ")}` };
}

function checkFfprobe(i: DoctorInput): DoctorRow {
  return { check: "ffprobe", ok: i.proberAvailable, detail: i.proberAvailable ? "ffprobe is available; media probing enabled" : "ffprobe not found on PATH; falling back to NullMediaProber" };
}

function checkResources(i: DoctorInput): DoctorRow {
  const entries = Object.entries(i.project.resources);
  return { check: "resources", ok: true, detail: entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "no resources declared in project.yaml" };
}

function checkWorkflows(i: DoctorInput): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const seen = new Set<string>();
  if (i.configErrors?.scripts) {
    rows.push({ check: "scripts", ok: false, detail: i.configErrors.scripts });
  } else if (!i.scripts) {
    rows.push({ check: "scripts", ok: true, detail: "executors/scripts.yaml not found; only built-in fake scripts available" });
  }
  for (const { loaded } of i.workflows) {
    const wfId = loaded.definition.id;
    for (const stage of loaded.definition.stages) {
      // without a scripts.yaml the project runs on built-in fakes only; per-script/wrapper/secret/resource
      // checks below assume a registry exists, so they are skipped entirely (see the "scripts" row above).
      if (stage.executor.type === "script") { if (i.scripts) rows.push(...checkScriptStage(i, i.scripts, wfId, stage, seen)); }
      else if (stage.executor.type === "gate") rows.push(checkGateOutputs(stage));
    }
  }
  return rows;
}

function checkScriptStage(i: DoctorInput, scripts: ScriptsRegistry, wfId: string, stage: StageDefinition, seen: Set<string>): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const scriptName = (stage.executor as { script: string }).script;
  const spec = scripts.scripts[scriptName];
  const builtin = !spec && i.builtinScripts.includes(scriptName);

  rows.push({
    check: `script:${wfId}/${stage.key}`,
    ok: !!spec || builtin,
    detail: spec ? `scripts.${scriptName} registered` : builtin ? `scripts.${scriptName} provided by built-in commands` : `scripts.${scriptName} not found in executors/scripts.yaml`,
  });

  if (spec) {
    const wrapperId = `wrapper:${scriptName}`;
    if (!seen.has(wrapperId)) {
      seen.add(wrapperId);
      const arg1 = spec.argv[1];
      if (arg1 && SCRIPT_FILE_RE.test(arg1)) {
        const path = resolve(i.projectDir, spec.cwd, arg1);
        const ok = existsSync(path);
        rows.push({ check: wrapperId, ok, detail: ok ? `${path} exists` : `${path} not found` });
      } else {
        rows.push({ check: wrapperId, ok: true, detail: "argv[1] is not a script file path; nothing to check" });
      }
    }

    for (const [envName, ref] of Object.entries(spec.env_refs)) {
      const secretId = `secret:${scriptName}:${envName}`;
      if (seen.has(secretId)) continue;
      seen.add(secretId);
      try {
        i.secrets.resolve(ref);
        rows.push({ check: secretId, ok: true, detail: `${envName} resolves from ${ref}` });
      } catch {
        const envVar = EnvSecretResolver.envName(ref);
        rows.push({ check: secretId, ok: false, detail: `${envName} (${ref}) could not be resolved; set ${envVar ?? "the matching HARNESS_SECRET_* variable"}` });
      }
    }
  }

  // requires_resources: the script's own override when scripts.yaml declares one, otherwise the workflow
  // stage's own declaration -- checked even when the script itself is not registered yet.
  const requires = spec?.requires_resources ?? stage.requires_resources;
  for (const res of requires) {
    const resId = `resource:${stage.key}:${res}`;
    if (seen.has(resId)) continue;
    seen.add(resId);
    const capacity = i.project.resources[res] ?? 0;
    rows.push({ check: resId, ok: capacity > 0, detail: capacity > 0 ? `capacity ${capacity}` : `"${res}" not declared with capacity > 0 in project.yaml resources` });
  }

  return rows;
}

function checkGateOutputs(stage: StageDefinition): DoctorRow {
  const unnamed = stage.outputs.filter((o) => !o.name).length;
  return { check: `gate-output:${stage.key}`, ok: unnamed === 0, detail: unnamed === 0 ? `${stage.outputs.length} output(s) named` : `${unnamed} output(s) missing "name"` };
}

function checkProfiles(i: DoctorInput): DoctorRow[] {
  const rows: DoctorRow[] = [];
  for (const profile of i.profiles) {
    const wf = i.workflows.find((w) => `${w.loaded.definition.id}@${w.loaded.definition.version}` === profile.workflow_release);
    rows.push({ check: `profile:${profile.profile_id}:workflow`, ok: !!wf, detail: wf ? `${profile.workflow_release} loaded` : `workflow release ${profile.workflow_release} not among loaded workflows` });

    if (wf) {
      for (const stage of wf.loaded.definition.stages) {
        if (!stage.when) continue;
        const clause = parseWhen(stage.when);
        const ok = Object.hasOwn(profile.options_schema, clause.key);
        rows.push({ check: `profile:${profile.profile_id}:when:${stage.key}`, ok, detail: ok ? `options.${clause.key} declared in options_schema` : `options.${clause.key} not declared in options_schema` });
      }
    }

    const bad = Object.entries(profile.options_defaults)
      .filter(([k, v]) => { const allowed = profile.options_schema[k]; return !allowed || typeof v !== "string" || !allowed.includes(v); })
      .map(([k, v]) => `${k}=${String(v)}`);
    rows.push({ check: `profile:${profile.profile_id}:options_defaults`, ok: bad.length === 0, detail: bad.length === 0 ? "options_defaults valid for options_schema" : `invalid: ${bad.join(", ")}` });
  }
  return rows;
}

/** `fs.exists()` only -- a missing root is a plain FAIL, no attempt to create it (doctor never mutates
 * anything the kho doesn't already have except the throwaway probe file `checkLibraryWrite` writes and removes). */
function checkLibraryRoot(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const ok = library.fs.exists();
  return { check: "library:root", ok, detail: ok ? `${library.fs.paths.root} exists` : `${library.fs.paths.root} not found` };
}

/** Writes then removes a throwaway file in the one directory this role is allowed to write (studio: `styles/`,
 * channel: `requests/`), via plain `node:fs` rather than `LibraryFs.writeJsonAtomic` -- doctor's probe file is
 * not a real style/request and should not have to satisfy `EditStyleSchema`/`ContentRequestSchema`.
 *
 * Doctor must never scaffold kho structure: an unmounted or missing target directory is a plain FAIL, with no
 * `mkdirSync` fallback (that would silently create local directories standing in for a share that isn't there). */
function checkLibraryWrite(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const targetDir = library.role === "studio" ? library.fs.paths.styles : library.fs.paths.requests;
  if (!existsSync(targetDir)) {
    return { check: "library:write", ok: false, detail: `directory missing: ${targetDir} (mount the library first)` };
  }
  // A dot-name ending in `.tmp`, never `.json`: `LibraryFs.listRequestIds` would otherwise pick a
  // `requests/<something>.json` probe up as a real request id (and `syncLibrary` report it corrupt) if this
  // probe ever outlived the `rmSync` below. Both roles use the same shape.
  const path = resolve(targetDir, `.doctor-${library.role}-${randomUUID()}.tmp`);
  let wrote = false;
  let removeError: unknown;
  try {
    writeFileSync(path, "{}");
    wrote = true;
  } catch (e) {
    return { check: "library:write", ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (wrote) { try { rmSync(path); } catch (e) { removeError = e; } }
  }
  if (removeError !== undefined) {
    return { check: "library:write", ok: false, detail: `wrote ${path} but could not remove it: ${removeError instanceof Error ? removeError.message : String(removeError)}` };
  }
  return { check: "library:write", ok: true, detail: `wrote and removed ${path}` };
}

/** `index.json` is studio-only and only written after a sync; its absence is not a failure. */
function checkLibraryIndex(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const path = library.fs.paths.index;
  if (!existsSync(path)) return { check: "library:index", ok: true, detail: `${path} not found` };
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { check: "library:index", ok: true, detail: `${path} parses` };
  } catch (e) {
    return { check: "library:index", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** `library:voices` (sub-project 5A): `<root>/voices` must exist and be a directory -- doctor never creates it,
 * same as `library:write`. For the studio role that is the whole check (studio never writes under `voices/**`,
 * so there is nothing to probe-write). For the channel role, also writes-then-removes a throwaway probe file
 * there, the same approach `checkLibraryWrite` uses for `requests/` -- a channel with no actual write access to
 * its own `voices/` directory (permissions, a read-only mount) would otherwise pass this row and then fail
 * confusingly at `library voices add` time. */
function checkLibraryVoices(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const check = "library:voices";
  const dir = library.fs.paths.voicesDir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { check, ok: false, detail: `directory missing: ${dir} (mount the library first)` };
  }
  if (library.role !== "channel") {
    return { check, ok: true, detail: `${dir} exists` };
  }
  const path = resolve(dir, `.doctor-${library.role}-${randomUUID()}.tmp`);
  let wrote = false;
  let removeError: unknown;
  try {
    writeFileSync(path, "{}");
    wrote = true;
  } catch (e) {
    return { check, ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (wrote) { try { rmSync(path); } catch (e) { removeError = e; } }
  }
  if (removeError !== undefined) {
    return { check, ok: false, detail: `wrote ${path} but could not remove it: ${removeError instanceof Error ? removeError.message : String(removeError)}` };
  }
  return { check, ok: true, detail: `wrote and removed ${path}` };
}

/** Compares a `LoadedBrand`'s fonts (and logo, when present) against the sha256 checksums recorded in its own
 * `brand.json`, synchronously (`sha256FileSync`) since every doctor check is a plain sync function -- the
 * async sibling `verifyBrandFiles` (`library/brands.ts`) is for callers with an await point (`intake`,
 * `media-compose`). Returns a one-line failure reason, or `undefined` when everything matches. */
function verifyBrandChecksumsSync(loaded: LoadedBrand): string | undefined {
  const files: [string, string][] = [["fonts.regular", loaded.font_regular_path], ["fonts.bold", loaded.font_bold_path]];
  if (loaded.logo_path) files.push(["logo", loaded.logo_path]);
  for (const [key, path] of files) {
    const expected = loaded.brand.checksums[key];
    if (!expected) return `missing checksum for ${key}`;
    if (!existsSync(path)) return `file missing: ${path}`;
    const { checksum } = sha256FileSync(path);
    if (checksum !== expected) return `checksum mismatch: ${path}`;
  }
  return undefined;
}

/** `library:music` (sub-project 5B, both roles): `<root>/music` must exist (doctor never creates it, same as
 * `library:voices`), and every `active` track mirrored in the store must have its file present in the kho with
 * a matching checksum -- a retired track's file is never checked (spec: retiring never touches the file, so a
 * stale/missing one there is not a live problem). */
function checkLibraryMusic(library: { fs: LibraryFs; role: LibraryRole }, store: StateStore): DoctorRow {
  const check = "library:music";
  const dir = library.fs.paths.musicDir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { check, ok: false, detail: `directory missing: ${dir} (mount the library first)` };
  }
  const bad: string[] = [];
  for (const track of store.listMusicTracks({ active: true })) {
    const path = join(library.fs.paths.trackDir(track.track_id), track.file);
    if (!existsSync(path)) { bad.push(`${track.track_id}: file missing: ${path}`); continue; }
    const { checksum } = sha256FileSync(path);
    if (checksum !== track.checksum) bad.push(`${track.track_id}: checksum mismatch: ${path}`);
  }
  return { check, ok: bad.length === 0, detail: bad.length === 0 ? `${dir} ok` : bad.join("; ") };
}

/** `library:brands` (sub-project 5B, studio role only): every channel's brand in the kho must parse and have
 * every font/logo it references present with a matching checksum -- a broken brand of one channel fails this
 * row (naming that channel) so it is caught before that channel's tapes hit `media-compose`, same rationale
 * `checkLibraryVoices`/`checkChannelVoice` document for voices. The channel role gets no row here at all: it
 * only ever has (and only ever needs to check) its own brand, which is `channel:<id>:brand` below. */
function checkLibraryBrands(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const check = "library:brands";
  const ids = library.fs.listBrandChannelIds();
  const bad: string[] = [];
  for (const id of ids) {
    try {
      const loaded = loadBrand(library.fs, id);
      if (!loaded) { bad.push(`${id}: brand.json missing`); continue; }
      const reason = verifyBrandChecksumsSync(loaded);
      if (reason) bad.push(`${id}: ${reason}`);
    } catch (e) {
      bad.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { check, ok: bad.length === 0, detail: bad.length === 0 ? `${ids.length} brand(s) ok` : bad.join("; ") };
}

/** `--version` only, through the injected `isAvailable` -- doctor never invokes the model itself. */
function checkAgentRuntime(agent: NonNullable<DoctorInput["agent"]>): DoctorRow {
  if (agent.kind === "fake") return { check: "agent:runtime", ok: true, detail: "fake" };
  const ok = agent.isAvailable(agent.argv0);
  return { check: "agent:runtime", ok, detail: ok ? `${agent.argv0} available` : `${agent.argv0} not on PATH` };
}

/** `media:python`: `probe.python` is the configured python executable once the probe subprocess actually ran
 * (`PythonMediaEngine.probe()`), `null` when it could not even be spawned/parsed -- `pythonPath` is what
 * doctor names in that failure case, since a `null` probe carries no path of its own to report. */
function checkMediaPython(m: { pythonPath: string; probe: MediaEngineProbe }): DoctorRow {
  const check = "media:python";
  if (m.probe.python === null) return { check, ok: false, detail: `python not runnable: ${m.pythonPath}` };
  return { check, ok: true, detail: `python ${m.probe.python}` };
}

/** `media:packages`: `torch`/`omnivoice`/`whisperx` must all have a resolved version string. */
function checkMediaPackages(m: { probe: MediaEngineProbe }): DoctorRow {
  const check = "media:packages";
  const entries = Object.entries(m.probe.packages);
  const missing = entries.filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length > 0) return { check, ok: false, detail: `missing: ${missing.join(", ")}` };
  return { check, ok: true, detail: entries.map(([k, v]) => `${k} ${v}`).join(", ") };
}

/** `media:device`: `device: "cpu"` needs nothing from the probe at all; `device: "cuda:*"` needs
 * `probe.cuda === true`, and the detail names the GPU + free VRAM the probe found. */
function checkMediaDevice(m: { device: string; probe: MediaEngineProbe }): DoctorRow {
  const check = "media:device";
  if (m.device === "cpu") return { check, ok: true, detail: "cpu" };
  if (!m.probe.cuda) return { check, ok: false, detail: "CUDA not available" };
  const gpu = m.probe.gpu ?? "unknown gpu";
  const vram = m.probe.vram_free_mb !== undefined ? `${m.probe.vram_free_mb} MB free` : "vram unknown";
  return { check, ok: true, detail: `${m.device}: ${gpu}, ${vram}` };
}

/** `media:models`: an uncached model is a warning, not a hard failure -- exactly the same `ok: false` shape
 * `channel:<id>:planning`'s fake-agent row uses, no new severity concept. It never raises the
 * `media_engine_unavailable` dashboard alert (`buildAlerts` excludes this one check by name) and doctor's
 * exit code treats it like every other `ok: false` row, same as today. */
function checkMediaModels(m: { probe: MediaEngineProbe }): DoctorRow {
  const check = "media:models";
  const missing = Object.entries(m.probe.models_cached).filter(([, cached]) => !cached).map(([name]) => name);
  if (missing.length > 0) return { check, ok: false, detail: `will download on first run: ${missing.join(", ")}` };
  return { check, ok: true, detail: "all models cached" };
}

/** Compares two `major.minor.patch` version strings (the shape every `workflow_release`/profile release is
 * already regex-constrained to, e.g. `stageDefinitionSchema`'s siblings) -- `a >= b`. */
function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** `media:engine`: a studio project's effective autopilot release (composition root, `mediaEngineOnFake`)
 * needs the real Python media engine from `library-production@1.2.0` onward -- running it on the fake engine
 * still "works" (spec: fake stands in for CI) but silently produces placeholder transcripts/voice, which is
 * exactly the trap this row exists to catch before a multi-hour GPU-shaped run does that for real. Any other
 * workflow id, or a release older than 1.2.0 (e.g. a deliberate rollback), adds no row at all. */
function checkMediaEngineOnFake(m: { effectiveRelease: string }): DoctorRow[] {
  const at = m.effectiveRelease.lastIndexOf("@");
  if (at < 0) return [];
  const id = m.effectiveRelease.slice(0, at);
  const version = m.effectiveRelease.slice(at + 1);
  if (id !== "library-production" || !versionGte(version, "1.2.0")) return [];
  return [{ check: "media:engine", ok: false, detail: "fake media engine" }];
}

/** `media:render` (sub-project 5B Task 9, spec §6.4): the ffmpeg filters `buildComposition`/`renderComposition`
 * actually depend on (ASS burn-in, dissolve, loudness normalization, music ducking, logo/text overlay) plus
 * the `libx264` CPU encoder every render falls back to. */
const REQUIRED_RENDER_FILTERS = ["ass", "xfade", "loudnorm", "sidechaincompress", "overlay"];
const REQUIRED_RENDER_ENCODER = "libx264";

/** `render.nvenc === false` (or, defensively, `null` -- see `DoctorInput.render`'s own doc) is a warning, not a
 * hard failure, once every required filter/encoder is present: exactly the same `ok: false`-as-warning shape
 * `checkMediaModels` uses for an uncached model -- it never raises a dashboard alert (`buildAlerts` has no
 * `media:render` entry in `MEDIA_ENGINE_CHECKS`), only tells the operator this machine renders on CPU. */
function checkMediaRender(render: { filters: string[]; encoders: string[]; nvenc: boolean | null } | null): DoctorRow {
  const check = "media:render";
  if (render === null) return { check, ok: false, detail: "ffmpeg not runnable" };

  const missing = [
    ...REQUIRED_RENDER_FILTERS.filter((f) => !render.filters.includes(f)),
    ...(render.encoders.includes(REQUIRED_RENDER_ENCODER) ? [] : [REQUIRED_RENDER_ENCODER]),
  ];
  if (missing.length > 0) return { check, ok: false, detail: `missing: ${missing.join(", ")}` };

  if (render.nvenc !== true) return { check, ok: false, detail: "no NVENC, renders on CPU" };
  return { check, ok: true, detail: `${[...REQUIRED_RENDER_FILTERS, REQUIRED_RENDER_ENCODER].join(", ")}, NVENC` };
}

function checkSources(i: DoctorInput): DoctorRow {
  if (i.configErrors?.sources) return { check: "sources", ok: false, detail: i.configErrors.sources };
  const file = resolve(i.projectDir, SOURCES_FILE);
  if (!existsSync(file)) return { check: "sources", ok: true, detail: "source-catalog/sources.yaml not found" };
  try {
    const registry = loadSourcesRegistry(i.projectDir)!;
    const missing = registry.sources.filter((s) => !existsSync(resolve(i.projectDir, s.path))).map((s) => s.path);
    return { check: "sources", ok: missing.length === 0, detail: missing.length === 0 ? `${registry.sources.length} source(s) declared` : `missing files: ${missing.join(", ")}` };
  } catch (e) {
    return { check: "sources", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
