import { hostname } from "node:os";
import type { Command } from "commander";
import { Worker, type WorkerDeps } from "@harness/worker";
import type { AppContext } from "../composition.js";
import { withContext } from "./shared.js";

export function registerWorker(program: Command): void {
  program.command("worker").description("claim and execute stages")
    .option("--once", "process at most one stage then exit", false).option("--capabilities <list>", "comma separated", "write_workspace,read_source").option("--owner <name>", "lease owner", `${hostname()}-${process.pid}`)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const base: WorkerDeps = {
          store: ctx.store, planner: ctx.planner, controller: ctx.controller, registry: ctx.registry, verifier: ctx.verifier,
          executors: ctx.executors, harness: ctx.harness, project: ctx.project, dataRoot: ctx.dataRoot,
          owner: o.owner, capabilities: String(o.capabilities).split(",").map((s: string) => s.trim()).filter(Boolean),
          logger: ctx.logger, clock: ctx.clock, workflows: ctx.workflows, profiles: ctx.profiles, resourceCapacity: ctx.resourceCapacity,
        };
        if (ctx.library) base.library = { fs: ctx.library.fs, role: ctx.library.role, syncSeconds: ctx.library.syncSeconds };
        const worker = new Worker(base);
        if (o.once) { process.stdout.write(`${await worker.runOnce()}\n`); return; }
        const ac = new AbortController();
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { ctx.logger.warn(`received ${sig}, cancelling current attempt`); ac.abort(); });
        await worker.runForever(ac.signal);
      });
    });
}
