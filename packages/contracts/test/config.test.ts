import { describe, expect, it } from "vitest";
import { autoAcceptSchema, HarnessConfigSchema, ProjectConfigSchema, WorkflowDefinitionSchema, ProductionProfileSchema } from "../src/config.js";
import { ScriptsRegistrySchema, SourcesRegistrySchema, StageRequestSchema } from "../src/index.js";

describe("config contracts", () => {
  it("parses a workflow definition and rejects unknown keys", () => {
    const wf = {
      schema_version: "harness.workflow/v1", id: "sample-three-stage", version: "1.0.0",
      defaults: { lease_seconds: 90 },
      stages: [
        { key: "produce", executor: { type: "script", script: "fake-stage" }, depends_on: [], required_capabilities: ["write_workspace"], required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
        { key: "verify", executor: { type: "agent", skill: "fake-review", brief: "review it" }, depends_on: ["produce"], required_capabilities: ["read_source"], required_checks: ["schema-valid"] },
      ],
    };
    const parsed = WorkflowDefinitionSchema.parse(wf);
    expect(parsed.stages[0]?.retry).toEqual({ max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] });
    expect(WorkflowDefinitionSchema.safeParse({ ...wf, bogus: true }).success).toBe(false);
  });
  it("rejects a stage that depends on a missing key", () => {
    expect(WorkflowDefinitionSchema.safeParse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [{ key: "a", executor: { type: "script", script: "x" }, depends_on: ["nope"], required_capabilities: [], required_checks: [] }],
    }).success).toBe(false);
  });
  it("rejects a dependency cycle longer than one stage", () => {
    const r = WorkflowDefinitionSchema.safeParse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [
        { key: "a", executor: { type: "script", script: "x" }, depends_on: ["c"], required_capabilities: [], required_checks: [] },
        { key: "b", executor: { type: "script", script: "x" }, depends_on: ["a"], required_capabilities: [], required_checks: [] },
        { key: "c", executor: { type: "script", script: "x" }, depends_on: ["b"], required_capabilities: [], required_checks: [] },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.startsWith("dependency cycle"))).toBe(true);
  });
  it("applies harness defaults", () => {
    const cfg = HarnessConfigSchema.parse({ schema_version: "harness.config/v1" });
    expect(cfg.lease_seconds).toBe(90);
    expect(cfg.heartbeat_seconds).toBe(30);
    expect(cfg.poll_seconds).toBe(2);
    expect(cfg.retention.workspace_days).toBe(7);
  });
  it("parses project config with runtime", () => {
    expect(ProjectConfigSchema.parse({
      schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
      data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    }).runtime).toBe("claude");
  });
  it("parses when, optional dependencies, resources and directory outputs on stages", () => {
    const wf = WorkflowDefinitionSchema.parse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [
        { key: "a", executor: { type: "script", script: "x" } },
        { key: "tts", executor: { type: "script", script: "x" }, depends_on: ["a"], when: 'options.voice == "tts"', requires_resources: ["gpu"] },
        { key: "b", executor: { type: "gate", brief: "go" }, depends_on: ["a"], depends_on_optional: ["tts"], gate_deadline_seconds: 3600, outputs: [{ type: "clip_set", mime_type: "application/x-directory", kind: "directory", name: "cuts" }] },
      ],
    });
    expect(wf.stages[1]?.when).toBe('options.voice == "tts"');
    expect(wf.stages[2]?.depends_on_optional).toEqual(["tts"]);
    expect(wf.stages[2]?.outputs[0]?.kind).toBe("directory");
    expect(wf.stages[0]?.outputs).toEqual([]);
    expect(wf.stages[0]?.requires_resources).toEqual([]);
  });
  it("rejects malformed when expressions and unknown optional dependencies", () => {
    const base = { schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {} };
    expect(WorkflowDefinitionSchema.safeParse({ ...base, stages: [{ key: "a", executor: { type: "script", script: "x" }, when: "voice == tts" }] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ ...base, stages: [{ key: "a", executor: { type: "script", script: "x" }, depends_on_optional: ["nope"] }] }).success).toBe(false);
  });
  it("parses profile options schema, reuse policy and per-stage checks", () => {
    const p = ProductionProfileSchema.parse({
      schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "footage-production@1.0.0",
      options_schema: { voice: ["none", "tts", "original"], avatar: ["none", "heygen"] }, options_defaults: { voice: "none", avatar: "none" },
      verification: { required_checks_by_stage: { assemble: ["media-probe"] } }, content: { target_duration_seconds: [480, 720] },
    });
    expect(p.reuse).toBe("allow");
    expect(p.verification.required_checks).toEqual([]);
    expect(p.verification.required_checks_by_stage.assemble).toEqual(["media-probe"]);
  });
  it("parses project.workflows as a list of workflow releases and rejects a bad ref format", () => {
    const base = { schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }] };
    expect(ProjectConfigSchema.parse({ ...base, workflows: ["footage-production@1.0.0", "library-production@1.0.0"] }).workflows).toEqual(["footage-production@1.0.0", "library-production@1.0.0"]);
    expect(ProjectConfigSchema.parse(base).workflows).toBeUndefined();
    for (const bad of ["footage-production", "footage-production@1.0", "Footage-Production@1.0.0", "footage-production@1.0.0-beta"]) {
      expect(ProjectConfigSchema.safeParse({ ...base, workflows: [bad] }).success, bad).toBe(false);
    }
  });
  // Sub-project 5A Task 9 fix round: an empty `source_collections` is a project.yaml that declares collection
  // mode but names no collection at all -- `pickSources`/`matchCollection` would just always come up empty,
  // so this is rejected at parse time rather than silently behaving like "no sources ever match".
  it("rejects an empty auto_accept.source_collections but accepts one pattern", () => {
    const base = { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1 };
    expect(autoAcceptSchema.safeParse({ ...base, source_collections: [] }).success).toBe(false);
    const parsed = autoAcceptSchema.parse({ ...base, source_collections: ["shoot-*"] });
    expect(parsed.source_collections).toEqual(["shoot-*"]);
  });
  it("parses project resources and source materialize policy", () => {
    const pc = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }], resources: { gpu: 1, "image-gen": 2 } });
    expect(pc.resources).toEqual({ gpu: 1, "image-gen": 2 });
    expect(pc.source.materialize).toBe("link");
    expect(ProjectConfigSchema.safeParse({ ...pc, resources: { GPU: 1 } }).success).toBe(false);
    expect(HarnessConfigSchema.parse({ schema_version: "harness.config/v1" }).resource_wait_warn_seconds).toBe(600);
  });
});

