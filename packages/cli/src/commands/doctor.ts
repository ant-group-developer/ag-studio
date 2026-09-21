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
        // An operator running `harness doctor` by hand wants ground truth, not a cached media probe from up
        // to MEDIA_PROBE_TTL_SECONDS ago -- explicit here even though "fresh" is computeDoctorRows's default
        // (see writeDashboardSnapshot's "cached" for the dashboard-refresh path).
        const rows = await computeDoctorRows(ctx, { mediaProbe: "fresh" });
        print(o.json, rows, () => rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.check.padEnd(42)} ${r.detail}`).join("\n"));
        if (rows.some((r) => !r.ok)) process.exitCode = 1;
      });
    });
}
