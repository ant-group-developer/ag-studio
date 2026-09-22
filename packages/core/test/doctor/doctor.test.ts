import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelConfigSchema, newId, type BrandProfile, type HarnessConfig, type MediaEngineProbe, type MusicTrack, type ProjectConfig, type ScriptsRegistry, type SecretResolver, type VoiceProfile } from "@harness/contracts";
import { HARNESS_ROOT, LibraryFs, loadProfile, loadWorkflow, MIGRATIONS_DIR, resolveWorkflowScope, runDoctor, sha256FileSync, SqliteStateStore, type DoctorInput, type LoadedChannel, type LoadedWorkflow } from "../../src/index.js";
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

/** Resolves any ref to the fixed value the `legacy-channel-repo` fixture's `channel.config.json` carries, so
 * `channel:<id>:identity`'s email comparison passes without wiring a real secret store. */
class FixedSecrets implements SecretResolver {
  constructor(private readonly value: string) {}
  resolve(): string { return this.value; }
  resolvedValues(): string[] { return []; }
}

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");

/** Fresh temp copy of `fixtures/legacy-channel-repo` (channel.config.json: channelId `UCfake000000000000000001`,
 * accountEmail `owner@example.com`, projectId `project-01`; `.upload-profile/Default/.keep` present) so a test
 * can delete `.upload-profile/Default` without mutating the committed fixture. */
function setupChannelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-channel-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

