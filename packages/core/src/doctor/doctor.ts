import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessConfig, MediaEngineProbe, ProductionProfile, ProjectConfig, ScriptsRegistry, SecretResolver, StageDefinition, StateStore } from "@harness/contracts";
import { sha256FileSync } from "../artifacts/checksum.js";
import { EnvSecretResolver } from "../config/secrets.js";
import type { LoadedChannel } from "../distribution/channels.js";
import type { AutoAcceptConfig } from "../library/auto-accept.js";
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
    autoAccept?: {
      config: AutoAcceptConfig; sourceCount: number; agentIsFake: boolean;
      /** Collection mode only: every kho collection matching at least one of `config.source_collections`'
       * patterns that has at least one non-restricted source, with that source count -- computed by the
       * composition root (`matchCollection`) so `doctor.ts` stays pure. */
      matchingCollections?: { name: string; count: number }[];
      /** Only present when `config.workflow_release` is set: whether the composition root could load that
       * pinned workflow release. */
      pinnedWorkflowLoadable?: boolean;
    };
  };
  /** Only present when the composition root always has channel data available; a per-channel row set is added
   * for every loaded channel (repo dir, upload scripts, upload profile, identity, secret), plus one summary
   * `channels:config` row. `errors` mirrors `configErrors.scripts`/`.sources`: a broken `channels/` directory
   * fails that one row instead of aborting doctor, and no channel is loaded so no per-channel rows follow. */
  channels?: { loaded: LoadedChannel[]; errors: string[]; secrets: SecretResolver };
  /** Only present when the composition root has channels loaded; adds two rows per channel (sub-project 3B
   * Task 6, spec §2.5/§5): `channel:<id>:stats` and, only when that channel's own `planning.enabled` is true,
   * `channel:<id>:planning`. Kept separate from the (possibly `project.yaml`-scoped) `workflows`/`profiles`
   * arrays above -- `loadProfile`/`loadWorkflow` here always resolve against the full harness install,
   * regardless of any `project.yaml` workflows scope, since these two rows must check `channel-planning`/the
   * stats adapter's own readiness independent of that scope. */
  learning?: { harnessRoot: string; statsAdapter: "playwright" | "fake"; agentIsFake: boolean; loadProfile: (id: string) => ProductionProfile; loadWorkflow: (ref: string) => LoadedWorkflow };
  /** Only present when the composition root has picked an agent runtime; checks `--version` only (never the
   * model) through the injected `isAvailable`, so doctor never has to import an adapter. */
  agent?: { kind: "cli" | "fake"; runtime: "claude" | "codex"; argv0: string; isAvailable: (argv0: string) => boolean };
  /** Only present when the composition root has picked a publisher adapter; a single informational row. */
  publisher?: { name: string };
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
    ...(i.library ? [checkLibraryRoot(i.library), checkLibraryWrite(i.library), checkLibraryIndex(i.library), checkLibraryVoices(i.library)] : []),
    ...(i.library?.autoAccept?.config.enabled && i.library.role === "studio" ? [checkLibraryAutoAccept(i.library.autoAccept)] : []),
    ...checkChannels(i),
    ...(i.agent ? [checkAgentRuntime(i.agent)] : []),
    ...(i.publisher ? [checkPublisher(i.publisher)] : []),
    ...(i.media ? [checkMediaPython(i.media), checkMediaPackages(i.media), checkMediaDevice(i.media), checkMediaModels(i.media)] : []),
    ...(i.mediaEngineOnFake ? checkMediaEngineOnFake(i.mediaEngineOnFake) : []),
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

