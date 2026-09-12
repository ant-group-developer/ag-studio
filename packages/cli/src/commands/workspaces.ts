import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerWorkspaces(program: Command): void {
  const ws = program.command("workspaces").description("workspace maintenance");
  ws.command("prune").option("--days <n>", "override retention.workspace_days").description("delete attempt workspaces older than retention").action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const days = o.days ? Number(o.days) : ctx.harness.retention.workspace_days;
      const cutoff = Date.now() - days * 86_400_000;
      const root = join(ctx.dataRoot, "workspaces");
      let removed = 0;
      for (const run of safeList(root)) for (const stage of safeList(join(root, run))) for (const attempt of safeList(join(root, run, stage))) {
        const dir = join(root, run, stage, attempt);
        if (statSync(dir).mtimeMs < cutoff && !ctx.store.getLease(ctx.store.getAttempt(attempt)?.stage_run_id ?? "")) { rmSync(dir, { recursive: true, force: true }); removed++; }
      }
      process.stdout.write(`removed ${removed} workspace(s) older than ${days} day(s)\n`);
    });
  });
}
function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