function makeLoadedChannel(repoDir: string, overrides: Record<string, unknown> = {}): LoadedChannel {
  const config = ChannelConfigSchema.parse({
    schema_version: "harness.channel-config/v1",
    channel_id: "c1",
    display_name: "Channel One",
    portfolio_id: "portfolio-main",
    repo_dir: repoDir.split("\\").join("/"),
    legacy_project_id: "project-01",
    youtube: { expected_channel_id: "UCfake000000000000000001", account_email_ref: "secret://youtube-c1/email" },
    publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"], max_daily_uploads: 1, min_gap_hours: 1 },
    ...overrides,
  });
  return { config, dir: join(repoDir, "channels", "c1"), config_revision: "sha256:" + "0".repeat(64) };
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

  it("adds library:auto_accept only for a studio project with the loop enabled, then checks sources/agent", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-auto-accept-"));
    const libRoot = mkdtempSync(join(tmpdir(), "doctor-auto-accept-kho-"));
    mkdirSync(join(libRoot, "styles"), { recursive: true });
    const fs = new LibraryFs({ root: libRoot, role: "studio" });
    const config = { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1 };

    const withoutAutoAccept = runDoctor({ ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [], library: { fs, role: "studio" } });
    expect(withoutAutoAccept.some((r) => r.check === "library:auto_accept")).toBe(false);

    // final-review bundled minor (h): a loop that never runs here gets no row at all -- neither when it is
    // switched off, nor on a channel project (where `autoAcceptDepsFor` never builds the loop either)
    const disabled = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "studio", autoAccept: { config: { ...config, enabled: false }, sourceCount: 0, agentIsFake: true } },
    });
    expect(disabled.some((r) => r.check === "library:auto_accept")).toBe(false);

    const channelRole = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "channel", autoAccept: { config, sourceCount: 0, agentIsFake: true } },
    });
    expect(channelRole.some((r) => r.check === "library:auto_accept")).toBe(false);

    const noSources = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "studio", autoAccept: { config, sourceCount: 0, agentIsFake: false } },
    });
    expect(noSources.find((r) => r.check === "library:auto_accept")).toMatchObject({ ok: false, detail: "collection main has no sources" });

    const fakeAgent = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "studio", autoAccept: { config, sourceCount: 3, agentIsFake: true } },
    });
    expect(fakeAgent.find((r) => r.check === "library:auto_accept")).toMatchObject({ ok: false, detail: "adapters.agent is fake" });

    const ok = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "studio", autoAccept: { config, sourceCount: 3, agentIsFake: false } },
    });
    expect(ok.find((r) => r.check === "library:auto_accept")).toMatchObject({ ok: true, detail: "enabled, collection main (3 sources)" });
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

    // the channel probe must not look like a request to `listRequestIds`: a dot-name, and never `.json`
    const writeDetail = byCheckPresent.get("library:write")!.detail;
    expect(writeDetail).toMatch(/[\\/]\.doctor-channel-[0-9a-f-]+\.tmp\b/);
    expect(writeDetail).not.toMatch(/\.json\b/);
    // and it really is gone, so no listing sees it either way
    expect(new LibraryFs({ root: existingRoot, role: "channel" }).listRequestIds()).toEqual([]);
    expect(readdirSync(join(existingRoot, "requests"))).toEqual([]);
  });

  it("library:voices: FAIL when voices/ is missing; OK on directory presence alone for studio; OK+write-probe for channel", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-voices-"));
    const root = mkdtempSync(join(tmpdir(), "doctor-library-voices-root-"));

    const missing = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root, role: "studio" }), role: "studio" },
    });
    expect(new Map(missing.map((r) => [r.check, r])).get("library:voices")).toMatchObject({ ok: false });
    expect(existsSync(join(root, "voices"))).toBe(false); // doctor never scaffolds it

    mkdirSync(join(root, "voices"), { recursive: true });
    const studioOk = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root, role: "studio" }), role: "studio" },
    });
    expect(new Map(studioOk.map((r) => [r.check, r])).get("library:voices")).toMatchObject({ ok: true });

    const channelOk = runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs: new LibraryFs({ root, role: "channel" }), role: "channel" },
    });
    const channelRow = new Map(channelOk.map((r) => [r.check, r])).get("library:voices");
    expect(channelRow).toMatchObject({ ok: true });
    expect(channelRow?.detail).toMatch(/[\\/]\.doctor-channel-[0-9a-f-]+\.tmp\b/);
    expect(readdirSync(join(root, "voices"))).toEqual([]); // probe file removed itself
  });

  describe("library:music row (sub-project 5B)", () => {
    function makeTrack(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
      return {
        schema_version: "harness.music-track/v1", track_id: id, display_name: "Calm piano 01", file: "track.wav",
        mood: ["calm"], duration_seconds: 184.2, loop_ok: true, origin: "royalty_free", origin_note: "n/a",
        checksum: `sha256:${"a".repeat(64)}`, active: true, created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
        ...overrides,
      };
    }

    it("FAIL when music/ is missing", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-music-"));
      const root = mkdtempSync(join(tmpdir(), "doctor-library-music-root-"));
      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        library: { fs: new LibraryFs({ root, role: "channel" }), role: "channel" },
      });
      expect(new Map(rows.map((r) => [r.check, r])).get("library:music")).toMatchObject({ ok: false });
      expect(existsSync(join(root, "music"))).toBe(false); // doctor never scaffolds it
    });

    it("ok when music/ exists with no active tracks; fails naming a track whose file is missing or whose checksum does not match", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-music-checks-"));
      const root = mkdtempSync(join(tmpdir(), "doctor-library-music-checks-root-"));
      const fs = new LibraryFs({ root, role: "channel" });
      mkdirSync(fs.paths.musicDir, { recursive: true });
      const base = baseInput(projectDir, {});
      const runFor = () => runDoctor({
        ...base, scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        library: { fs, role: "channel" },
      });
      const rowOf = (rows: ReturnType<typeof runDoctor>) => new Map(rows.map((r) => [r.check, r])).get("library:music");

      expect(rowOf(runFor())).toMatchObject({ ok: true });

      // active track mirrored, but its file is not in the kho
      base.store.upsertMusicTrack(makeTrack("calm-01"));
      expect(rowOf(runFor())).toMatchObject({ ok: false });

      // file present but checksum does not match track.json's recorded one
      mkdirSync(fs.paths.trackDir("calm-01"), { recursive: true });
      writeFileSync(join(fs.paths.trackDir("calm-01"), "track.wav"), "some bytes");
      expect(rowOf(runFor())).toMatchObject({ ok: false });

      // checksum matches: ok
      const { checksum } = sha256FileSync(join(fs.paths.trackDir("calm-01"), "track.wav"));
      base.store.upsertMusicTrack(makeTrack("calm-01", { checksum }));
      expect(rowOf(runFor())).toMatchObject({ ok: true });

      // a retired track's file is never checked
      base.store.upsertMusicTrack(makeTrack("retired-01", { active: false, checksum: `sha256:${"f".repeat(64)}` }));
      expect(rowOf(runFor())).toMatchObject({ ok: true });
    });
  });

  describe("library:brands row (sub-project 5B, studio role only)", () => {
    function makeBrand(channelId: string, overrides: Partial<BrandProfile> = {}): BrandProfile {
      return {
        schema_version: "harness.brand/v1", channel_id: channelId, revision: 1,
        fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "n/a" },
        colors: { primary: "#F2C94C", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
        safe_margin_px: 120,
        text: {
          title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
          callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
          lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
        },
        subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
        transition: { kind: "cut", seconds: 0.4 },
        source_fit: "scale_pad",
        music: { tracks: [], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
        checksums: {},
        created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
        ...overrides,
      };
    }

    // Writes with plain node:fs (not `fs.writeJsonAtomic`), since the fixture must land in the kho regardless
    // of the studio-role `fs` under test here -- a real brand would have been written by the channel role's
    // own `setBrand`, which studio doctor then only ever reads.
    function writeBrandWithFonts(fs: LibraryFs, channelId: string): BrandProfile {
      mkdirSync(fs.paths.brandFontsDir(channelId), { recursive: true });
      writeFileSync(join(fs.paths.brandFontsDir(channelId), "Regular.ttf"), "regular bytes");
      writeFileSync(join(fs.paths.brandFontsDir(channelId), "Bold.ttf"), "bold bytes");
      const { checksum: regular } = sha256FileSync(join(fs.paths.brandFontsDir(channelId), "Regular.ttf"));
      const { checksum: bold } = sha256FileSync(join(fs.paths.brandFontsDir(channelId), "Bold.ttf"));
      const brand = makeBrand(channelId, { checksums: { "fonts.regular": regular, "fonts.bold": bold } });
      writeFileSync(fs.paths.brandFile(channelId), JSON.stringify(brand, null, 2));
      return brand;
    }

    it("ok with no channels in brands/; fails naming a channel whose font checksum does not match", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-brands-"));
      const root = mkdtempSync(join(tmpdir(), "doctor-library-brands-root-"));
      const fs = new LibraryFs({ root, role: "studio" });
      const runFor = () => runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        library: { fs, role: "studio" },
      });
      const rowOf = (rows: ReturnType<typeof runDoctor>) => new Map(rows.map((r) => [r.check, r])).get("library:brands");

      expect(rowOf(runFor())).toMatchObject({ ok: true });

      writeBrandWithFonts(fs, "ch1");
      expect(rowOf(runFor())).toMatchObject({ ok: true });

      writeFileSync(join(fs.paths.brandFontsDir("ch1"), "Regular.ttf"), "tampered bytes");
      const row = rowOf(runFor());
      expect(row).toMatchObject({ ok: false });
      expect(row?.detail).toContain("ch1");
    });

    it("adds no library:brands row for the channel role", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-library-brands-channel-role-"));
      const root = mkdtempSync(join(tmpdir(), "doctor-library-brands-channel-role-root-"));
      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        library: { fs: new LibraryFs({ root, role: "channel" }), role: "channel" },
      });
      expect(rows.some((r) => r.check === "library:brands")).toBe(false);
    });
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

  describe("channels / agent / publisher rows (sub-project 3, Task 9)", () => {
    it("passes all 5 per-channel checks when the repo, scripts, profile, identity and secret all line up", () => {
      const repoDir = setupChannelRepo();
      const channel = makeLoadedChannel(repoDir);
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-channels-ok-"));

      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
      });
      const byCheck = new Map(rows.map((r) => [r.check, r]));

      expect(byCheck.get("channels:config")).toMatchObject({ ok: true, detail: "1 channels" });
      for (const suffix of ["repo", "scripts", "profile", "identity", "secrets"]) {
        expect(byCheck.get(`channel:c1:${suffix}`), JSON.stringify(byCheck.get(`channel:c1:${suffix}`))).toMatchObject({ ok: true });
      }
    });

    it("fails channel:<id>:profile (and only that row) once .upload-profile/Default is removed", () => {
      const repoDir = setupChannelRepo();
      rmSync(join(repoDir, ".upload-profile", "Default"), { recursive: true, force: true });
      const channel = makeLoadedChannel(repoDir);
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-channels-noprofile-"));

      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
      });
      const byCheck = new Map(rows.map((r) => [r.check, r]));

      expect(byCheck.get("channel:c1:profile")).toMatchObject({ ok: false });
      expect(byCheck.get("channel:c1:profile")?.detail).toContain("harness channel login c1");
      for (const suffix of ["repo", "scripts", "identity", "secrets"]) {
        expect(byCheck.get(`channel:c1:${suffix}`), JSON.stringify(byCheck.get(`channel:c1:${suffix}`))).toMatchObject({ ok: true });
      }
    });

    it("channels:config fails on a swallowed loadChannels error, with no per-channel rows and no channels", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-channels-broken-"));
      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [], errors: ["channels/bad/channel.yaml invalid: channel_id: Required"], secrets: new StubSecrets(true) },
      });
      expect(new Map(rows.map((r) => [r.check, r])).get("channels:config")).toMatchObject({ ok: false, detail: "channels/bad/channel.yaml invalid: channel_id: Required" });
      expect(rows.some((r) => r.check.startsWith("channel:"))).toBe(false);
    });

    it("adds no channels:config row (and no per-channel rows) when no channels are declared", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-channels-none-"));
      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [], errors: [], secrets: new StubSecrets(true) },
      });
      expect(rows.some((r) => r.check.startsWith("channel"))).toBe(false);
    });

    it("adds no channels rows at all when DoctorInput.channels is not passed", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-channels-absent-"));
      const rows = runDoctor({ ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [] });
      expect(rows.some((r) => r.check.startsWith("channel"))).toBe(false);
    });

    it("agent:runtime: fake is always ok regardless of isAvailable; cli asks the injected isAvailable with argv0", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-agent-"));
      const base = { ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [] } as const;

      const fake = runDoctor({ ...base, agent: { kind: "fake", runtime: "claude", argv0: "claude", isAvailable: () => false } });
      expect(new Map(fake.map((r) => [r.check, r])).get("agent:runtime")).toMatchObject({ ok: true, detail: "fake" });

      let askedArgv0: string | undefined;
      const cliMissing = runDoctor({ ...base, agent: { kind: "cli", runtime: "claude", argv0: "missing-bin", isAvailable: (argv0) => { askedArgv0 = argv0; return false; } } });
      const missingRow = new Map(cliMissing.map((r) => [r.check, r])).get("agent:runtime");
      expect(missingRow).toMatchObject({ ok: false });
      expect(missingRow?.detail).toContain("missing-bin");
      expect(askedArgv0).toBe("missing-bin"); // doctor never invokes the model, only --version through isAvailable

      const cliOk = runDoctor({ ...base, agent: { kind: "cli", runtime: "claude", argv0: "claude", isAvailable: () => true } });
      expect(new Map(cliOk.map((r) => [r.check, r])).get("agent:runtime")).toMatchObject({ ok: true });
    });

    it("publisher: a single informational row naming the adapter", () => {
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-publisher-"));
      const rows = runDoctor({ ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [], publisher: { name: "playwright" } });
      expect(new Map(rows.map((r) => [r.check, r])).get("publisher")).toMatchObject({ ok: true, detail: "playwright" });
    });

    describe("channel:<id>:voice row (sub-project 5A)", () => {
      function makeVoiceProfile(id: string, overrides: Partial<VoiceProfile> = {}): VoiceProfile {
        return {
          schema_version: "harness.voice/v1", voice_id: id, display_name: "Narrator", language: "vi",
          origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: `sha256:${"a".repeat(64)}`, duration_seconds: 5 },
          ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "active",
          created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
          ...overrides,
        };
      }

      it("adds no row for a channel with no voice configured", () => {
        const repoDir = setupChannelRepo();
        const channel = makeLoadedChannel(repoDir);
        const projectDir = mkdtempSync(join(tmpdir(), "doctor-channel-voice-none-"));
        const rows = runDoctor({
          ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
          channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
        });
        expect(rows.some((r) => r.check === "channel:c1:voice")).toBe(false);
      });

      it("ok when the voice profile is mirrored active and ref.wav's checksum matches; fails when not mirrored, retired, ref.wav missing, or checksum mismatched", () => {
        const repoDir = setupChannelRepo();
        const projectDir = mkdtempSync(join(tmpdir(), "doctor-channel-voice-"));
        const root = mkdtempSync(join(tmpdir(), "doctor-channel-voice-kho-"));
        const fs = new LibraryFs({ root, role: "channel" });
        const voiceId = newId("voice_profile");
        const channel = makeLoadedChannel(repoDir, { voice: { voice_id: voiceId } });

        const base = baseInput(projectDir, {});
        const runFor = (library: DoctorInput["library"]) => runDoctor({
          ...base, scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
          channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
          ...(library ? { library } : {}),
        });
        const rowOf = (rows: ReturnType<typeof runDoctor>) => new Map(rows.map((r) => [r.check, r])).get("channel:c1:voice");

        // not mirrored at all yet
        expect(rowOf(runFor({ fs, role: "channel" }))).toMatchObject({ ok: false });

        // mirrored but retired
        base.store.upsertVoiceProfile(makeVoiceProfile(voiceId, { status: "retired" }));
        expect(rowOf(runFor({ fs, role: "channel" }))).toMatchObject({ ok: false });

        // mirrored and active, but ref.wav is not in the kho
        mkdirSync(fs.paths.voiceDir(voiceId), { recursive: true });
        base.store.upsertVoiceProfile(makeVoiceProfile(voiceId, { status: "active" }));
        expect(rowOf(runFor({ fs, role: "channel" }))).toMatchObject({ ok: false });

        // ref.wav present but its checksum does not match voice.json's recorded one
        writeFileSync(fs.paths.voiceRef(voiceId), "some bytes");
        expect(rowOf(runFor({ fs, role: "channel" }))).toMatchObject({ ok: false });

        // ref.wav present and checksum matches: ok
        const { checksum } = sha256FileSync(fs.paths.voiceRef(voiceId));
        base.store.upsertVoiceProfile(makeVoiceProfile(voiceId, { status: "active", ref_audio: { path: "ref.wav", checksum, duration_seconds: 5 } }));
        expect(rowOf(runFor({ fs, role: "channel" }))).toMatchObject({ ok: true });
      });
    });

    describe("channel:<id>:brand row (sub-project 5B)", () => {
      function makeBrand(channelId: string, overrides: Partial<BrandProfile> = {}): BrandProfile {
        return {
          schema_version: "harness.brand/v1", channel_id: channelId, revision: 1,
          fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "n/a" },
          colors: { primary: "#F2C94C", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
          safe_margin_px: 120,
          text: {
            title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
            callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
            lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
          },
          subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
          transition: { kind: "cut", seconds: 0.4 },
          source_fit: "scale_pad",
          music: { tracks: [], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
          checksums: {},
          created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
          ...overrides,
        };
      }

      it("adds no row for a channel with no brands/<id>/ directory in the kho", () => {
        const repoDir = setupChannelRepo();
        const channel = makeLoadedChannel(repoDir);
        const projectDir = mkdtempSync(join(tmpdir(), "doctor-channel-brand-none-"));
        const root = mkdtempSync(join(tmpdir(), "doctor-channel-brand-none-kho-"));
        const rows = runDoctor({
          ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
          channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
          library: { fs: new LibraryFs({ root, role: "channel" }), role: "channel" },
        });
        expect(rows.some((r) => r.check === "channel:c1:brand")).toBe(false);
      });

      it("ok when the brand parses and every font checksum matches; fails naming the missing/mismatched file otherwise", () => {
        const repoDir = setupChannelRepo();
        const channel = makeLoadedChannel(repoDir);
        const projectDir = mkdtempSync(join(tmpdir(), "doctor-channel-brand-"));
        const root = mkdtempSync(join(tmpdir(), "doctor-channel-brand-kho-"));
        const fs = new LibraryFs({ root, role: "channel" });
        const rowOf = (rows: ReturnType<typeof runDoctor>) => new Map(rows.map((r) => [r.check, r])).get("channel:c1:brand");
        const runFor = () => runDoctor({
          ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
          channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
          library: { fs, role: "channel" },
        });

        // brand.json present but fonts missing entirely
        fs.writeJsonAtomic(fs.paths.brandFile("c1"), makeBrand("c1"));
        expect(rowOf(runFor())).toMatchObject({ ok: false });

        // fonts present, checksums recorded correctly
        mkdirSync(fs.paths.brandFontsDir("c1"), { recursive: true });
        writeFileSync(join(fs.paths.brandFontsDir("c1"), "Regular.ttf"), "regular bytes");
        writeFileSync(join(fs.paths.brandFontsDir("c1"), "Bold.ttf"), "bold bytes");
        const { checksum: regular } = sha256FileSync(join(fs.paths.brandFontsDir("c1"), "Regular.ttf"));
        const { checksum: bold } = sha256FileSync(join(fs.paths.brandFontsDir("c1"), "Bold.ttf"));
        fs.writeJsonAtomic(fs.paths.brandFile("c1"), makeBrand("c1", { checksums: { "fonts.regular": regular, "fonts.bold": bold } }));
        expect(rowOf(runFor())).toMatchObject({ ok: true });

        // tamper with a font after the fact
        writeFileSync(join(fs.paths.brandFontsDir("c1"), "Regular.ttf"), "tampered bytes");
        expect(rowOf(runFor())).toMatchObject({ ok: false });
      });
    });
  });

  describe("channel:<id>:stats / channel:<id>:planning rows (sub-project 3B, Task 6)", () => {
    it("channel:<id>:stats is ok \"fake\" with adapters.stats fake, regardless of the repo's own state", () => {
      const repoDir = setupChannelRepo();
      rmSync(join(repoDir, ".upload-profile", "Default"), { recursive: true, force: true }); // would fail a playwright check
      const channel = makeLoadedChannel(repoDir);
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-stats-fake-"));

      const rows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") },
        learning: { harnessRoot: HARNESS_ROOT, statsAdapter: "fake", agentIsFake: true, loadProfile: (id) => loadProfile(HARNESS_ROOT, id), loadWorkflow: (ref) => loadWorkflow(HARNESS_ROOT, ref) },
      });
      expect(new Map(rows.map((r) => [r.check, r])).get("channel:c1:stats")).toMatchObject({ ok: true, detail: "fake" });
    });

    it("channel:<id>:stats with adapters.stats playwright: ok when the adapter script and .upload-profile/Default both exist, fails naming what is missing otherwise", () => {
      const repoDir = setupChannelRepo();
      const channel = makeLoadedChannel(repoDir);
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-stats-playwright-ok-"));
      const learning = { harnessRoot: HARNESS_ROOT, statsAdapter: "playwright" as const, agentIsFake: true, loadProfile: (id: string) => loadProfile(HARNESS_ROOT, id), loadWorkflow: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };

      const okRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") }, learning,
      });
      expect(new Map(okRows.map((r) => [r.check, r])).get("channel:c1:stats")).toMatchObject({ ok: true });

      rmSync(join(repoDir, ".upload-profile", "Default"), { recursive: true, force: true });
      const missingRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [channel], errors: [], secrets: new FixedSecrets("owner@example.com") }, learning,
      });
      const missingRow = new Map(missingRows.map((r) => [r.check, r])).get("channel:c1:stats");
      expect(missingRow).toMatchObject({ ok: false });
      expect(missingRow?.detail).toContain(join(".upload-profile", "Default"));
    });

    it("channel:<id>:planning is added only for a channel with planning.enabled, ok when the profile+workflow load and the agent is not fake", () => {
      const repoDir = setupChannelRepo();
      const disabled = makeLoadedChannel(repoDir);
      const enabled = makeLoadedChannel(repoDir, { planning: { enabled: true } });
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-planning-ok-"));
      const learning = { harnessRoot: HARNESS_ROOT, statsAdapter: "fake" as const, agentIsFake: false, loadProfile: (id: string) => loadProfile(HARNESS_ROOT, id), loadWorkflow: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };

      const disabledRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [disabled], errors: [], secrets: new FixedSecrets("owner@example.com") }, learning,
      });
      expect(disabledRows.some((r) => r.check === "channel:c1:planning")).toBe(false);

      const enabledRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [enabled], errors: [], secrets: new FixedSecrets("owner@example.com") }, learning,
      });
      expect(new Map(enabledRows.map((r) => [r.check, r])).get("channel:c1:planning")).toMatchObject({ ok: true });
    });

    it("channel:<id>:planning warns \"fake agent\" when the profile+workflow load but adapters.agent is fake, and fails when the profile itself cannot load", () => {
      const repoDir = setupChannelRepo();
      const enabled = makeLoadedChannel(repoDir, { planning: { enabled: true } });
      const projectDir = mkdtempSync(join(tmpdir(), "doctor-planning-fake-agent-"));

      const fakeAgentRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [enabled], errors: [], secrets: new FixedSecrets("owner@example.com") },
        learning: { harnessRoot: HARNESS_ROOT, statsAdapter: "fake", agentIsFake: true, loadProfile: (id) => loadProfile(HARNESS_ROOT, id), loadWorkflow: (ref) => loadWorkflow(HARNESS_ROOT, ref) },
      });
      const fakeAgentRow = new Map(fakeAgentRows.map((r) => [r.check, r])).get("channel:c1:planning");
      expect(fakeAgentRow).toMatchObject({ ok: false });
      expect(fakeAgentRow?.detail).toContain("fake");

      const brokenProfileRows = runDoctor({
        ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
        channels: { loaded: [enabled], errors: [], secrets: new FixedSecrets("owner@example.com") },
        learning: { harnessRoot: HARNESS_ROOT, statsAdapter: "fake", agentIsFake: false, loadProfile: () => { throw new Error("profile.yaml not found"); }, loadWorkflow: (ref) => loadWorkflow(HARNESS_ROOT, ref) },
      });
      const brokenProfileRow = new Map(brokenProfileRows.map((r) => [r.check, r])).get("channel:c1:planning");
      expect(brokenProfileRow).toMatchObject({ ok: false });
      expect(brokenProfileRow?.detail).toContain("profile.yaml not found");
    });
  });
});