/** `library:auto_accept`, added only for a studio project with the loop actually enabled (the exact
 * condition the worker's `autoAcceptDepsFor` builds the loop on): checks the two things that would make it
 * silently do nothing forever -- no usable source, or an agent runtime that cannot execute the plans it
 * enqueues. A channel project, or a studio with `enabled: false`, gets no row at all rather than a row about
 * a loop that never runs there.
 *
 * Two modes (sub-project 5A Task 9 fix round -- Task 7 shipped `source_collections` but left this row
 * checking only the legacy `source_collection`, so a correctly configured collection-mode project with an
 * empty `main` FAILed doctor for no reason):
 *  - legacy (`config.source_collections` unset): byte-identical to before -- `sourceCount` (one named
 *    collection) is the whole story.
 *  - collections (`config.source_collections` set): ok when `matchingCollections` (every collection matching
 *    at least one pattern with at least one non-restricted source, computed by the composition root via
 *    `matchCollection`) is non-empty; detail lists up to 5 matching collection names + counts. Fail detail
 *    names the patterns that matched nothing.
 * `config.workflow_release`, when set, is named in every non-"unloadable" detail; an unloadable pinned
 * release fails the row outright, before either mode's own source check.
 */
function checkLibraryAutoAccept(a: NonNullable<NonNullable<DoctorInput["library"]>["autoAccept"]>): DoctorRow {
  const check = "library:auto_accept";
  const pinnedSuffix = a.config.workflow_release ? `, pinned to ${a.config.workflow_release}` : "";

  if (a.config.workflow_release && a.pinnedWorkflowLoadable === false) {
    return { check, ok: false, detail: `workflow release ${a.config.workflow_release} not loadable` };
  }

  if (a.config.source_collections && a.config.source_collections.length > 0) {
    const matches = a.matchingCollections ?? [];
    if (matches.length === 0) {
      return { check, ok: false, detail: `no collection matches patterns: ${a.config.source_collections.join(", ")}${pinnedSuffix}` };
    }
    if (a.agentIsFake) return { check, ok: false, detail: "adapters.agent is fake" };
    const shown = matches.slice(0, 5).map((m) => `${m.name} (${m.count})`).join(", ");
    const more = matches.length > 5 ? `, +${matches.length - 5} more` : "";
    return { check, ok: true, detail: `enabled, collections ${shown}${more}${pinnedSuffix}` };
  }

  if (a.sourceCount === 0) return { check, ok: false, detail: `collection ${a.config.source_collection} has no sources` };
  if (a.agentIsFake) return { check, ok: false, detail: "adapters.agent is fake" };
  return { check, ok: true, detail: `enabled, collection ${a.config.source_collection} (${a.sourceCount} sources)${pinnedSuffix}` };
}

const CHANNEL_UPLOAD_SCRIPTS = ["upload-youtube-playwright.mjs", "publish-video-playwright.mjs"];

/** `channels:config` plus, only when `errors` is empty, five rows per loaded channel. A broken `channels/`
 * directory (the composition root swallows the parse error the same way it does for `configErrors.scripts`/
 * `.sources`) fails just the one summary row -- there is nothing loaded to check per-channel. No channels
 * declared at all (the common case for a footage/avatar-only project) adds no row, same as `library:*`. */
function checkChannels(i: DoctorInput): DoctorRow[] {
  if (!i.channels) return [];
  if (i.channels.errors.length > 0) return [{ check: "channels:config", ok: false, detail: i.channels.errors.join("; ") }];
  if (i.channels.loaded.length === 0) return [];
  const rows: DoctorRow[] = [{ check: "channels:config", ok: true, detail: `${i.channels.loaded.length} channels` }];
  for (const channel of i.channels.loaded) {
    rows.push(...checkOneChannel(channel, i.channels.secrets));
    if (channel.config.voice) rows.push(checkChannelVoice(i.store, i.library, channel));
    if (i.learning) {
      rows.push(checkChannelStats(i.learning, channel));
      if (channel.config.planning.enabled) rows.push(checkChannelPlanning(i.learning, channel));
    }
  }
  return rows;
}

/** `channel:<id>:voice` (sub-project 5A), added only when this channel's `channel.yaml` declares `voice`
 * (a `voice_id` it wants every `voice: tts` request of its own to use, spec §1.5). Checks the same store
 * mirror `requireActiveVoice` reads at request/intake time -- so this row fails exactly when `library request
 * create --voice tts` or the channel-planning auto-loop would fail too, ahead of time -- plus one thing the
 * mirror alone cannot see: whether the kho's `ref.wav` bytes still match `voice.json`'s recorded checksum. */