describe("2B contracts", () => {
  it("scripts registry defaults cwd, env_refs and resources; rejects a non-secret env ref", () => {
    const r = ScriptsRegistrySchema.parse({ schema_version: "harness.scripts/v1", scripts: { tts: { argv: ["node", "executors/wrappers/tts.mjs"], requires_resources: ["gpu"], timeout_seconds: 60 } } });
    expect(r.scripts.tts).toMatchObject({ cwd: ".", env_refs: {}, requires_resources: ["gpu"], timeout_seconds: 60 });
    expect(ScriptsRegistrySchema.safeParse({ schema_version: "harness.scripts/v1", scripts: { avatar: { argv: ["node", "x.mjs"], env_refs: { HEYGEN_API_KEY: "plain-value" } } } }).success).toBe(false);
    expect(ScriptsRegistrySchema.safeParse({ schema_version: "harness.scripts/v1", scripts: { bad: { argv: [] } } }).success).toBe(false);
  });
  it("sources registry entries default collection and rights", () => {
    const s = SourcesRegistrySchema.parse({ schema_version: "harness.sources/v1", sources: [{ path: "raw/clip.mp4" }] });
    expect(s.sources[0]).toMatchObject({ collection: "main", rights_status: "unknown", language: null });
  });
  it("stage request defaults expected_outputs and policy", () => {
    const req = StageRequestSchema.parse({ schema_version: "harness.stage-request/v1", run_id: "run_01J00000000000000000000000", stage_run_id: "stage_01J00000000000000000000000", attempt_id: "attempt_01J00000000000000000000000", project_id: "p", portfolio_id: "pf", stage_key: "k", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "footage", revision: 1 }, inputs: [], workspace_uri: "/ws", stage_config: {}, limits: { deadline_at: "2026-09-13T00:00:00.000Z", max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1 });
    expect(req.expected_outputs).toEqual([]);
    expect(req.policy).toEqual({});
  });
});
