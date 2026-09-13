import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";
import { makeVideo } from "../media.js";

export const FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-footage");
const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
const FIXTURE_POSIX = FIXTURE.split("\\").join("/");

export interface StatusJson {
  run: { run_id: string; state: string; total_cost_usd: number };
  stages: {
    stage_key: string;
    stage_run_id: string;
    state: string;
    attempts: { attempt_id: string; state: string; workspace_uri?: string }[];
    reused_artifact_ids?: string[];
  }[];
  artifacts: { artifact_id: string; type: string; status: string; stage_run_id: string; lineage: { source_items: string[]; input_artifacts: string[] } }[];
}

/** Scripts registered by `fixtures/ops-project-footage/executors/scripts.yaml`, with `cwd` pinned to the
 * fixture directory so the wrapper `.mjs` files run in place and can resolve `@harness/script-sdk` through
 * that fixture's own `node_modules` (a temp project has none). Kept in sync with that file by hand. */
function scriptsYaml(): string {
  const cwd = `"${FIXTURE_POSIX}"`;
  return [
    "schema_version: harness.scripts/v1",
    "scripts:",
    `  index-source:     { argv: [node, executors/wrappers/index-source.mjs], cwd: ${cwd}, requires_resources: [cpu], timeout_seconds: 600 }`,
    `  tts:              { argv: [node, executors/wrappers/tts.mjs], cwd: ${cwd}, requires_resources: [gpu], timeout_seconds: 600 }`,
    `  avatar:           { argv: [node, executors/wrappers/avatar.mjs], cwd: ${cwd}, env_refs: { HEYGEN_API_KEY: "secret://heygen/main" }, requires_resources: [heygen], timeout_seconds: 600 }`,
    `  cut:              { argv: [node, executors/wrappers/cut.mjs], cwd: ${cwd}, requires_resources: [cpu], timeout_seconds: 600 }`,
    `  assemble:         { argv: [node, executors/wrappers/assemble.mjs], cwd: ${cwd}, requires_resources: [cpu], timeout_seconds: 600 }`,
    `  thumbnail-render: { argv: [node, executors/wrappers/thumbnail-render.mjs], cwd: ${cwd}, timeout_seconds: 600 }`,
    // not used by footage-production; registered only so `harness doctor` (which checks every workflow in the
    // harness install, including sample-three-stage) finds every script it references.
    `  fake-stage:       { argv: [node], cwd: ${cwd} }`,
    "",
  ].join("\n");
}

/** Temp ops project wired to run footage-production against the ops-project-footage fixture in place (the
 * wrapper scripts stay under `fixtures/ops-project-footage` so they can resolve `@harness/script-sdk` through
 * that fixture's own `node_modules`; only project.yaml / scripts.yaml / source-catalog / raw/ live in the temp dir). */
