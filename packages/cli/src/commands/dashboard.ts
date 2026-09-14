import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { startDashboard } from "@harness/dashboard";
import { writeDashboardSnapshot } from "../composition.js";
import { print, withContext } from "./shared.js";

export function registerDashboard(program: Command): void {
  const cmd = program.command("dashboard").description("file-based dashboard (design §6): snapshot + read-only local server");

  cmd
    .command("snapshot")
    .option("--json", "print the written snapshot instead of its path", false)
    .description("write dashboard/snapshot.json from the current state")
    .action(async (o, sub) => {
      await withContext(sub, {}, async (ctx) => {
        const path = await writeDashboardSnapshot(ctx);
        if (o.json) print(true, JSON.parse(readFileSync(path, "utf8")), () => "");
        else process.stdout.write(`${path}\n`);
      });
    });

  cmd
    .command("serve")
    .option("--port <n>", "override HARNESS_DASHBOARD_PORT / project.yaml dashboard.port")
    .description("write a snapshot then serve the dashboard on 127.0.0.1 until Ctrl+C")
    .action(async (o, sub) => {
      await withContext(sub, {}, async (ctx) => {
        await writeDashboardSnapshot(ctx);
        // design §6.2: --port > HARNESS_DASHBOARD_PORT > project.yaml.dashboard.port (already 5200 by default).
        const envPort = process.env.HARNESS_DASHBOARD_PORT ? Number(process.env.HARNESS_DASHBOARD_PORT) : undefined;
        const port = o.port !== undefined ? Number(o.port) : (envPort ?? ctx.dashboard.port);
        const server = await startDashboard({ dataRoot: ctx.dataRoot, port });
        process.stdout.write(`${server.url}\n`);
        await new Promise<void>((resolve) => {
          const shutdown = () => { server.close().then(resolve, resolve); };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
      });
    });
}
