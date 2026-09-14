import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig, ProjectConfig, ScriptsRegistry, SecretResolver } from "@harness/contracts";
import { HARNESS_ROOT, LibraryFs, loadProfile, loadWorkflow, MIGRATIONS_DIR, resolveWorkflowScope, runDoctor, SqliteStateStore, type DoctorInput, type LoadedWorkflow } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const HARNESS_CONFIG: HarnessConfig = {
  schema_version: "harness.config/v1", lease_seconds: 90, heartbeat_seconds: 30, poll_seconds: 2, default_deadline_seconds: 3600,
  default_max_cost_usd: 5, retention: { workspace_days: 7 }, allowed_override_keys: ["lease_seconds", "default_deadline_seconds", "default_max_cost_usd"],
  resource_wait_warn_seconds: 600,
};

function makeProject(resources: Record<string, number>): ProjectConfig {
  return {
    schema_version: "harness.project-config/v1", project_id: "project-doctor", template_release: "0.1.0", runtime: "claude",
    data_root: "./data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Doctor" }], resources, source: { materialize: "link" },
  };
}

class StubSecrets implements SecretResolver {
  constructor(private readonly ok: boolean) {}
  resolve(ref: string): string {
    if (!this.ok) throw new Error(`cannot resolve ${ref}`);
    return "resolved-value";
  }
  resolvedValues(): string[] { return []; }
}

/** Clone `loaded` and drop the `name` of the first output on `stageKey` (exactOptionalPropertyTypes forbids
 * assigning `undefined` to an optional field, so the key is dropped via destructuring instead). */
function withoutFirstOutputName(loaded: LoadedWorkflow, stageKey: string): LoadedWorkflow {
  const definition = structuredClone(loaded.definition);
  const stage = definition.stages.find((s) => s.key === stageKey)!;
  const [first, ...rest] = stage.outputs;
  const { name: _name, ...withoutName } = first!;
  stage.outputs = [withoutName, ...rest];
  return { definition, digest: loaded.digest };
}

function baseInput(projectDir: string, resources: Record<string, number>): Pick<DoctorInput, "projectDir" | "project" | "harness" | "proberAvailable" | "store" | "migrationsDir" | "builtinScripts"> {
  const { store } = openTempStore();
  return { projectDir, project: makeProject(resources), harness: HARNESS_CONFIG, proberAvailable: true, store, migrationsDir: MIGRATIONS_DIR, builtinScripts: [] };
}

