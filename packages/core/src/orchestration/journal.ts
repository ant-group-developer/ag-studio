import { HarnessError, isHarnessError, newId, type Clock, type ExternalOperation, type ExternalProvider, type StageRequest, type StateStore } from "@harness/contracts";
import { canonicalJson, sha256String } from "../artifacts/checksum.js";
import { eventFor } from "./planner.js";

export interface IntentInput { request: Pick<StageRequest, "run_id" | "stage_run_id" | "attempt_id">; provider: string; kind: string; target: string; payload: Record<string, unknown> }

export class ExternalOperationJournal {
  constructor(private readonly store: StateStore, private readonly provider: ExternalProvider, private readonly clock: Clock) {}

  keyFor(p: { kind: string; target: string; payload: Record<string, unknown> }): string {
    return sha256String(canonicalJson({ kind: p.kind, target: p.target, payload: p.payload }));
  }

  findConfirmedByKey(key: string): ExternalOperation | undefined {
    const op = this.store.findExternalOperationByKey(key);
    return op?.status === "CONFIRMED" ? op : undefined;
  }

  recordIntent(p: IntentInput): ExternalOperation {
    const key = this.keyFor(p);
    return this.store.transaction(() => {
      const existing = this.store.findExternalOperationByKey(key);
      // A FAILED operation is superseded by a fresh row with the same idempotency key (the key must
      // stay stable across retries so the provider lookup on reconciliation still finds it).
      if (existing && existing.status !== "FAILED") return existing;
      const now = this.clock.now();
      const op: ExternalOperation = {
        schema_version: "harness.external-operation/v1", operation_id: newId("external_operation"), run_id: p.request.run_id, stage_run_id: p.request.stage_run_id,
        attempt_id: p.request.attempt_id, provider: p.provider, kind: p.kind, target: p.target, idempotency_key: key, status: "INTENT_RECORDED",
        provider_ref: null, receipt: null, cost_usd: 0, created_at: now, updated_at: now,
      };
      this.store.insertExternalOperation(op);
      this.store.appendEvent(this.ev(op, "external_operation.intent_recorded", { kind: p.kind, target: p.target, idempotency_key: key }));
      return op;
    });
  }

  async dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<ExternalOperation> {
    this.store.transition("external_operation", op.operation_id, "INTENT_RECORDED", "DISPATCHED", this.ev(op, "external_operation.dispatched"));
    try {
      const r = await this.provider.dispatch(op, payload);
      return this.store.transaction(() => {
        const cur = this.store.getExternalOperation(op.operation_id)!;
        this.store.updateExternalOperation({ ...cur, provider_ref: r.provider_ref, receipt: r.receipt });
        this.store.transition("external_operation", op.operation_id, "DISPATCHED", "CONFIRMED", this.ev(op, "external_operation.confirmed", { provider_ref: r.provider_ref }));
        return this.store.getExternalOperation(op.operation_id)!;
      });
    } catch (e) {
      const lost = isHarnessError(e, "CONNECTION_LOST") || (e as { code?: string })?.code === "CONNECTION_LOST";
      if (lost) {
        this.store.transition("external_operation", op.operation_id, "DISPATCHED", "NEEDS_RECONCILIATION", this.ev(op, "external_operation.needs_reconciliation", { reason: (e as Error).message }));
        throw isHarnessError(e) ? e : new HarnessError("CONNECTION_LOST", (e as Error).message, { operation_id: op.operation_id });
      }
      this.store.transition("external_operation", op.operation_id, "DISPATCHED", "FAILED", this.ev(op, "external_operation.failed", { reason: (e as Error).message }));
      throw e;
    }
  }

  private ev(op: ExternalOperation, type: string, payload: Record<string, unknown> = {}) {
    const run = this.store.getRun(op.run_id)!;
    const stage = this.store.getStageRun(op.stage_run_id)!;
    const attempt = this.store.getAttempt(op.attempt_id) ?? null;
    return eventFor(run, stage, attempt, type, type.endsWith("failed") || type.endsWith("reconciliation") ? "warn" : "info", { operation_id: op.operation_id, ...payload });
  }
}
