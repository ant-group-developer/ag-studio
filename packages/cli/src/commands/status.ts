import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { print, withContext } from "./shared.js";
export function registerStatus(program: Command): void {
  program.command("status <run_id>").option("--json", "machine output", false).description("show run, stages, attempts, artifacts and cost").action(async (runId: string, o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const run = ctx.store.getRun(runId);
      if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
      const stages = ctx.store.listStageRuns(runId).map((s) => ({ ...s, attempts: ctx.store.listAttempts(s.stage_run_id), lease: ctx.store.getLease(s.stage_run_id) ?? null }));
      const artifacts = ctx.store.listArtifacts({ run_id: runId });
      print(o.json, { run, stages, artifacts }, () => [
        `${run.run_id}  ${run.state}  cost=$${run.total_cost_usd.toFixed(2)}  workflow=${run.workflow_release.id}@${run.workflow_release.version}  profile=${run.profile_snapshot.id}@${run.profile_snapshot.revision}`,
        ...stages.map((s) => `  ${s.stage_key.padEnd(12)} ${s.state.padEnd(20)} attempts=${s.attempt_count} failures=${s.result_failures}${s.lease ? ` lease=${s.lease.owner}#${s.lease.fencing_token}` : ""}${s.last_failure_kind ? ` last=${s.last_failure_kind}` : ""}`),
        ...artifacts.map((a) => `  artifact ${a.artifact_id} ${a.status.padEnd(11)} ${a.type} ${a.checksum.slice(0, 19)}`),
      ].join("\n"));
    });
  });
}
