import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { eventFor, raiseBudget } from "@harness/core";
import { withContext } from "./shared.js";
export function registerRetry(program: Command): void {
  program.command("retry <run_id>").option("--stage <key>").option("--raise-budget <usd>").description("move FAILED or WAITING_HUMAN stages back to READY").action(async (runId: string, o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const run = ctx.store.getRun(runId);
      if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
      if (run.state === "FAILED" || run.state === "CANCELLED" || run.state === "CANCEL_REQUESTED") throw new HarnessError("INVALID_TRANSITION", `run is ${run.state}; ${run.state === "CANCEL_REQUESTED" ? "finish the cancel first" : "plan a new run instead"}`, { runId, state: run.state });
      if (o.raiseBudget !== undefined) {
        const budgetUsd = Number(o.raiseBudget);
        if (!Number.isFinite(budgetUsd)) throw new HarnessError("CONFIG_INVALID", `--raise-budget must be a finite number: ${o.raiseBudget}`, { value: o.raiseBudget });
        const from = run.budget_usd ?? "none";
        const raised = raiseBudget(ctx.store, ctx.planner, runId, budgetUsd);
        process.stdout.write(`budget ${from} -> ${raised.budget_usd}\n`);
      }
      const moved: string[] = [];
      ctx.store.transaction(() => {
        const current = ctx.store.getRun(runId)!;
        for (const s of ctx.store.listStageRuns(runId)) {
          if (o.stage && s.stage_key !== o.stage) continue;
          if (s.state !== "FAILED" && s.state !== "WAITING_HUMAN") continue;
          ctx.store.transition("stage_run", s.stage_run_id, s.state, "READY", eventFor(run, s, null, "stage.manual_retry", "warn", { by: "cli" }));
          const fresh = ctx.store.getStageRun(s.stage_run_id)!;
          ctx.store.updateStageRun({ ...fresh, ready_at: ctx.clock.now(), not_before: ctx.clock.now() });
          moved.push(s.stage_key);
        }
        if (moved.length && current.state === "WAITING") ctx.planner.advance(runId);
      });
      process.stdout.write(moved.length ? `READY: ${moved.join(", ")}\n` : "nothing to retry\n");
    });
  });
}