function checkChannelVoice(store: StateStore, library: DoctorInput["library"], channel: LoadedChannel): DoctorRow {
  const id = channel.config.channel_id;
  const check = `channel:${id}:voice`;
  const voiceId = channel.config.voice!.voice_id;

  // Checked first (fix round 1): a channels-only project with no `library` block at all should say so
  // plainly, not report "run library sync" for a library it has no way to sync in the first place.
  if (!library) return { check, ok: false, detail: "project.yaml has no library configured; cannot verify ref.wav" };

  const profile = store.getVoiceProfile(voiceId);
  if (!profile) return { check, ok: false, detail: `voice profile not mirrored: ${voiceId}; run library sync` };
  if (profile.status !== "active") return { check, ok: false, detail: `voice profile ${voiceId} is ${profile.status}, not active` };

  const refPath = library.fs.paths.voiceRef(voiceId);
  if (!existsSync(refPath)) return { check, ok: false, detail: `ref.wav missing: ${refPath}` };
  const { checksum } = sha256FileSync(refPath);
  if (checksum !== profile.ref_audio.checksum) {
    return { check, ok: false, detail: `ref.wav checksum mismatch: ${refPath} (voice.json expects ${profile.ref_audio.checksum})` };
  }
  return { check, ok: true, detail: `${voiceId} rev${profile.revision} active, ref.wav checksum matches` };
}

/** `channel:<id>:stats` (sub-project 3B, spec §2.5): with `adapters.stats: fake` there is nothing real to
 * check, so it is always `ok`; with `playwright` it needs both the harness-owned collector script (not
 * per-channel -- one script serves every channel) and this channel's own logged-in Chrome profile, the same
 * `.upload-profile/Default` path `channel:<id>:profile` already checks (the two rows answer different
 * questions -- "did you ever log in" vs "is stats collection actually ready" -- so the overlap is intentional,
 * not redundant). */
function checkChannelStats(learning: NonNullable<DoctorInput["learning"]>, channel: LoadedChannel): DoctorRow {
  const id = channel.config.channel_id;
  const check = `channel:${id}:stats`;
  if (learning.statsAdapter === "fake") return { check, ok: true, detail: "fake" };
  const script = join(learning.harnessRoot, "packages", "adapters", "youtube-playwright", "scripts", "collect-stats.mjs");
  const scriptOk = existsSync(script);
  const profilePath = join(resolve(channel.config.repo_dir), ".upload-profile", "Default");
  const profileOk = existsSync(profilePath);
  if (scriptOk && profileOk) return { check, ok: true, detail: `${script} + ${profilePath} present` };
  const missing = [...(scriptOk ? [] : [script]), ...(profileOk ? [] : [profilePath])];
  return { check, ok: false, detail: `missing: ${missing.join(", ")}` };
}

/** `channel:<id>:planning`, only added for a channel whose own `planning.enabled` is true (spec §2.5/§5):
 * the `channel-planning` profile and its workflow release must both load, and the agent runtime must not be
 * `fake` (a fake agent would enqueue `channel-planning` runs that can never actually propose a real topic). */