describe("media:* rows (sub-project 5A, Task 9)", () => {
  function makeProbe(overrides: Partial<MediaEngineProbe> = {}): MediaEngineProbe {
    return {
      python: "/usr/bin/python3.11",
      packages: { torch: "2.3.0", omnivoice: "0.1.0", whisperx: "3.1.1" },
      cuda: true,
      gpu: "NVIDIA RTX 4090",
      vram_free_mb: 20000,
      models_cached: { omnivoice: true, whisperx: true },
      ...overrides,
    };
  }

  function runWith(input: Partial<DoctorInput>) {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-media-"));
    return runDoctor({ ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [], ...input });
  }

  it("adds no media:* rows at all when adapters.media is fake and there is no studio-autopilot-on-1.2.0 case", () => {
    const rows = runWith({});
    expect(rows.some((r) => r.check.startsWith("media:"))).toBe(false);
  });

  it("python engine with everything present: four ok rows", () => {
    const rows = runWith({ media: { pythonPath: "/usr/bin/python3.11", device: "cuda:0", probe: makeProbe() } });
    const byCheck = new Map(rows.map((r) => [r.check, r]));
    expect(byCheck.get("media:python")).toMatchObject({ ok: true });
    expect(byCheck.get("media:packages")).toMatchObject({ ok: true });
    expect(byCheck.get("media:device")).toMatchObject({ ok: true });
    expect(byCheck.get("media:models")).toMatchObject({ ok: true });
  });

  it("media:python fails naming the configured path when the probe could not run python at all", () => {
    const rows = runWith({
      media: { pythonPath: "/opt/bad-python", device: "cpu", probe: makeProbe({ python: null, packages: { torch: null, omnivoice: null, whisperx: null }, cuda: false, models_cached: { omnivoice: false, whisperx: false } }) },
    });
    const row = new Map(rows.map((r) => [r.check, r])).get("media:python");
    expect(row).toMatchObject({ ok: false });
    expect(row?.detail).toContain("/opt/bad-python");
  });

  it("media:packages fails and names a missing package", () => {
    const rows = runWith({ media: { pythonPath: "/usr/bin/python3.11", device: "cuda:0", probe: makeProbe({ packages: { torch: "2.3.0", omnivoice: "0.1.0", whisperx: null } }) } });
    const row = new Map(rows.map((r) => [r.check, r])).get("media:packages");
    expect(row).toMatchObject({ ok: false });
    expect(row?.detail).toContain("whisperx");
    expect(row?.detail).not.toContain("torch");
  });

  it("media:device fails when device is cuda:0 but the probe found no CUDA", () => {
    const rows = runWith({ media: { pythonPath: "/usr/bin/python3.11", device: "cuda:0", probe: makeProbe({ cuda: false }) } });
    expect(new Map(rows.map((r) => [r.check, r])).get("media:device")).toMatchObject({ ok: false, detail: "CUDA not available" });
  });

  it("media:device is ok \"cpu\" regardless of the probe's cuda flag when device is cpu", () => {
    const rows = runWith({ media: { pythonPath: "/usr/bin/python3.11", device: "cpu", probe: makeProbe({ cuda: false }) } });
    expect(new Map(rows.map((r) => [r.check, r])).get("media:device")).toMatchObject({ ok: true, detail: "cpu" });
  });

  it("media:models is ok:false (a warning, not a hard failure) naming the uncached model", () => {
    const rows = runWith({ media: { pythonPath: "/usr/bin/python3.11", device: "cuda:0", probe: makeProbe({ models_cached: { omnivoice: true, whisperx: false } }) } });
    const row = new Map(rows.map((r) => [r.check, r])).get("media:models");
    expect(row).toMatchObject({ ok: false });
    expect(row?.detail).toContain("will download on first run");
    expect(row?.detail).toContain("whisperx");
  });

  it("media:engine fails \"fake media engine\" on a studio autopilot project whose effective release is library-production@1.2.0", () => {
    const rows = runWith({ mediaEngineOnFake: { effectiveRelease: "library-production@1.2.0" } });
    expect(new Map(rows.map((r) => [r.check, r])).get("media:engine")).toMatchObject({ ok: false, detail: "fake media engine" });
  });

  it("media:engine also fires for a release newer than 1.2.0, but adds no row for a 1.1.0 rollback or an unrelated workflow", () => {
    const newer = runWith({ mediaEngineOnFake: { effectiveRelease: "library-production@1.3.0" } });
    expect(newer.some((r) => r.check === "media:engine")).toBe(true);

    const rolledBack = runWith({ mediaEngineOnFake: { effectiveRelease: "library-production@1.1.0" } });
    expect(rolledBack.some((r) => r.check === "media:engine")).toBe(false);

    const otherWorkflow = runWith({ mediaEngineOnFake: { effectiveRelease: "footage-production@1.2.0" } });
    expect(otherWorkflow.some((r) => r.check === "media:engine")).toBe(false);
  });
});

