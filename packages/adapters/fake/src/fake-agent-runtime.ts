import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHarnessError, type AgentRuntime, type AgentTask, type ExecutorContext, type ExternalOperation, type StageResult } from "@harness/contracts";

/** Minimal journal contract the runtime needs; implemented by core's ExternalOperationJournal (Task 14). */
export interface JournalLike {
  recordIntent(p: { request: AgentTask["request"]; provider: string; kind: string; target: string; payload: Record<string, unknown> }): ExternalOperation;
  dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<ExternalOperation>;
  findConfirmedByKey(key: string): ExternalOperation | undefined;
  keyFor(p: { kind: string; target: string; payload: Record<string, unknown> }): string;
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly version = "0.1.0";
  constructor(private readonly opts: { journal?: JournalLike } = {}) {}

  async runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult> {
    const { request } = task;
    const externalOps: string[] = [];
    const cfg = request.stage_config as { external_operation?: boolean };
    if (cfg.external_operation && this.opts.journal) {
      const j = this.opts.journal;
      const payload = { skill: task.skill, stage_run_id: request.stage_run_id };
      const existing = j.findConfirmedByKey(j.keyFor({ kind: "fake-publish", target: request.stage_key, payload }));
      if (existing) {
        externalOps.push(existing.operation_id);
        ctx.logger.info("reusing confirmed external operation", { operation_id: existing.operation_id });
      } else {
        const intent = j.recordIntent({ request, provider: "fake-provider", kind: "fake-publish", target: request.stage_key, payload });
        try {
          const done = await j.dispatch(intent, payload);
          externalOps.push(done.operation_id);
        } catch (e) {
          if (isHarnessError(e, "CONNECTION_LOST")) {
            return { schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "unknown", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [intent.operation_id], errors: [{ kind: "unknown", message: e.message, details: { operation_id: intent.operation_id } }] };
          }
          throw e;
        }
      }
    }
    const content = `notes from ${task.skill}: ${task.brief} | inputs=${request.inputs.map((i) => i.type).join(",")}`;
    mkdirSync(join(task.workspaceDir, "output"), { recursive: true });
    writeFileSync(join(task.workspaceDir, "output", "notes.txt"), content);
    return {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
      outputs: [{ path: "output/notes.txt", type: "review_notes", checksum: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`, size_bytes: Buffer.byteLength(content, "utf8"), kind: "file" }],
      checks: [], usage: { wall_seconds: 0.1, cost_usd: 0.02 }, external_operations: externalOps, errors: [],
    };
  }
}
