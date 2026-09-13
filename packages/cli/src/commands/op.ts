import type { Command } from "commander";
import { HarnessError, type ExternalOperation } from "@harness/contracts";
import { print, withContext } from "./shared.js";

/** `--payload`/`--receipt` are JSON objects on the command line; malformed or non-object JSON is a config error, not a crash. */
function jsonObject(raw: string, flag: string): Record<string, unknown> {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new HarnessError("CONFIG_INVALID", `${flag} must be valid JSON`, { flag, value: raw }); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HarnessError("CONFIG_INVALID", `${flag} must be a JSON object`, { flag, value: raw });
  return v as Record<string, unknown>;
}

/** `Number("abc")` is NaN; a NaN/negative cost would silently corrupt external_operation.cost_usd. */
function nonNegativeCost(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HarnessError("CONFIG_INVALID", "--cost-usd must be a non-negative number", { value: raw });
  return n;
}

function opOutput(op: ExternalOperation) { return { operation_id: op.operation_id, status: op.status, provider_ref: op.provider_ref, receipt: op.receipt }; }
function printOp(json: boolean, op: ExternalOperation) { print(json, opOutput(op), () => `${op.operation_id} ${op.status}`); }

export function registerOp(program: Command): void {
  const op = program.command("op").description("external-operation journal for wrapper scripts (see @harness/script-sdk ctx.op.*)");

  op.command("intent")
    .requiredOption("--attempt <attempt_id>", "attempt recording this intent")
    .requiredOption("--fencing-token <n>", "the attempt's current fencing token")
    .requiredOption("--provider <provider>")
    .requiredOption("--kind <kind>")
    .requiredOption("--target <target>")
    .option("--payload <json>", "JSON payload", "{}")
    .option("--json", "machine output", false)
    .description("record intent to perform an external effect before making the call")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const attempt = ctx.store.getAttempt(o.attempt);
        if (!attempt) throw new HarnessError("NOT_FOUND", `attempt not found: ${o.attempt}`, { attempt_id: o.attempt });
        ctx.store.assertFencing(attempt.stage_run_id, Number(o.fencingToken));
        const payload = jsonObject(o.payload, "--payload");
        const key = ctx.journal.keyFor({ kind: o.kind, target: o.target, payload });
        const confirmed = ctx.journal.findConfirmedByKey(key);
        const result = confirmed ?? ctx.journal.recordIntent({
          request: { run_id: attempt.run_id, stage_run_id: attempt.stage_run_id, attempt_id: attempt.attempt_id },
          provider: o.provider, kind: o.kind, target: o.target, payload,
        });
        printOp(o.json, result);
      });
    });

  op.command("confirm <operation_id>")
    .requiredOption("--fencing-token <n>", "the attempt's current fencing token")
    .requiredOption("--provider-ref <ref>", "the provider's own reference for the effect")
    .option("--receipt <json>", "JSON receipt", "{}")
    .option("--cost-usd <n>", "cost of this operation, added to the run's total on commit")
    .option("--json", "machine output", false)
    .description("confirm an external effect completed, recording the provider's receipt")
    .action(async (operationId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const found = ctx.store.getExternalOperation(operationId);
        if (!found) throw new HarnessError("NOT_FOUND", `external operation not found: ${operationId}`, { operation_id: operationId });
        ctx.store.assertFencing(found.stage_run_id, Number(o.fencingToken));
        const receipt = jsonObject(o.receipt, "--receipt");
        const cost_usd = nonNegativeCost(o.costUsd);
        const result = ctx.journal.confirmExternal(operationId, { provider_ref: o.providerRef, receipt, ...(cost_usd !== undefined ? { cost_usd } : {}) });
        printOp(o.json, result);
      });
    });

  op.command("lost <operation_id>")
    .requiredOption("--fencing-token <n>", "the attempt's current fencing token")
    .requiredOption("--reason <text>", "why the outcome could not be confirmed")
    .option("--json", "machine output", false)
    .description("mark an external effect's outcome unknown, for reconciliation")
    .action(async (operationId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const found = ctx.store.getExternalOperation(operationId);
        if (!found) throw new HarnessError("NOT_FOUND", `external operation not found: ${operationId}`, { operation_id: operationId });
        ctx.store.assertFencing(found.stage_run_id, Number(o.fencingToken));
        const result = ctx.journal.markLost(operationId, o.reason);
        printOp(o.json, result);
      });
    });
}
