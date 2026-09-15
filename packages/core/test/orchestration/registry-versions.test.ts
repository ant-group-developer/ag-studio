import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { listWorkflowRefs, loadWorkflow } from "../../src/orchestration/registry.js";

const STAGES = [
  "  - key: produce",
  "    executor: { type: script, script: fake-stage }",
].join("\n");

function workflowYaml(id: string, version: string): string {
  return [`schema_version: harness.workflow/v1`, `id: ${id}`, `version: ${version}`, `stages:`, STAGES].join("\n") + "\n";
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "registry-versions-"));
}

function writeWorkflow(root: string, dirName: string, id: string, version: string): void {
  const dir = join(root, "workflows", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), workflowYaml(id, version));
}

describe("versioned workflow directories", () => {
  it("loadWorkflow resolves wf@1.0.0 from workflows/wf/ and wf@1.1.0 from workflows/wf@1.1.0/", () => {
    const root = makeRoot();
    writeWorkflow(root, "wf", "wf", "1.0.0");
    writeWorkflow(root, "wf@1.1.0", "wf", "1.1.0");

    expect(loadWorkflow(root, "wf@1.0.0").definition.version).toBe("1.0.0");
    expect(loadWorkflow(root, "wf@1.1.0").definition.version).toBe("1.1.0");
  });

  it("loadWorkflow throws WORKFLOW_INVALID for a version with no matching directory or content", () => {
    const root = makeRoot();
    writeWorkflow(root, "wf", "wf", "1.0.0");
    writeWorkflow(root, "wf@1.1.0", "wf", "1.1.0");

    try {
      loadWorkflow(root, "wf@2.0.0");
      expect.fail("expected loadWorkflow to throw");
    } catch (e) {
      expect(isHarnessError(e, "WORKFLOW_INVALID")).toBe(true);
    }
  });

  it("listWorkflowRefs returns sorted, unique id@version refs", () => {
    const root = makeRoot();
    writeWorkflow(root, "wf", "wf", "1.0.0");
    writeWorkflow(root, "wf@1.1.0", "wf", "1.1.0");

    expect(listWorkflowRefs(root)).toEqual(["wf@1.0.0", "wf@1.1.0"]);
  });

  it("listWorkflowRefs skips directories without workflow.yaml", () => {
    const root = makeRoot();
    writeWorkflow(root, "wf", "wf", "1.0.0");
    mkdirSync(join(root, "workflows", "not-a-workflow"), { recursive: true });

    expect(listWorkflowRefs(root)).toEqual(["wf@1.0.0"]);
  });

  it("listWorkflowRefs returns [] when the workflows directory itself does not exist", () => {
    const root = makeRoot();
    expect(listWorkflowRefs(root)).toEqual([]);
  });

  // Documented fallback (registry.ts, listWorkflowRefs): a workflow.yaml that fails to yield a usable id/version
  // (bad YAML syntax, or missing/non-string id or version fields) is still surfaced as a ref -- but only when
  // the directory is already named `<id>@<version>` (the versioned-dir convention this task adds), since that
  // name is the only trustworthy source of a ref in that case. WORKFLOW_INVALID then surfaces when the ref is
  // actually loaded via loadWorkflow, not during listing.
  it("falls back to the directory name for a workflow.yaml missing id/version when the directory is named <id>@<version>", () => {
    const root = makeRoot();
    const brokenDir = join(root, "workflows", "broken@1.2.0");
    mkdirSync(brokenDir, { recursive: true });
    // valid YAML syntax, but no `id`/`version` fields at all -- listWorkflowRefs cannot read a ref from content
    writeFileSync(join(brokenDir, "workflow.yaml"), "schema_version: harness.workflow/v1\nstages: []\n");

    expect(listWorkflowRefs(root)).toEqual(["broken@1.2.0"]);
    try {
      loadWorkflow(root, "broken@1.2.0");
      expect.fail("expected loadWorkflow to throw");
    } catch (e) {
      expect(isHarnessError(e, "WORKFLOW_INVALID")).toBe(true);
    }
  });

  it("skips a workflow.yaml missing id/version in a plain <id>/ directory (no version to fall back on)", () => {
    const root = makeRoot();
    const brokenDir = join(root, "workflows", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "workflow.yaml"), "schema_version: harness.workflow/v1\nstages: []\n");

    expect(listWorkflowRefs(root)).toEqual([]);
  });
});
