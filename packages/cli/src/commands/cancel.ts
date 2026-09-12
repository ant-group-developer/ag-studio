import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerCancel(program: Command): void {
  program.command("cancel <run_id>").description("cancel a run; running attempts finish via CANCEL_REQUESTED").action(async (runId: string, _o, cmd) => {
    await withContext(cmd, {}, (ctx) => { ctx.planner.cancel(runId); process.stdout.write(`${runId} ${ctx.store.getRun(runId)?.state}\n`); });
  });
}