describe("runDoctor", () => {
  it("flags a missing script, a broken wrapper, an unresolved secret, a resource shortfall, a bad profile default and an unnamed gate output", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-"));
    const loaded = loadWorkflow(HARNESS_ROOT, "footage-production@1.0.0");
    const brokenLoaded = withoutFirstOutputName(loaded, "select-topic");
    const profile = loadProfile(HARNESS_ROOT, "footage");
    const brokenProfile = { ...profile, options_defaults: { voice: "loud" } };

    // "tts" is deliberately absent; "cut" points at a wrapper file that does not exist.
    const scripts: ScriptsRegistry = {
      schema_version: "harness.scripts/v1",
      scripts: {
        "index-source": { argv: ["node"], cwd: ".", env_refs: {} },
        avatar: { argv: ["node"], cwd: ".", env_refs: { HEYGEN_API_KEY: "secret://heygen/main" } },
        cut: { argv: ["node", "wrappers/cut.mjs"], cwd: ".", env_refs: {} },
        assemble: { argv: ["node"], cwd: ".", env_refs: {} },
        "thumbnail-render": { argv: ["node"], cwd: ".", env_refs: {} },
      },
    };

    const input: DoctorInput = {
      ...baseInput(projectDir, { cpu: 1, heygen: 1 }),
      scripts,
      secrets: new StubSecrets(false),
      workflows: [{ ref: "footage-production@1.0.0", loaded: brokenLoaded }],
      profiles: [brokenProfile],
    };

    const rows = runDoctor(input);
    const byCheck = new Map(rows.map((r) => [r.check, r]));

    expect(byCheck.get("script:footage-production/tts")).toMatchObject({ ok: false });
    expect(byCheck.get("wrapper:cut")).toMatchObject({ ok: false });
    const secretRow = byCheck.get("secret:avatar:HEYGEN_API_KEY");
    expect(secretRow).toMatchObject({ ok: false });
    expect(secretRow?.detail).not.toContain("resolved-value");
    expect(byCheck.get("resource:tts:gpu")).toMatchObject({ ok: false });
    expect(byCheck.get("profile:footage:options_defaults")).toMatchObject({ ok: false });
    expect(byCheck.get("gate-output:select-topic")).toMatchObject({ ok: false });
  });

  it("reports every row ok on a fully consistent project, scripts registry and profile", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-clean-"));
    const loaded = loadWorkflow(HARNESS_ROOT, "footage-production@1.0.0");
    const profile = loadProfile(HARNESS_ROOT, "footage");

    const scripts: ScriptsRegistry = {
      schema_version: "harness.scripts/v1",
      scripts: {
        "index-source": { argv: ["node"], cwd: ".", env_refs: {} },
        tts: { argv: ["node"], cwd: ".", env_refs: {} },
        avatar: { argv: ["node"], cwd: ".", env_refs: { HEYGEN_API_KEY: "secret://heygen/main" } },
        cut: { argv: ["node"], cwd: ".", env_refs: {} },
        assemble: { argv: ["node"], cwd: ".", env_refs: {} },
        "thumbnail-render": { argv: ["node"], cwd: ".", env_refs: {} },
      },
    };

    const input: DoctorInput = {
      ...baseInput(projectDir, { cpu: 2, gpu: 1, heygen: 1 }),
      scripts,
      secrets: new StubSecrets(true),
      workflows: [{ ref: "footage-production@1.0.0", loaded }],
      profiles: [profile],
    };

    const rows = runDoctor(input);
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row, `${row.check}: ${row.detail}`).toMatchObject({ ok: true });
  });

  it("reports a missing migration and an unavailable ffprobe", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-migrations-"));
    const dbDir = mkdtempSync(join(tmpdir(), "doctor-db-"));
    const store = new SqliteStateStore(join(dbDir, "unmigrated.db"));
    const input: DoctorInput = {
      projectDir, project: makeProject({}), harness: HARNESS_CONFIG, proberAvailable: false, store, migrationsDir: MIGRATIONS_DIR,
      scripts: undefined, builtinScripts: [], secrets: new StubSecrets(true), workflows: [], profiles: [],
    };
    const rows = runDoctor(input);
    const byCheck = new Map(rows.map((r) => [r.check, r]));
    expect(byCheck.get("migrations")).toMatchObject({ ok: false });
    expect(byCheck.get("ffprobe")).toMatchObject({ ok: false });
    expect(byCheck.get("scripts")).toMatchObject({ ok: true });
    store.close();
  });

  // the composition root swallows a CONFIG_INVALID from either registry loader so one malformed file does not
  // abort every command; doctor is where the user finds out about it.
  it("reports a swallowed registry parse error as a failing scripts/sources row", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-config-errors-"));
    const rows = runDoctor({
      ...baseInput(projectDir, {}),
      scripts: undefined,
      secrets: new StubSecrets(true),
      workflows: [],
      profiles: [],
      configErrors: { scripts: "executors/scripts.yaml invalid: scripts: Required", sources: "source-catalog/sources.yaml invalid: sources.0.path: Required" },
    });
    const byCheck = new Map(rows.map((r) => [r.check, r]));
    expect(byCheck.get("scripts")).toMatchObject({ ok: false, detail: "executors/scripts.yaml invalid: scripts: Required" });
    expect(byCheck.get("sources")).toMatchObject({ ok: false, detail: "source-catalog/sources.yaml invalid: sources.0.path: Required" });
  });

  it("treats a script missing from the registry but covered by a built-in command as ok, and as a failure without it", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-builtin-"));
    const loaded = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    // "fake-stage" (used by "produce" and "finalize") is deliberately absent from the registry -- this is
    // the real-world shape of a project scripts.yaml that only covers the workflows it actually runs, while
    // `harness doctor` still checks every workflow installed in the harness (see composition.ts, which always
    // merges `fakeScriptCommands()` into the effective "script" executor regardless of scripts.yaml).
    const scripts: ScriptsRegistry = { schema_version: "harness.scripts/v1", scripts: {} };

    const withBuiltin = runDoctor({
      ...baseInput(projectDir, {}),
      scripts,
      builtinScripts: ["fake-stage"],
      secrets: new StubSecrets(true),
      workflows: [{ ref: "sample-three-stage@1.0.0", loaded }],
      profiles: [],
    });
    const byCheckWithBuiltin = new Map(withBuiltin.map((r) => [r.check, r]));
    expect(byCheckWithBuiltin.get("script:sample-three-stage/produce")).toMatchObject({ ok: true });
    expect(byCheckWithBuiltin.get("script:sample-three-stage/finalize")).toMatchObject({ ok: true });
    // a builtin has no argv/env_refs to check, so no wrapper/secret rows are generated for it
    expect(byCheckWithBuiltin.has("wrapper:fake-stage")).toBe(false);

    const withoutBuiltin = runDoctor({
      ...baseInput(projectDir, {}),
      scripts,
      builtinScripts: [],
      secrets: new StubSecrets(true),
      workflows: [{ ref: "sample-three-stage@1.0.0", loaded }],
      profiles: [],
    });
    const byCheckWithoutBuiltin = new Map(withoutBuiltin.map((r) => [r.check, r]));
    expect(byCheckWithoutBuiltin.get("script:sample-three-stage/produce")).toMatchObject({ ok: false });
    expect(byCheckWithoutBuiltin.get("script:sample-three-stage/finalize")).toMatchObject({ ok: false });
  });

  it("adds the three library:* rows only when project.library is configured, failing library:root on a missing kho", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-"));

    const withoutLibrary = runDoctor({ ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [] });
    expect(withoutLibrary.some((r) => r.check.startsWith("library:"))).toBe(false);

    const missingRoot = join(projectDir, "kho-does-not-exist");
    const missing = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root: missingRoot, role: "studio" }), role: "studio" },
    });
    const byCheckMissing = new Map(missing.map((r) => [r.check, r]));
    expect(byCheckMissing.get("library:root")).toMatchObject({ ok: false });
    // doctor must never scaffold kho structure: a missing/unmounted root fails library:write too, and no
    // directory is created on the way to that verdict.
    expect(byCheckMissing.get("library:write")).toMatchObject({ ok: false });
    expect(byCheckMissing.get("library:write")?.detail).toContain("directory missing");
    expect(existsSync(missingRoot)).toBe(false);
    expect(byCheckMissing.get("library:index")).toMatchObject({ ok: true });

    // root exists but this role's subdirectory does not -- still a FAIL, and still no scaffolding
    const rootWithoutSubdir = mkdtempSync(join(tmpdir(), "doctor-library-nosubdir-"));
    const missingSubdir = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root: rootWithoutSubdir, role: "channel" }), role: "channel" },
    });
    const byCheckMissingSubdir = new Map(missingSubdir.map((r) => [r.check, r]));
    expect(byCheckMissingSubdir.get("library:root")).toMatchObject({ ok: true }); // the root itself exists
    expect(byCheckMissingSubdir.get("library:write")).toMatchObject({ ok: false });
    expect(existsSync(join(rootWithoutSubdir, "requests"))).toBe(false);

    const existingRoot = mkdtempSync(join(tmpdir(), "doctor-library-root-"));
    mkdirSync(join(existingRoot, "requests"), { recursive: true }); // channel's one writable subdirectory
    const present = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root: existingRoot, role: "channel" }), role: "channel" },
    });
    const byCheckPresent = new Map(present.map((r) => [r.check, r]));
    expect(byCheckPresent.get("library:root")).toMatchObject({ ok: true });
    expect(byCheckPresent.get("library:write")).toMatchObject({ ok: true });
    expect(byCheckPresent.get("library:index")).toMatchObject({ ok: true });
  });

  // project.yaml.workflows scopes doctor to the workflow releases a machine actually runs: a footage-only
  // (or here, sample-three-stage-only) project's scripts.yaml has no reason to register library-production's
  // or style-study's scripts, and doctor must not manufacture script:library-production/* / script:style-study/*
  // rows for workflows that were never passed in.
  it("scoped to one workflow release, never reports rows for a workflow it was not given", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-scope-"));
    const loaded = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const scripts: ScriptsRegistry = { schema_version: "harness.scripts/v1", scripts: {} }; // no library-* entries at all

    const rows = runDoctor({
      ...baseInput(projectDir, {}),
      scripts,
      builtinScripts: ["fake-stage"],
      secrets: new StubSecrets(true),
      workflows: [{ ref: "sample-three-stage@1.0.0", loaded }],
      profiles: [],
    });
    expect(rows.some((r) => r.check.startsWith("script:library-production/"))).toBe(false);
    expect(rows.some((r) => r.check.startsWith("script:style-study/"))).toBe(false);
    for (const row of rows) expect(row, `${row.check}: ${row.detail}`).toMatchObject({ ok: true });
  });
});

describe("resolveWorkflowScope", () => {
  it("loads every ref in scope and reports which loaded", () => {
    const loaded = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const result = resolveWorkflowScope(["sample-three-stage@1.0.0"], (ref) => {
      expect(ref).toBe("sample-three-stage@1.0.0");
      return loaded;
    });
    expect(result.workflows).toEqual([{ ref: "sample-three-stage@1.0.0", loaded }]);
    expect(result.rows).toEqual([]);
  });

  it("turns a ref that fails to load into a failing workflow:<ref> row instead of throwing", () => {
    const loaded = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const result = resolveWorkflowScope(
      ["sample-three-stage@1.0.0", "does-not-exist@9.9.9"],
      (ref) => {
        if (ref === "sample-three-stage@1.0.0") return loaded;
        throw new Error(`file not found: workflows/${ref.split("@")[0]}/workflow.yaml`);
      },
    );
    expect(result.workflows).toEqual([{ ref: "sample-three-stage@1.0.0", loaded }]);
    expect(result.rows).toEqual([{ check: "workflow:does-not-exist@9.9.9", ok: false, detail: expect.stringContaining("does-not-exist") }]);
  });
});
