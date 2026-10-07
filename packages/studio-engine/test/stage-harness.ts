/** Runs one in-process stage on a throwaway workspace: inputs written as files, outputs read back. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type ExecutorContext, type StageRequest } from "@harness/contracts";
import type { InProcessStage } from "@harness/executors";

export type StageInput =
  | { type: string; name: string; json: unknown }
  | { type: string; name: string; dir: string };

export interface StageRun {
  request: StageRequest;
  ctx: ExecutorContext;
  logs: { level: string; msg: string; fields?: unknown }[];
  output(name: string): string;
  json<T = unknown>(name: string): T;
  has(name: string): boolean;
}

export function stageWorkspace(p: { runId: string; stageKey?: string; inputs?: StageInput[]; options?: Record<string, unknown> }): StageRun {
  const ws = mkdtempSync(join(tmpdir(), "studio-stage-"));
  const inputs: StageRequest["inputs"] = [];
  for (const i of p.inputs ?? []) {
    const rel = `in/${i.name}`;
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if ("json" in i) {
      writeFileSync(abs, JSON.stringify(i.json));
      inputs.push({ path: rel, type: i.type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" } as StageRequest["inputs"][number]);
    } else {
      cpSync(i.dir, abs, { recursive: true });
      inputs.push({ path: rel, type: i.type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "directory" } as StageRequest["inputs"][number]);
    }
  }
  const request = {
    schema_version: "harness.stage-request/v1", run_id: p.runId, stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "ag-studio", portfolio_id: "studio", stage_key: p.stageKey ?? "stage",
    workflow: { id: "ag-studio-episode-cut", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs, workspace_uri: ws, stage_config: {}, options: p.options ?? {}, source_items: [], resources: [], expected_outputs: [],
    limits: { deadline_at: new Date(Date.now() + 600_000).toISOString(), max_cost_usd: 0, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
  const logs: StageRun["logs"] = [];
  const logger = {
    info: (msg: string, fields?: unknown) => logs.push({ level: "info", msg, fields }),
    warn: (msg: string, fields?: unknown) => logs.push({ level: "warn", msg, fields }),
    error: (msg: string, fields?: unknown) => logs.push({ level: "error", msg, fields }),
  };
  const ctx = { workspaceDir: ws, logger, clock: { now: () => new Date().toISOString() } } as unknown as ExecutorContext;
  const output = (name: string) => join(ws, "output", name);
  return {
    request, ctx, logs, output,
    has: (name) => existsSync(output(name)),
    json: <T>(name: string) => JSON.parse(readFileSync(output(name), "utf8")) as T,
  };
}

export async function runStage(stage: InProcessStage | undefined, run: StageRun): Promise<void> {
  if (!stage) throw new Error("no such stage");
  await stage(run.request, run.ctx);
}
