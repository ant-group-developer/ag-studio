import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Executor, ExecutorContext, StageRequest, StageResult } from "@harness/contracts";

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_none_\n";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}

function renderBrief(request: StageRequest): string {
  const brief = String(request.stage_config.__brief ?? "");
  const inputs = table(["type", "path"], request.inputs.map((i) => [i.type, i.path]));
  const outputs = table(["name", "type", "mime", "kind"], request.expected_outputs.map((o) => [o.name ? `output/${o.name}` : "", o.type, o.mime_type, o.kind]));
  const sourceItems = table(["id", "uri", "duration"], request.source_items.map((s) => [s.source_id, s.uri, String(s.duration_seconds ?? "")]));
  return [
    `# ${request.stage_key}`,
    "",
    brief,
    "",
    "## Inputs",
    "",
    inputs,
    "## Expected outputs",
    "",
    outputs,
    "## Options",
    "",
    "```json",
    JSON.stringify(request.options, null, 2),
    "```",
    "",
    "## Source items",
    "",
    sourceItems,
    "## Submit",
    "",
    "Place the expected output files under `output/` in this workspace, then run:",
    "",
    `    harness stage submit ${request.stage_run_id}`,
    "",
  ].join("\n");
}

export class GateExecutor implements Executor {
  readonly version = "gate-executor@0.1.0";

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    writeFileSync(join(ctx.workspaceDir, "brief.md"), renderBrief(request));
    return {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "deferred",
      outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [],
    };
  }
}
