import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-stage-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  return dir;
}

describe("harness stage submit", () => {
  it("fails with NOT_FOUND for a stage run that does not exist", () => {
    const p = freshProject();
    expect(cli(p, "db", "migrate").code).toBe(0);
    const r = cli(p, "stage", "submit", "stage_01J00000000000000000000000");
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT_FOUND");
  });
});
