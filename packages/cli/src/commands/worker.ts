import { hostname } from "node:os";
import type { Command } from "commander";
import type { ContentRequest, ProjectConfig } from "@harness/contracts";
import { autoPick, type AutoAcceptDeps, type AutoPickDeps, type LoadedChannel, planRequestsRun, type PlanRequestsDeps } from "@harness/core";
import { Worker, type WorkerDeps } from "@harness/worker";
import type { AppContext } from "../composition.js";
import { durationOfPackage, writeDashboardSnapshot } from "../composition.js";
import { requireLibrary } from "./library-stage.js";
import { withContext } from "./shared.js";

/** Built only when this project is studio-role and `library.auto_accept.enabled` -- everything `autoAccept`
 * needs beyond `store`/`fs`/`clock`/`logger` (the `Worker` supplies those itself, see `WorkerDeps.library`).
 * Profile is fixed at "studio" (spec's own note allows an optional `auto_accept.profile_id`, but the studio
 * profile is the only one `library-production@1.0.0` ships with, so a config knob for it would be unused). */
/**
 * The portfolio an auto-accepted run belongs to: the requesting portfolio (`requested_by.portfolio_id`) when
 * this project actually declares it, else the project's first portfolio. Auto-accepted runs used to be
 * stamped with the first portfolio unconditionally, which silently mis-attributed every run on a studio that
 * serves more than one portfolio; a request naming a portfolio this project does not know (the kho is shared
 * across machines, so that is a normal thing to see) still has to land somewhere, hence the fallback.
 */
export function portfolioForRequest(project: Pick<ProjectConfig, "portfolios">, request: ContentRequest): string {
  const requested = request.requested_by.portfolio_id;
  return project.portfolios.some((p) => p.portfolio_id === requested) ? requested : project.portfolios[0]!.portfolio_id;
}

function autoAcceptDepsFor(ctx: AppContext): Omit<AutoAcceptDeps, "store" | "fs" | "clock" | "logger"> | undefined {
  const config = ctx.library?.role === "studio" ? ctx.library.autoAccept : undefined;
  if (!config?.enabled) return undefined;
  return {
    catalog: ctx.catalog, planner: ctx.planner, harness: ctx.harness, projectId: ctx.project.project_id,
    portfolioId: ctx.project.portfolios[0]!.portfolio_id,
    portfolioFor: (request) => portfolioForRequest(ctx.project, request),
    profile: ctx.profiles("studio"), workflows: ctx.workflows,
    executorVersionFor: ctx.executorVersionFor,
    requiresResourcesOverride: (s) => (s.executor.type === "script" ? ctx.scripts?.scripts[s.executor.script]?.requires_resources : undefined),
    config,
  };
}

/** Shared `startPlannedRun` deps every `planRequestsRun`/`autoPick` call needs, for one channel: unlike
 * `autoAcceptDepsFor`'s studio-wide `portfolioId` fallback (a request may name a portfolio this project does
 * not know), a channel always declares its own `portfolio_id` in `channel.yaml` -- the same field
 * `library pick`'s own `--portfolio` default falls back to when a caller does not override it -- so that is
 * the only portfolio a channel's own auto-plan/auto-pick runs are ever attributed to. Exported for
 * `commands/channel.ts`'s one-shot `plan-requests`/`pick-next` commands to reuse verbatim. */
function startRunDepsFor(ctx: AppContext, channel: LoadedChannel) {
  return {
    store: ctx.store, catalog: ctx.catalog, planner: ctx.planner, harness: ctx.harness,
    projectId: ctx.project.project_id, portfolioId: channel.config.portfolio_id, workflows: ctx.workflows, executorVersionFor: ctx.executorVersionFor,
  };
}

/** `PlanRequestsDeps` for one channel (spec §4.3): `libraryItems`/`libraryClaimsOf` are read fresh on every
 * call (not cached at worker-start time) so a sweep always sees the kho's current approved items/claims,
 * mirroring `publish-stage.ts`'s own `demand` stage. */
