import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "@harness/core";
import { print, withContext } from "./shared.js";

function parseOverrides(list: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    if (i < 1) throw new HarnessError("CONFIG_INVALID", `override must be key=value, got "${kv}"`, { kv });
    const k = kv.slice(0, i); const raw = kv.slice(i + 1);
    out[k] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
  }
  return out;
}
export function registerPlan(program: Command): void {
  program.command("plan").description("create a DRAFT run from a workflow release and profile")
    .requiredOption("--workflow <id@version>").requiredOption("--profile <id>").option("--source <src_id>").option("--portfolio <id>")
    .option("--override <k=v>", "run override (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[]).option("--json", "machine output", false)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const run = ctx.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, o.workflow), profile: loadProfile(HARNESS_ROOT, o.profile), harness: ctx.harness, projectId: ctx.project.project_id, portfolioId: o.portfolio ?? ctx.project.portfolios[0]!.portfolio_id, runOverrides: parseOverrides(o.override), ...(o.source ? { sourceId: o.source } : {}) });
        print(o.json, { run_id: run.run_id, state: run.state, digest: run.effective_config_digest }, () => `${run.run_id} (${run.state}) config ${run.effective_config_digest.slice(0, 19)}`);
      });
    });
}
