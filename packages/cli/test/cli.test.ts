import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT, SqliteStateStore } from "@harness/core";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  return dir;
}

describe("harness CLI", () => {
  it("plans, enqueues, works and reports a SUCCEEDED run", () => {
    const p = freshProject();
    expect(cli(p, "db", "migrate").code).toBe(0);
    const plan = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json");
    expect(plan.code, plan.err).toBe(0);
    const { run_id } = JSON.parse(plan.out);
    expect(run_id).toMatch(/^run_/);
    expect(cli(p, "enqueue", run_id).code).toBe(0);
    for (let i = 0; i < 6; i++) {
      const w = cli(p, "worker", "--once", "--capabilities", "write_workspace,read_source", "--owner", `w${i}`);
      expect(w.code, w.err).toBe(0);
      if (w.out.includes("idle")) break;
    }
    const status = cli(p, "status", run_id, "--json");
    expect(status.code).toBe(0);
    const s = JSON.parse(status.out);
    expect(s.run.state).toBe("SUCCEEDED");
    expect(s.stages.map((x: { state: string }) => x.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    expect(s.artifacts.filter((a: { status: string }) => a.status === "ACCEPTED")).toHaveLength(3);
    expect(cli(p, "events", "tail", "--run", run_id).out).toContain("run.succeeded");
  });
  it("workspaces prune removes terminal-stage workspaces but never an unknown directory", () => {
    const p = freshProject();
    expect(cli(p, "db", "migrate").code).toBe(0);
    const { run_id } = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json").out);
    expect(cli(p, "enqueue", run_id).code).toBe(0);
    for (let i = 0; i < 6; i++) if (cli(p, "worker", "--once", "--capabilities", "write_workspace,read_source", "--owner", `w${i}`).out.includes("idle")) break;
    const wsRoot = join(p, "data", "workspaces", run_id);
    const stray = join(wsRoot, "produce", "bogus_attempt");
    mkdirSync(stray, { recursive: true });
    const real = readdirSync(join(wsRoot, "produce")).filter((d) => d !== "bogus_attempt");
    expect(real.length).toBeGreaterThan(0);

    const pruned = cli(p, "workspaces", "prune", "--days", "0");
    expect(pruned.code, pruned.err).toBe(0);
    expect(pruned.out).toMatch(/removed \d+, skipped [1-9]/);
    expect(existsSync(stray)).toBe(true);
    for (const d of real) expect(existsSync(join(wsRoot, "produce", d))).toBe(false);

    const forced = cli(p, "workspaces", "prune", "--days", "0", "--force");
    expect(forced.code, forced.err).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });
  it("fails fast on an unknown config override", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const r = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "leese_seconds=5");
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNKNOWN_CONFIG_KEY");
  });
  it("never leaks a resolved secret into snapshot, events or logs", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "default_max_cost_usd=1", "--json"], { encoding: "utf8", env: { ...process.env, HARNESS_SECRET_TTS_MAIN: "super-secret-token", HARNESS_LOG_LEVEL: "debug" } });
    const all = r.stdout + r.stderr;
    expect(all).not.toContain("super-secret-token");
    const { run_id } = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    const status = cli(p, "status", run_id, "--json");
    expect(status.out + status.err).not.toContain("super-secret-token");
  });
  it("retry refuses a terminal run and leaves its stages untouched", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const plan = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json");
    const { run_id } = JSON.parse(plan.out);
    cli(p, "enqueue", run_id);
    // drive the run to a terminal FAILED state directly through the store
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const stage = store.listStageRuns(run_id).find((s) => s.stage_key === "produce")!;
    const ev = { run_id, stage_run_id: stage.stage_run_id, attempt_id: null, project_id: "project-minimal", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "error" as const, event_type: "stage.test", payload: {} };
    store.transaction(() => {
      store.transition("stage_run", stage.stage_run_id, "READY", "CLAIMED", ev);
      store.transition("stage_run", stage.stage_run_id, "CLAIMED", "FAILED", ev);
      store.transition("run", run_id, "READY", "RUNNING", ev);
      store.transition("run", run_id, "RUNNING", "FAILED", ev);
    });
    store.close();
    const r = cli(p, "retry", run_id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("INVALID_TRANSITION");
    const s = JSON.parse(cli(p, "status", run_id, "--json").out);
    expect(s.run.state).toBe("FAILED");
    expect(s.stages.find((x: { stage_key: string }) => x.stage_key === "produce").state).toBe("FAILED");
  });
  it("retry refuses a run whose cancel is still pending", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const plan = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json");
    const { run_id } = JSON.parse(plan.out);
    cli(p, "enqueue", run_id);
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    const ev = { run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, project_id: "project-minimal", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transaction(() => {
      store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    });
    store.close();
    expect(cli(p, "cancel", run_id).out).toContain("CANCEL_REQUESTED");
    const r = cli(p, "retry", run_id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("INVALID_TRANSITION");
  });
  it("ingests a source, creates content, plans a variant and shows resources", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const raw = join(p, "raw.txt"); writeFileSync(raw, "raw source bytes");
    const ing = JSON.parse(cli(p, "source", "ingest", raw, "--collection", "main", "--rights", "cleared", "--json").out);
    expect(ing.source_id).toMatch(/^src_/); expect(ing.created).toBe(true);
    expect(JSON.parse(cli(p, "source", "ingest", raw, "--json").out).created).toBe(false);
    expect(JSON.parse(cli(p, "source", "list", "--json").out)).toHaveLength(1);
    expect(cli(p, "source", "verify").code).toBe(0);
    const content = JSON.parse(cli(p, "content", "create", "--source", ing.source_id, "--title", "Ep 1", "--json").out);
    expect(content.content_id).toMatch(/^content_/);
    const plan = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--content", content.content_id, "--json").out);
    expect(plan.variant_id).toMatch(/^variant_/);
    const status = JSON.parse(cli(p, "status", plan.run_id, "--json").out);
    expect(status.run.content_id).toBe(content.content_id);
    expect(status.run.source_id).toBe(ing.source_id);
    const res = JSON.parse(cli(p, "resources", "status", "--json").out);
    expect(res).toEqual(expect.arrayContaining([{ resource: "gpu", capacity: 1, held: 0, free: 1 }]));
    expect(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--content", content.content_id, "--option", "voice=tts").code).toBe(1); // cartoon declares no options
  });
  it("artifacts sweep reports and removes orphan directories", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const dir = join(p, "data", "artifacts", "c", "v", "artifact_01J00000000000000000000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifact_id: "artifact_01J00000000000000000000000", status: "provisional" }));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, "manifest.json"), old, old);
    const dry = JSON.parse(cli(p, "artifacts", "sweep", "--dry-run", "--json").out);
    expect(dry.removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    const real = JSON.parse(cli(p, "artifacts", "sweep", "--json").out);
    expect(real.removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
});
