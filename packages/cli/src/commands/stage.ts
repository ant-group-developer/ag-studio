import type { Command } from "commander";
import { submitGate } from "@harness/core";
import { print, withContext } from "./shared.js";

export function registerStage(program: Command): void {
  const stage = program.command("stage").description("stage-level operations");
  stage.command("submit <stage_run_id>")
    .option("--from <dir>", "copy this directory into the gate workspace output/ first")
    .option("--json", "machine output", false)
    .description("submit the output of a WAITING_HUMAN gate stage: verify, then commit like a worker")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const r = await submitGate(
          { store: ctx.store, planner: ctx.planner, controller: ctx.controller, verifier: ctx.verifier, clock: ctx.clock, harness: ctx.harness, profiles: ctx.profiles, workflows: ctx.workflows },
          { stageRunId: id, ...(o.from ? { fromDir: o.from } : {}) },
        );
        print(o.json, r, () =>
          r.missing.length || r.failed.length
            ? ["submit rejected:", ...r.missing.map((m) => `  missing ${m}`), ...r.failed.map((f) => `  check ${f.check_id} failed ${JSON.stringify(f.evidence)}`)].join("\n")
            : `${id} ${r.stageState} (run ${r.runState}) artifacts=${r.artifacts.length}`);
        if (r.missing.length || r.failed.length) process.exitCode = 1;
      });
    });
}
