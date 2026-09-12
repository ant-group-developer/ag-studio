import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { withContext } from "./shared.js";

const TERMINAL_STAGE_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export function registerWorkspaces(program: Command): void {
  const ws = program.command("workspaces").description("workspace maintenance");
  ws.command("prune")
    .option("--days <n>", "override retention.workspace_days")
    .option("--force", "also delete directories that have no attempt row", false)
    .description("delete attempt workspaces older than retention; keeps anything still owned by a live or non-terminal stage")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const days = o.days ? Number(o.days) : ctx.harness.retention.workspace_days;
        const cutoff = Date.now() - days * 86_400_000;
        const root = join(ctx.dataRoot, "workspaces");
        let removed = 0;
        let skipped = 0;
        for (const run of safeList(root)) for (const stage of safeList(join(root, run))) for (const attempt of safeList(join(root, run, stage))) {
          const dir = join(root, run, stage, attempt);
          if (statSync(dir).mtimeMs >= cutoff) { skipped++; continue; }
          const row = ctx.store.getAttempt(attempt);
          if (!row) { if (o.force) { rmSync(dir, { recursive: true, force: true }); removed++; } else skipped++; continue; }
          const stageRun = ctx.store.getStageRun(row.stage_run_id);
          if (!stageRun || !TERMINAL_STAGE_STATES.has(stageRun.state) || ctx.store.getLease(row.stage_run_id)) { skipped++; continue; }
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
        process.stdout.write(`removed ${removed}, skipped ${skipped} workspace(s) older than ${days} day(s)\n`);
      });
    });
}
function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
