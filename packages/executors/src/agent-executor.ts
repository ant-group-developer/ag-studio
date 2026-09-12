import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, Executor, ExecutorContext, StageRequest, StageResult } from "@harness/contracts";

export class AgentExecutor implements Executor {
  readonly version: string;
  constructor(private readonly runtime: AgentRuntime) { this.version = `agent-executor@0.1.0+${runtime.name}@${runtime.version}`; }
  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const skill = String(request.stage_config.__skill ?? "");
    const brief = String(request.stage_config.__brief ?? "");
    const result = await this.runtime.runTask({ skill, brief, request, workspaceDir: ctx.workspaceDir }, ctx);
    writeFileSync(join(ctx.workspaceDir, "stage-result.json"), JSON.stringify(result, null, 2));
    return result;
  }
}
