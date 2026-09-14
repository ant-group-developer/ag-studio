import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { cli } from "../../../tests/integration/library-helpers.js";

// Task 10: `harness dashboard snapshot|serve`. This reuses Task 9's minimal-project shape (no channels needed --
// `writeDashboardSnapshot` must work fine with an empty `channels: []`).

function writeMinimalProjectYaml(dir: string, projectId: string): void {
  writeFileSync(join(dir, "project.yaml"), stringify({
    schema_version: "harness.project-config/v1",
    project_id: projectId,
    template_release: "0.1.0",
    runtime: "claude",
    data_root: "./data",
    portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    resources: {},
    workflows: [],
  }));
}

function migrate(project: string): void {
  const r = cli(project, ["db", "migrate"]);
  if (r.code !== 0) throw new Error(`db migrate failed in ${project}: ${r.err}\n${r.out}`);
}

describe("harness dashboard", () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "dashboard-cmd-"));
    writeMinimalProjectYaml(project, "project-dashboard");
    migrate(project);
  });

  it("dashboard snapshot writes dashboard/snapshot.json and prints its path", () => {
    const r = cli(project, ["dashboard", "snapshot"]);
    expect(r.code, r.err).toBe(0);
    const path = r.out.trim();
    expect(existsSync(path)).toBe(true);
    expect(path.replace(/\\/g, "/")).toMatch(/dashboard\/snapshot\.json$/);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schema_version).toBe("harness.dashboard-snapshot/v1");
    expect(parsed.project_id).toBe("project-dashboard");
  });

  it("dashboard snapshot --json prints the snapshot content itself", () => {
    const r = cli(project, ["dashboard", "snapshot", "--json"]);
    expect(r.code, r.err).toBe(0);
    const snapshot = JSON.parse(r.out);
    expect(snapshot.schema_version).toBe("harness.dashboard-snapshot/v1");
    expect(snapshot.channels).toEqual([]);
  });
});
