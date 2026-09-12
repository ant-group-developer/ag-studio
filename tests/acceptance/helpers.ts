import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";

export const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
export function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", dir, "db", "migrate"], { encoding: "utf8" });
  return dir;
}
export function cli(project: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error", ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
export function cliAsync(project: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
export function planRun(project: string): string {
  const r = cli(project, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json"]);
  const { run_id } = JSON.parse(r.out);
  cli(project, ["enqueue", run_id]);
  return run_id;
}
export function status(project: string, runId: string) {
  return JSON.parse(cli(project, ["status", runId, "--json"]).out) as { run: { state: string }; stages: { stage_key: string; state: string; attempts: { lease_owner: string; state: string }[] }[]; artifacts: { status: string; stage_run_id: string }[] };
}
