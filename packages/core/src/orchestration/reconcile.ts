import { HarnessError, type Clock, type ExternalProvider, type StateStore } from "@harness/contracts";
import { eventFor, Planner } from "./planner.js";

export interface ReconcileDeps { store: StateStore; provider: ExternalProvider; planner: Planner; clock: Clock }
export interface ReconcileReport { operation_id: string; status: "CONFIRMED" | "FAILED"; stage_key: string; stageState: string }

export async function reconcileOperation(d: ReconcileDeps, operationId: string): Promise<ReconcileReport> {
  const op = d.store.getExternalOperation(operationId);
  if (!op) throw new HarnessError("NOT_FOUND", `external operation not found: ${operationId}`, { operationId });
  if (op.status !== "NEEDS_RECONCILIATION") throw new HarnessError("RECONCILE_FAILED", `operation ${operationId} is ${op.status}, not NEEDS_RECONCILIATION`, { status: op.status });
  const found = await d.provider.lookup(op.idempotency_key);
  return d.store.transaction(() => {
    const run = d.store.getRun(op.run_id)!;
    const stage = d.store.getStageRun(op.stage_run_id)!;
    const attempt = d.store.getAttempt(op.attempt_id) ?? null;
    const status = found.found ? "CONFIRMED" : "FAILED";
    if (found.found) d.store.updateExternalOperation({ ...op, provider_ref: found.provider_ref ?? null, receipt: found.receipt ?? null });
    d.store.transition("external_operation", op.operation_id, "NEEDS_RECONCILIATION", status, eventFor(run, stage, attempt, `external_operation.reconciled`, found.found ? "info" : "warn", { operation_id: op.operation_id, found: found.found }));
    const remaining = d.store.listExternalOperations({ stage_run_id: stage.stage_run_id, status: "NEEDS_RECONCILIATION" });
    if (stage.state === "NEEDS_RECONCILIATION" && remaining.length === 0) {
      d.store.transition("stage_run", stage.stage_run_id, "NEEDS_RECONCILIATION", "READY", eventFor(run, stage, null, "stage.reconciled", "info", { operation_id: op.operation_id }));
      const fresh = d.store.getStageRun(stage.stage_run_id)!;
      d.store.updateStageRun({ ...fresh, ready_at: d.clock.now(), not_before: d.clock.now() });
      d.planner.advance(run.run_id);
    }
    return { operation_id: op.operation_id, status, stage_key: stage.stage_key, stageState: d.store.getStageRun(stage.stage_run_id)!.state };
  });
}

export async function reconcileRun(d: ReconcileDeps, runId: string): Promise<ReconcileReport[]> {
  const out: ReconcileReport[] = [];
  for (const stage of d.store.listStageRuns(runId)) {
    if (stage.state !== "NEEDS_RECONCILIATION") continue;
    for (const op of d.store.listExternalOperations({ stage_run_id: stage.stage_run_id, status: "NEEDS_RECONCILIATION" })) out.push(await reconcileOperation(d, op.operation_id));
  }
  return out;
}