describe("library:auto_accept collection mode (sub-project 5A Task 9 fix round)", () => {
  const config = { enabled: true, source_collection: "main", source_collections: ["shoot-*"], max_replans: 2, max_concurrent_runs: 1 };

  function runWith(autoAccept: NonNullable<NonNullable<DoctorInput["library"]>["autoAccept"]>) {
    const projectDir = mkdtempSync(join(tmpdir(), "doctor-media-autoaccept-"));
    const libRoot = mkdtempSync(join(tmpdir(), "doctor-media-autoaccept-kho-"));
    mkdirSync(join(libRoot, "styles"), { recursive: true });
    const fs = new LibraryFs({ root: libRoot, role: "studio" });
    return runDoctor({
      ...baseInput(projectDir, {}), scripts: undefined, secrets: new StubSecrets(true), workflows: [], profiles: [],
      library: { fs, role: "studio", autoAccept },
    });
  }

  it("ok, listing matching collections and counts, when at least one collection matches a pattern", () => {
    const rows = runWith({ config, sourceCount: 0, agentIsFake: false, matchingCollections: [{ name: "shoot-01", count: 3 }, { name: "shoot-02", count: 1 }] });
    const row = new Map(rows.map((r) => [r.check, r])).get("library:auto_accept");
    expect(row).toMatchObject({ ok: true });
    expect(row?.detail).toContain("shoot-01 (3)");
    expect(row?.detail).toContain("shoot-02 (1)");
  });

  it("fails naming the patterns when no empty-\"main\" collection-mode project has any matching collection (Task 7's bug: a project with an empty legacy main must not FAIL here)", () => {
    const rows = runWith({ config, sourceCount: 0, agentIsFake: false, matchingCollections: [] });
    const row = new Map(rows.map((r) => [r.check, r])).get("library:auto_accept");
    expect(row).toMatchObject({ ok: false });
    expect(row?.detail).toContain("shoot-*");
  });

  it("still fails on adapters.agent fake in collection mode", () => {
    const rows = runWith({ config, sourceCount: 0, agentIsFake: true, matchingCollections: [{ name: "shoot-01", count: 1 }] });
    expect(new Map(rows.map((r) => [r.check, r])).get("library:auto_accept")).toMatchObject({ ok: false, detail: "adapters.agent is fake" });
  });

  it("names the pinned workflow_release in the ok detail, and fails outright when it is not loadable", () => {
    const pinned = { ...config, workflow_release: "library-production@1.1.0" };
    const ok = runWith({ config: pinned, sourceCount: 0, agentIsFake: false, matchingCollections: [{ name: "shoot-01", count: 1 }], pinnedWorkflowLoadable: true });
    const okRow = new Map(ok.map((r) => [r.check, r])).get("library:auto_accept");
    expect(okRow).toMatchObject({ ok: true });
    expect(okRow?.detail).toContain("library-production@1.1.0");

    const unloadable = runWith({ config: pinned, sourceCount: 0, agentIsFake: false, matchingCollections: [{ name: "shoot-01", count: 1 }], pinnedWorkflowLoadable: false });
    const badRow = new Map(unloadable.map((r) => [r.check, r])).get("library:auto_accept");
    expect(badRow).toMatchObject({ ok: false });
    expect(badRow?.detail).toContain("library-production@1.1.0");
  });

  it("legacy mode (no source_collections) is unaffected: still keys off sourceCount alone", () => {
    const legacyConfig = { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1 };
    const rows = runWith({ config: legacyConfig, sourceCount: 0, agentIsFake: false });
    expect(new Map(rows.map((r) => [r.check, r])).get("library:auto_accept")).toMatchObject({ ok: false, detail: "collection main has no sources" });
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