function checkChannelPlanning(learning: NonNullable<DoctorInput["learning"]>, channel: LoadedChannel): DoctorRow {
  const id = channel.config.channel_id;
  const check = `channel:${id}:planning`;
  let profile: ProductionProfile;
  try {
    profile = learning.loadProfile("channel-planning");
  } catch (e) {
    return { check, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    learning.loadWorkflow(profile.workflow_release);
  } catch (e) {
    return { check, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (learning.agentIsFake) return { check, ok: false, detail: "adapters.agent is fake" };
  return { check, ok: true, detail: `${profile.workflow_release} ready` };
}

function checkOneChannel(channel: LoadedChannel, secrets: SecretResolver): DoctorRow[] {
  const id = channel.config.channel_id;
  const repoDir = resolve(channel.config.repo_dir);

  const repoOk = existsSync(repoDir) && statSync(repoDir).isDirectory();
  const repoRow: DoctorRow = { check: `channel:${id}:repo`, ok: repoOk, detail: repoOk ? `${repoDir} exists` : `${repoDir} not found or not a directory` };

  const missingScripts = CHANNEL_UPLOAD_SCRIPTS.filter((f) => !existsSync(join(repoDir, "scripts", f)));
  const scriptsRow: DoctorRow = { check: `channel:${id}:scripts`, ok: missingScripts.length === 0, detail: missingScripts.length === 0 ? `${CHANNEL_UPLOAD_SCRIPTS.join(" + ")} present` : `missing: ${missingScripts.join(", ")}` };

  const profilePath = join(repoDir, ".upload-profile", "Default");
  const profileOk = existsSync(profilePath);
  const profileRow: DoctorRow = { check: `channel:${id}:profile`, ok: profileOk, detail: profileOk ? `${profilePath} exists` : `chưa đăng nhập: harness channel login ${id}` };

  const identityRow = checkChannelIdentity(channel, repoDir, secrets);

  let secretsOk = true;
  let secretsDetail = `${channel.config.youtube.account_email_ref} resolves`;
  try { secrets.resolve(channel.config.youtube.account_email_ref); }
  catch (e) { secretsOk = false; secretsDetail = e instanceof Error ? e.message : String(e); }
  const secretsRow: DoctorRow = { check: `channel:${id}:secrets`, ok: secretsOk, detail: secretsDetail };

  return [repoRow, scriptsRow, profileRow, identityRow, secretsRow];
}

/** Compares the legacy repo's `channel.config.json` against `channel.yaml`: `youtube.channelId` must match
 * `youtube.expected_channel_id`, `projectId` must match `legacy_project_id`, `youtube.accountEmail` must match
 * the secret `account_email_ref` resolves to. The email comparison is skipped (not failed) when the secret
 * itself does not resolve -- `channel:<id>:secrets` already reports that root cause on its own row. */
function checkChannelIdentity(channel: LoadedChannel, repoDir: string, secrets: SecretResolver): DoctorRow {
  const id = channel.config.channel_id;
  const check = `channel:${id}:identity`;
  const path = join(repoDir, "channel.config.json");
  if (!existsSync(path)) return { check, ok: false, detail: `${path} not found` };

  let raw: { projectId?: string; youtube?: { channelId?: string; accountEmail?: string } };
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { return { check, ok: false, detail: e instanceof Error ? e.message : String(e) }; }

  const problems: string[] = [];
  if (raw.youtube?.channelId !== channel.config.youtube.expected_channel_id) {
    problems.push(`youtube.channelId "${raw.youtube?.channelId ?? ""}" != expected_channel_id "${channel.config.youtube.expected_channel_id}"`);
  }
  if (raw.projectId !== channel.config.legacy_project_id) {
    problems.push(`projectId "${raw.projectId ?? ""}" != legacy_project_id "${channel.config.legacy_project_id}"`);
  }
  try {
    const expectedEmail = secrets.resolve(channel.config.youtube.account_email_ref);
    if (raw.youtube?.accountEmail !== expectedEmail) problems.push(`youtube.accountEmail "${raw.youtube?.accountEmail ?? ""}" != resolved ${channel.config.youtube.account_email_ref}`);
  } catch { /* unresolved secret is channel:<id>:secrets's failure to report, not this row's */ }
  return { check, ok: problems.length === 0, detail: problems.length === 0 ? `${path} matches channel.yaml` : problems.join("; ") };
}

/** `--version` only, through the injected `isAvailable` -- doctor never invokes the model itself. */
function checkAgentRuntime(agent: NonNullable<DoctorInput["agent"]>): DoctorRow {
  if (agent.kind === "fake") return { check: "agent:runtime", ok: true, detail: "fake" };
  const ok = agent.isAvailable(agent.argv0);
  return { check: "agent:runtime", ok, detail: ok ? `${agent.argv0} available` : `${agent.argv0} not on PATH` };
}

function checkPublisher(publisher: NonNullable<DoctorInput["publisher"]>): DoctorRow {
  return { check: "publisher", ok: true, detail: publisher.name };
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
