import type { Command } from "commander";
import { reconcileOperation, reconcileRun } from "@harness/core";
import { print, withContext } from "./shared.js";
export function registerReconcile(program: Command): void {
  program.command("reconcile <id>").option("--json", "machine output", false).description("reconcile NEEDS_RECONCILIATION operations for a run_id or a single op_id").action(async (id: string, o, cmd) => {
    await withContext(cmd, {}, async (ctx) => {
      const deps = { store: ctx.store, provider: ctx.provider, planner: ctx.planner, clock: ctx.clock };
      const report = id.startsWith("op_") ? [await reconcileOperation(deps, id)] : await reconcileRun(deps, id);
      print(o.json, report, () => report.length ? report.map((r) => `${r.operation_id} ${r.status} stage=${r.stage_key} -> ${r.stageState}`).join("\n") : "nothing to reconcile");
    });
  });
}
