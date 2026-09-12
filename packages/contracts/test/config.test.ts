import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, ProjectConfigSchema, WorkflowDefinitionSchema, ProductionProfileSchema } from "../src/config.js";

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
  it("parses project resources and source materialize policy", () => {
    const pc = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }], resources: { gpu: 1, "image-gen": 2 } });
    expect(pc.resources).toEqual({ gpu: 1, "image-gen": 2 });
    expect(pc.source.materialize).toBe("link");
    expect(ProjectConfigSchema.safeParse({ ...pc, resources: { GPU: 1 } }).success).toBe(false);
    expect(HarnessConfigSchema.parse({ schema_version: "harness.config/v1" }).resource_wait_warn_seconds).toBe(600);
  });
});
