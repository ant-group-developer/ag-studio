import { hostname } from "node:os";
import type { Command } from "commander";
import { Worker } from "@harness/worker";
import { writeDashboardSnapshot } from "../composition.js";
import { withContext } from "./shared.js";
export function registerWorker(program: Command): void {
  program.command("worker").description("claim and execute stages")
    .option("--once", "process at most one stage then exit", false).option("--capabilities <list>", "comma separated", "write_workspace,read_source").option("--owner <name>", "lease owner", `${hostname()}-${process.pid}`)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        // `ctx.publication`/`ctx.dashboard` (AppContext's own config shapes) are not WorkerDeps.publication/
        // .dashboard (a Publisher+ChannelRegistry bundle; a refresh callback) -- excluded from the base spread
        // below so the `publication`/`dashboard` keys re-added afterwards are the only source of those keys.
        const { publication: _appPublicationConfig, dashboard: _appDashboardConfig, ...workerBase } = ctx;
        const worker = new Worker({
          ...workerBase, harness: ctx.harness, project: ctx.project, dataRoot: ctx.dataRoot, owner: o.owner, capabilities: String(o.capabilities).split(",").map((s: string) => s.trim()).filter(Boolean),
          logger: ctx.logger, clock: ctx.clock, profiles: ctx.profiles, resourceCapacity: ctx.resourceCapacity, ...(ctx.library ? { library: ctx.library } : {}),
          dashboard: { refreshSeconds: ctx.dashboard.refreshSeconds, write: async () => { await writeDashboardSnapshot(ctx); } },
          ...(ctx.channels.list().length > 0 ? { publication: { publisher: ctx.publisher, channels: ctx.channels, verifySeconds: ctx.publication.verifySeconds, graceHours: ctx.publication.graceHours } } : {}),
        });
        if (o.once) { process.stdout.write(`${await worker.runOnce()}\n`); return; }
        const ac = new AbortController();
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { ctx.logger.warn(`received ${sig}, cancelling current attempt`); ac.abort(); });
        await worker.runForever(ac.signal);
      });
    });
}
