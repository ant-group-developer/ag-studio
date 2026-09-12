import type { Command } from "commander";
import { sweepOrphanArtifacts } from "@harness/core";
import { print, withContext } from "./shared.js";
export function registerArtifacts(program: Command): void {
  const artifacts = program.command("artifacts").description("artifact store maintenance");
  artifacts.command("sweep").option("--older-than-minutes <n>", "only directories older than this", "60").option("--dry-run", "report only", false).option("--json", "machine output", false)
    .description("remove artifact directories with no accepted row behind them").action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const report = sweepOrphanArtifacts({ store: ctx.store, dataRoot: ctx.dataRoot, now: ctx.clock.now(), olderThanSeconds: Number(o.olderThanMinutes) * 60, dryRun: Boolean(o.dryRun) });
        print(o.json, report, () => `scanned ${report.scanned}, ${o.dryRun ? "would remove" : "removed"} ${report.removed.length}, kept ${report.kept.length}` + (report.removed.length ? "\n" + report.removed.join("\n") : ""));
      });
    });
}
