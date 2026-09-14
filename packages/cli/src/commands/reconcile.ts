import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { reconcileOperation, reconcilePublication, reconcileRun } from "@harness/core";
import { print, withContext } from "./shared.js";

export function registerReconcile(program: Command): void {
  program.command("reconcile [id]")
    .option("--publication <job>", "reconcile a publication job stuck in NEEDS_RECONCILIATION instead of an operation/run")
    .option("--json", "machine output", false)
    .description("reconcile NEEDS_RECONCILIATION operations for a run_id or a single op_id, or (--publication) a stuck publication job")
    .action(async (id: string | undefined, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        if (o.publication) {
          const report = await reconcilePublication({ store: ctx.store, publisher: ctx.publisher, channels: ctx.channels, journal: ctx.journal, planner: ctx.planner, clock: ctx.clock }, o.publication);
          print(o.json, report, () => `${report.job_id} ${report.from} -> ${report.to} video=${report.video_id ?? "-"}`);
          return;
        }
        if (!id) throw new HarnessError("CONFIG_INVALID", "reconcile requires <id> (a run_id or op_id) or --publication <job>", {});
        const deps = { store: ctx.store, provider: ctx.provider, planner: ctx.planner, clock: ctx.clock };
        const report = id.startsWith("op_") ? [await reconcileOperation(deps, id)] : await reconcileRun(deps, id);
        print(o.json, report, () => report.length ? report.map((r) => `${r.operation_id} ${r.status} stage=${r.stage_key} -> ${r.stageState}`).join("\n") : "nothing to reconcile");
      });
    });
}
