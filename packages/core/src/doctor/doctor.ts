import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HarnessConfig, ProductionProfile, ProjectConfig, ScriptsRegistry, SecretResolver, StageDefinition, StateStore } from "@harness/contracts";
import { EnvSecretResolver } from "../config/secrets.js";
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
  /** Only present when `project.yaml` declares `library`; adds the three `library:*` rows below. */
  library?: { fs: LibraryFs; role: LibraryRole };
}

const SCRIPT_FILE_RE = /\.(mjs|js|cjs|ts|py|sh)$/;

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
 * not a real style/request and should not have to satisfy `EditStyleSchema`/`ContentRequestSchema`. */
function checkLibraryWrite(library: { fs: LibraryFs; role: LibraryRole }): DoctorRow {
  const name = `.doctor-${library.role}-${randomUUID()}`;
  const path = library.role === "studio" ? resolve(library.fs.paths.styles, name) : resolve(library.fs.paths.requests, `${name}.json`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    rmSync(path);
    return { check: "library:write", ok: true, detail: `wrote and removed ${path}` };
  } catch (e) {
    return { check: "library:write", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
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
