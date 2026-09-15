import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessConfig, ProductionProfile, ProjectConfig, ScriptsRegistry, SecretResolver, StageDefinition, StateStore } from "@harness/contracts";
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
   * `autoAccept`, when present, adds `library:auto_accept` too -- pre-computed by the composition root
   * (`sourceCount`/`agentIsFake`) rather than derived here, same as `proberAvailable`/`configErrors` above. */
  library?: { fs: LibraryFs; role: LibraryRole; autoAccept?: { config: AutoAcceptConfig; sourceCount: number; agentIsFake: boolean } };
  /** Only present when the composition root always has channel data available; a per-channel row set is added
   * for every loaded channel (repo dir, upload scripts, upload profile, identity, secret), plus one summary
   * `channels:config` row. `errors` mirrors `configErrors.scripts`/`.sources`: a broken `channels/` directory
   * fails that one row instead of aborting doctor, and no channel is loaded so no per-channel rows follow. */
  channels?: { loaded: LoadedChannel[]; errors: string[]; secrets: SecretResolver };
  /** Only present when the composition root has picked an agent runtime; checks `--version` only (never the
   * model) through the injected `isAvailable`, so doctor never has to import an adapter. */
  agent?: { kind: "cli" | "fake"; runtime: "claude" | "codex"; argv0: string; isAvailable: (argv0: string) => boolean };
  /** Only present when the composition root has picked a publisher adapter; a single informational row. */
  publisher?: { name: string };
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
    ...(i.library ? [checkLibraryRoot(i.library), checkLibraryWrite(i.library), checkLibraryIndex(i.library)] : []),
    ...(i.library?.autoAccept ? [checkLibraryAutoAccept(i.library.autoAccept)] : []),
    ...checkChannels(i),
    ...(i.agent ? [checkAgentRuntime(i.agent)] : []),
    ...(i.publisher ? [checkPublisher(i.publisher)] : []),
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

/** `library:auto_accept`: disabled is a plain informational OK (nothing to run); enabled checks the two
 * things that would make the loop silently do nothing forever -- an empty source collection, or an agent
 * runtime that cannot actually execute the plans it enqueues. */
function checkLibraryAutoAccept(a: { config: AutoAcceptConfig; sourceCount: number; agentIsFake: boolean }): DoctorRow {
  const check = "library:auto_accept";
  if (!a.config.enabled) return { check, ok: true, detail: "disabled" };
  if (a.sourceCount === 0) return { check, ok: false, detail: `collection ${a.config.source_collection} has no sources` };
  if (a.agentIsFake) return { check, ok: false, detail: "adapters.agent is fake" };
  return { check, ok: true, detail: `enabled, collection ${a.config.source_collection} (${a.sourceCount} sources)` };
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
  for (const channel of i.channels.loaded) rows.push(...checkOneChannel(channel, i.channels.secrets));
  return rows;
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
