import { hostname } from "node:os";
import type { Command } from "commander";
import type { AutoAcceptDeps } from "@harness/core";
import { Worker } from "@harness/worker";
import type { AppContext } from "../composition.js";
import { writeDashboardSnapshot } from "../composition.js";
import { withContext } from "./shared.js";

/** Built only when this project is studio-role and `library.auto_accept.enabled` -- everything `autoAccept`
 * needs beyond `store`/`fs`/`clock`/`logger` (the `Worker` supplies those itself, see `WorkerDeps.library`).
 * Profile is fixed at "studio" (spec's own note allows an optional `auto_accept.profile_id`, but the studio
 * profile is the only one `library-production@1.0.0` ships with, so a config knob for it would be unused). */
function autoAcceptDepsFor(ctx: AppContext): Omit<AutoAcceptDeps, "store" | "fs" | "clock" | "logger"> | undefined {
  const config = ctx.library?.role === "studio" ? ctx.library.autoAccept : undefined;
  if (!config?.enabled) return undefined;
  return {
    catalog: ctx.catalog, planner: ctx.planner, harness: ctx.harness, projectId: ctx.project.project_id,
    portfolioId: ctx.project.portfolios[0]!.portfolio_id, profile: ctx.profiles("studio"), workflows: ctx.workflows,
    executorVersionFor: ctx.executorVersionFor,
    requiresResourcesOverride: (s) => (s.executor.type === "script" ? ctx.scripts?.scripts[s.executor.script]?.requires_resources : undefined),
    config,
  };
}

export function registerWorker(program: Command): void {
  program.command("worker").description("claim and execute stages")
    .option("--once", "process at most one stage then exit", false).option("--capabilities <list>", "comma separated", "write_workspace,read_source").option("--owner <name>", "lease owner", `${hostname()}-${process.pid}`)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        // `ctx.publication`/`ctx.dashboard` (AppContext's own config shapes) are not WorkerDeps.publication/
        // .dashboard (a Publisher+ChannelRegistry bundle; a refresh callback) -- excluded from the base spread
        // below so the `publication`/`dashboard` keys re-added afterwards are the only source of those keys.
        // `ctx.library` is excluded the same way: its `autoAccept` is the raw `AutoAcceptConfig`, not the full
        // `AutoAcceptDeps` shape `WorkerDeps.library.autoAccept` needs, so it must not leak through the spread
        // and be unioned against the explicit `library` object built below.
        const { publication: _appPublicationConfig, dashboard: _appDashboardConfig, library: _appLibraryConfig, ...workerBase } = ctx;
        const autoAccept = autoAcceptDepsFor(ctx);
        const worker = new Worker({
          ...workerBase, harness: ctx.harness, project: ctx.project, dataRoot: ctx.dataRoot, owner: o.owner, capabilities: String(o.capabilities).split(",").map((s: string) => s.trim()).filter(Boolean),
          logger: ctx.logger, clock: ctx.clock, profiles: ctx.profiles, resourceCapacity: ctx.resourceCapacity,
          ...(ctx.library ? { library: { fs: ctx.library.fs, role: ctx.library.role, syncSeconds: ctx.library.syncSeconds, ...(autoAccept ? { autoAccept } : {}) } } : {}),
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
