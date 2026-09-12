import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadProfile } from "@harness/core";
import { print, withContext } from "./shared.js";

function parseOverrides(list: string[], { coerce }: { coerce: boolean } = { coerce: true }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    if (i < 1) throw new HarnessError("CONFIG_INVALID", `override must be key=value, got "${kv}"`, { kv });
    const k = kv.slice(0, i); const raw = kv.slice(i + 1);
    out[k] = !coerce ? raw : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
  }
  return out;
}
export function registerPlan(program: Command): void {
  program.command("plan").description("create a DRAFT run from a workflow release and profile")
    .requiredOption("--workflow <id@version>").requiredOption("--profile <id>").option("--source <src_id>").option("--portfolio <id>").option("--content <content_id>")
    .option("--override <k=v>", "run override (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--option <k=v>", "variant option (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--json", "machine output", false)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const profile = loadProfile(HARNESS_ROOT, o.profile);
        let content, variant;
        if (o.content) {
          content = ctx.store.getContentItem(o.content);
          if (!content) throw new HarnessError("NOT_FOUND", `content not found: ${o.content}`, { content_id: o.content });
          variant = ctx.catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: parseOverrides(o.option, { coerce: false }) }).variant;
        } else if (o.option.length) throw new HarnessError("CONFIG_INVALID", "--option requires --content", {});
        const run = ctx.planner.plan({ workflow: ctx.workflows(o.workflow), profile, harness: ctx.harness, projectId: ctx.project.project_id, portfolioId: o.portfolio ?? ctx.project.portfolios[0]!.portfolio_id, runOverrides: parseOverrides(o.override), ...(o.source ? { sourceId: o.source } : {}), ...(content ? { content } : {}), ...(variant ? { variant } : {}) });
        const created = ctx.store.listEvents({ run_id: run.run_id, limit: 1 })[0];
        print(o.json, { run_id: run.run_id, state: run.state, digest: run.effective_config_digest, variant_id: run.variant_id ?? null, skipped_stages: created?.payload.skipped_stages ?? [] }, () => `${run.run_id} (${run.state})${run.variant_id ? " variant " + run.variant_id : ""} config ${run.effective_config_digest.slice(0, 19)}`);
      });
    });
}