export function planRequestsDepsFor(ctx: AppContext, channel: LoadedChannel): PlanRequestsDeps {
  const library = requireLibrary(ctx);
  return {
    ...startRunDepsFor(ctx, channel), clock: ctx.clock, channel, profile: ctx.profiles("channel-planning"),
    libraryItems: ctx.store.listLibraryItems({ status: "approved" }), libraryClaimsOf: (itemId: string) => library.fs.listClaims(itemId),
    logger: ctx.logger,
  };
}

/** `AutoPickDeps` for one channel (spec §4.4). */
export function autoPickDepsFor(ctx: AppContext, channel: LoadedChannel): AutoPickDeps {
  const library = requireLibrary(ctx);
  return {
    ...startRunDepsFor(ctx, channel), clock: ctx.clock, channel, fs: library.fs, profile: ctx.profiles("channel"),
    libraryItems: ctx.store.listLibraryItems({ status: "approved" }), logger: ctx.logger,
  };
}

/** Built only when the project has at least one loaded channel (spec §2.4/§4.3/§4.4): everything
 * `WorkerDeps.learning` needs. `planning.checkSeconds` is a single worker-level cadence computed from the
 * channels that actually have `planning.enabled` -- the brief's own resolution calls for the MIN of those, so
 * whichever enabled channel needs replanning soonest sets the pace for the sweep; a project with no channel
 * opted into planning gets an arbitrary (unused) fallback, since `maybePlanRequests` then never finds a
 * channel to act on regardless of cadence. */
function learningDepsFor(ctx: AppContext): WorkerDeps["learning"] | undefined {
  const channels = ctx.channels.list();
  if (channels.length === 0) return undefined;
  const planningEnabled = channels.filter((c) => c.config.planning.enabled);
  const checkSeconds = planningEnabled.length > 0 ? Math.min(...planningEnabled.map((c) => c.config.planning.check_seconds)) : 3600;
  return {
    channels: ctx.channels, collector: ctx.stats, collectSeconds: ctx.learning.collectSeconds, collectBatch: ctx.learning.collectBatch,
    durationOf: durationOfPackage,
    planning: { checkSeconds, run: (channel) => planRequestsRun(planRequestsDepsFor(ctx, channel)) },
    autoPick: { run: (channel) => autoPick(autoPickDepsFor(ctx, channel)) },
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
        const { publication: _appPublicationConfig, dashboard: _appDashboardConfig, library: _appLibraryConfig, learning: _appLearningConfig, ...workerBase } = ctx;
        const autoAccept = autoAcceptDepsFor(ctx);
        const learning = learningDepsFor(ctx);
        const worker = new Worker({
          ...workerBase, harness: ctx.harness, project: ctx.project, dataRoot: ctx.dataRoot, owner: o.owner, capabilities: String(o.capabilities).split(",").map((s: string) => s.trim()).filter(Boolean),
          logger: ctx.logger, clock: ctx.clock, profiles: ctx.profiles, resourceCapacity: ctx.resourceCapacity,
          ...(ctx.library ? { library: { fs: ctx.library.fs, role: ctx.library.role, syncSeconds: ctx.library.syncSeconds, ...(autoAccept ? { autoAccept } : {}) } } : {}),
          dashboard: { refreshSeconds: ctx.dashboard.refreshSeconds, write: async () => { await writeDashboardSnapshot(ctx); } },
          ...(ctx.channels.list().length > 0 ? { publication: { publisher: ctx.publisher, channels: ctx.channels, verifySeconds: ctx.publication.verifySeconds, graceHours: ctx.publication.graceHours } } : {}),
          ...(learning ? { learning } : {}),
        });
        if (o.once) { process.stdout.write(`${await worker.runOnce()}\n`); return; }
        const ac = new AbortController();
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { ctx.logger.warn(`received ${sig}, cancelling current attempt`); ac.abort(); });
        await worker.runForever(ac.signal);
      });
    });
}
