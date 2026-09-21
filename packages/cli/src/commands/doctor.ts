import type { Command } from "commander";
import { computeDoctorRows } from "../composition.js";
import { print, withContext } from "./shared.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .option("--json", "machine output", false)
    .description("check the project and harness install (workflows, profiles, scripts, resources, sources) for consistency")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const rows = await computeDoctorRows(ctx);
        print(o.json, rows, () => rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.check.padEnd(42)} ${r.detail}`).join("\n"));
        if (rows.some((r) => !r.ok)) process.exitCode = 1;
      });
    });
}
