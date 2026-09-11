import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, ProjectConfigSchema, WorkflowDefinitionSchema } from "../src/config.js";

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
  it("applies harness defaults", () => {
    const cfg = HarnessConfigSchema.parse({ schema_version: "harness.config/v1" });
    expect(cfg.lease_seconds).toBe(90);
    expect(cfg.heartbeat_seconds).toBe(30);
    expect(cfg.poll_seconds).toBe(2);
    expect(cfg.retention.workspace_days).toBe(7);
  });
  it("parses project config with runtime", () => {
    expect(ProjectConfigSchema.parse({
      schema_version: "harness.project/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
      data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    }).runtime).toBe("claude");
  });
});
