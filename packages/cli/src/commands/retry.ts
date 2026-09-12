import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { eventFor } from "@harness/core";
import { withContext } from "./shared.js";
export function registerRetry(program: Command): void {
  program.command("retry <run_id>").option("--stage <key>").description("move FAILED or WAITING_HUMAN stages back to READY").action(async (runId: string, o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const run = ctx.store.getRun(runId);
      if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
      if (run.state === "FAILED" || run.state === "CANCELLED") throw new HarnessError("INVALID_TRANSITION", `run is ${run.state} (terminal); plan a new run instead`, { runId, state: run.state });
      const moved: string[] = [];
      ctx.store.transaction(() => {
        for (const s of ctx.store.listStageRuns(runId)) {
          if (o.stage && s.stage_key !== o.stage) continue;
          if (s.state !== "FAILED" && s.state !== "WAITING_HUMAN") continue;
          ctx.store.transition("stage_run", s.stage_run_id, s.state, "READY", eventFor(run, s, null, "stage.manual_retry", "warn", { by: "cli" }));
          const fresh = ctx.store.getStageRun(s.stage_run_id)!;
          ctx.store.updateStageRun({ ...fresh, ready_at: ctx.clock.now(), not_before: ctx.clock.now() });
          moved.push(s.stage_key);
        }
        if (moved.length && run.state === "WAITING") ctx.planner.advance(runId);
      });
      process.stdout.write(moved.length ? `READY: ${moved.join(", ")}\n` : "nothing to retry\n");
    });
  });
}