export function freshFootageProject(): { dir: string; source: string } {
  const dir = mkdtempSync(join(tmpdir(), "footage-"));
  const dataRootPosix = join(dir, "data").split("\\").join("/");

  writeFileSync(
    join(dir, "project.yaml"),
    [
      "schema_version: harness.project-config/v1",
      "project_id: project-footage",
      "template_release: 0.1.0",
      "runtime: claude",
      `data_root: "${dataRootPosix}"`,
      "portfolios:",
      "  - { portfolio_id: portfolio-main, display_name: Footage portfolio }",
      "resources: { cpu: 2, gpu: 1, heygen: 1 }",
      "source: { materialize: link }",
      "",
    ].join("\n"),
  );

  mkdirSync(join(dir, "executors"), { recursive: true });
  writeFileSync(join(dir, "executors", "scripts.yaml"), scriptsYaml());

  const rawDir = join(dir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const source = join(rawDir, "sample-5s.mp4");
  makeVideo(source, { seconds: 5, audio: true });

  mkdirSync(join(dir, "source-catalog"), { recursive: true });
  writeFileSync(
    join(dir, "source-catalog", "sources.yaml"),
    ["schema_version: harness.sources/v1", "sources:", "  - { path: raw/sample-5s.mp4, collection: main, rights_status: cleared, language: vi }", ""].join("\n"),
  );

  const migrate = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", dir, "db", "migrate"], { encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`db migrate failed: ${migrate.stderr}`);

  return { dir, source };
}

export function cli(project: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_LOG_LEVEL: "error", HARNESS_SECRET_HEYGEN_MAIN: "heygen-secret-KEY-42", ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

export function cliAsync(project: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], {
      env: { ...process.env, HARNESS_LOG_LEVEL: "error", HARNESS_SECRET_HEYGEN_MAIN: "heygen-secret-KEY-42", ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/** Drain the queue: `worker --once` until it reports "idle". Returns each call's result in order. */
export function drain(project: string, env: Record<string, string> = {}, max = 30): string[] {
  const results: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = cli(project, ["worker", "--once"], env);
    results.push(r.out);
    if (r.out.includes("idle")) break;
  }
  return results;
}

export function status(project: string, runId: string): StatusJson {
  return JSON.parse(cli(project, ["status", runId, "--json"]).out) as StatusJson;
}

export function stageId(project: string, runId: string, key: string): string {
  const s = status(project, runId).stages.find((st) => st.stage_key === key);
  if (!s) throw new Error(`stage ${key} not found on run ${runId}`);
  return s.stage_run_id;
}

function workspacePathFromUri(uri: string): string {
  const u = new URL(uri);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // file:///E:/... -> E:/...
  return p;
}

/** Write `files` into the last attempt's workspace `output/`, then `harness stage submit`; asserts exit 0. */
export function submitGate(project: string, runId: string, key: string, files: Record<string, string>): void {
  const st = status(project, runId).stages.find((s) => s.stage_key === key);
  if (!st) throw new Error(`stage ${key} not found on run ${runId}`);
  const lastAttempt = st.attempts.at(-1);
  if (!lastAttempt?.workspace_uri) throw new Error(`stage ${key} has no attempt workspace on run ${runId}`);
  const outputDir = join(workspacePathFromUri(lastAttempt.workspace_uri), "output");
  mkdirSync(outputDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outputDir, name), content);
  const r = cli(project, ["stage", "submit", st.stage_run_id]);
  if (r.code !== 0) throw new Error(`stage submit ${key} (${st.stage_run_id}) failed: ${r.err}\n${r.out}`);
}

/** Rewrite `project.yaml`'s gpu resource capacity in place. Used to briefly starve the tts stage of the
 * gpu slot while draining unrelated gate stages, so a plain `worker --once` cannot jump the queue and
 * execute tts ahead of schedule (claim() skips a resource-starved candidate and falls through to the next
 * ready stage, regardless of ready_at order). */
export function setGpuCapacity(project: string, gpu: number): void {
  const path = join(project, "project.yaml");
  const text = readFileSync(path, "utf8").replace(/resources: \{[^}]*\}/, `resources: { cpu: 2, gpu: ${gpu}, heygen: 1 }`);
  writeFileSync(path, text);
}

export function planFootage(project: string, contentId: string, options: string[]): string {
  const args = ["plan", "--workflow", "footage-production@1.0.0", "--profile", "footage", "--content", contentId, ...options.flatMap((o) => ["--option", o]), "--json"];
  const { run_id } = JSON.parse(cli(project, args).out) as { run_id: string };
  cli(project, ["enqueue", run_id]);
  return run_id;
}

export const SAMPLE_EDL = (sourceId: string): string =>
  JSON.stringify({
    schema_version: "harness.edl/v1",
    entries: [
      { source_id: sourceId, in: 0, out: 2, order: 0 },
      { source_id: sourceId, in: 2, out: 4.5, order: 1, overlay: "avatar" },
    ],
  });
