#!/usr/bin/env node
import { Command } from "commander";
import { isHarnessError } from "@harness/contracts";
import { registerDb } from "./commands/db.js";
import { registerPlan } from "./commands/plan.js";
import { registerEnqueue } from "./commands/enqueue.js";
import { registerWorker } from "./commands/worker.js";
import { registerStatus } from "./commands/status.js";
import { registerRetry } from "./commands/retry.js";
import { registerCancel } from "./commands/cancel.js";
import { registerReconcile } from "./commands/reconcile.js";
import { registerLeases } from "./commands/leases.js";
import { registerWorkspaces } from "./commands/workspaces.js";
import { registerEvents } from "./commands/events.js";
import { registerArtifacts } from "./commands/artifacts.js";
import { registerSource } from "./commands/source.js";
import { registerContent } from "./commands/content.js";
import { registerResources } from "./commands/resources.js";
import { registerOp } from "./commands/op.js";
import { registerStage } from "./commands/stage.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerLibrary } from "./commands/library.js";

const program = new Command("harness").description("YouTube Operations Harness control plane").option("--project <dir>", "operations project directory", process.env.HARNESS_PROJECT ?? process.cwd());
for (const reg of [registerDb, registerPlan, registerEnqueue, registerWorker, registerStatus, registerRetry, registerCancel, registerReconcile, registerLeases, registerWorkspaces, registerEvents, registerArtifacts, registerSource, registerContent, registerResources, registerOp, registerStage, registerDoctor, registerLibrary]) reg(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  if (isHarnessError(e)) process.stderr.write(`${e.code}: ${e.message}\n`);
  else process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
