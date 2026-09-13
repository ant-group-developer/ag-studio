import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest } from "@harness/contracts";
import { GateExecutor } from "../src/gate-executor.js";

describe("GateExecutor", () => {
  it("writes the request and a brief, then defers", async () => {
    const ws = mkdtempSync(join(tmpdir(), "gate-"));
    const req: StageRequest = { schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf", stage_key: "select-topic", workflow: { id: "footage-production", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "footage", revision: 1 }, inputs: [{ artifact_id: newId("artifact"), checksum: "sha256:" + "b".repeat(64), path: "input/x/shots.json", type: "shots", kind: "file" }], workspace_uri: ws, stage_config: { __brief: "Pick one topic from the shots." }, options: { voice: "tts" }, source_items: [], resources: [], expected_outputs: [{ type: "topic", mime_type: "text/markdown", kind: "file", name: "topic.md" }], policy: {}, limits: { deadline_at: "2026-09-13T01:00:00.000Z", max_cost_usd: 0, max_attempts: 1 }, capabilities: [], fencing_token: 1 };
    const res = await new GateExecutor().execute(req, { workspaceDir: ws, logger: { info() {}, warn() {}, error() {} }, clock: { now: () => "2026-09-13T00:00:00.000Z" } });
    expect(res).toMatchObject({ outcome: "deferred", outputs: [], attempt_id: req.attempt_id });
    expect(existsSync(join(ws, "stage-request.json"))).toBe(true);
    const brief = readFileSync(join(ws, "brief.md"), "utf8");
    expect(brief).toContain("Pick one topic"); expect(brief).toContain("output/topic.md"); expect(brief).toContain(`harness stage submit ${req.stage_run_id}`); expect(brief).toContain("input/x/shots.json");
  });
});
