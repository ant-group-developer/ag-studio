import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerLeases(program: Command): void {
  const leases = program.command("leases").description("lease maintenance");
  leases.command("reap").description("abandon expired leases and requeue their stages").action(async (_o, cmd) => {
    await withContext(cmd, {}, (ctx) => { const r = ctx.store.reapExpiredLeases(ctx.clock.now()); process.stdout.write(r.length ? r.map((x) => `${x.stage_run_id} owner=${x.owner} requeued=${x.requeued}`).join("\n") + "\n" : "no expired leases\n"); });
  });
}
