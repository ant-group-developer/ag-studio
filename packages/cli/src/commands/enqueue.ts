import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerEnqueue(program: Command): void {
  program.command("enqueue <run_id>").description("mark a DRAFT run READY and release root stages").action(async (runId: string, _o, cmd) => {
    await withContext(cmd, {}, (ctx) => { ctx.planner.enqueue(runId); process.stdout.write(`${runId} READY\n`); });
  });
}
