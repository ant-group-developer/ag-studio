import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Checker, type StageRequest, type StageResult } from "@harness/contracts";
import { mediaCheckers } from "../../src/verification/media-checkers.js";
import { NullMediaProber } from "../../src/source-catalog/prober.js";

const sha = "sha256:" + "a".repeat(64);

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "plan-edit",
    workflow: { id: "w", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-21T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [],
    fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1",
    attempt_id: newId("attempt"),
    outcome: "succeeded",
    outputs,
    checks: [],
    usage: { wall_seconds: 1, cost_usd: 0 },
    external_operations: [],
    errors: [],
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "edl-valid-narration-"));
}

describe("edl-valid (narration extension, version 1.1.0)", () => {
  function fixture(ws: string) {
    const sourceId = newId("source_item");
    const edl = {
      schema_version: "harness.edl/v1",
      entries: [
        { source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" },
        { source_id: sourceId, in: 2, out: 4, order: 1, overlay: null, note: "" },
      ],
    };
    mkdirSync(join(ws, "output"), { recursive: true });
    writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(edl));
    const request = baseRequest({
      source_items: [{ source_id: sourceId, uri: "file:///a.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 10 }],
      expected_outputs: [
        { type: "edl", mime_type: "application/json", kind: "file" },
        { type: "narration", mime_type: "application/json", kind: "file" },
      ],
    });
    return { request, sourceId };
  }

  function checker() {
    return checkerById(mediaCheckers(new NullMediaProber(), { available: false }), "edl-valid");
  }

  it("reports version 1.1.0", () => {
    expect(checker().version).toBe("1.1.0");
  });

  it("passes a narration (application/json) whose edl_order values all exist in the edl and whose line_id values are unique", async () => {
    const ws = tmpWorkspace();
    const { request } = fixture(ws);
    const narration = { schema_version: "harness.narration/v1", language: "en", lines: [
      { line_id: "L001", edl_order: 0, text: "First line." },
      { line_id: "L002", edl_order: 1, text: "Second line." },
    ] };
    writeFileSync(join(ws, "output", "narration.json"), JSON.stringify(narration));
    const result = baseResult([
      { path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" },
      { path: "output/narration.json", type: "narration", checksum: sha, size_bytes: 1, kind: "file" },
    ]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when a narration line references an edl_order not present in the edl", async () => {
    const ws = tmpWorkspace();
    const { request } = fixture(ws);
    const narration = { schema_version: "harness.narration/v1", language: "en", lines: [{ line_id: "L001", edl_order: 99, text: "Orphan line." }] };
    writeFileSync(join(ws, "output", "narration.json"), JSON.stringify(narration));
    const result = baseResult([
      { path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" },
      { path: "output/narration.json", type: "narration", checksum: sha, size_bytes: 1, kind: "file" },
    ]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("unknown edl_order");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when two narration lines share a line_id", async () => {
    const ws = tmpWorkspace();
    const { request } = fixture(ws);
    const narration = { schema_version: "harness.narration/v1", language: "en", lines: [
      { line_id: "L001", edl_order: 0, text: "First line." },
      { line_id: "L001", edl_order: 1, text: "Duplicate id." },
    ] };
    writeFileSync(join(ws, "output", "narration.json"), JSON.stringify(narration));
    const result = baseResult([
      { path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" },
      { path: "output/narration.json", type: "narration", checksum: sha, size_bytes: 1, kind: "file" },
    ]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("duplicate line_id");
    rmSync(ws, { recursive: true, force: true });
  });

  it("a text/plain narration output (pre-5A narration.txt shape) is left untouched: still passes on the edl alone", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const edl = { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] };
    mkdirSync(join(ws, "output"), { recursive: true });
    writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(edl));
    writeFileSync(join(ws, "output", "narration.txt"), "not json at all, and that must not matter");
    const request = baseRequest({
      source_items: [{ source_id: sourceId, uri: "file:///a.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 10 }],
      expected_outputs: [
        { type: "edl", mime_type: "application/json", kind: "file" },
        { type: "narration", mime_type: "text/plain", kind: "file" },
      ],
    });
    const result = baseResult([
      { path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" },
      { path: "output/narration.txt", type: "narration", checksum: sha, size_bytes: 1, kind: "file" },
    ]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });
});
