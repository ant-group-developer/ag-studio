import { HarnessError, type ExternalOperation, type ExternalProvider } from "@harness/contracts";

export class FakeProvider implements ExternalProvider {
  readonly name = "fake-provider";
  dispatchCount = 0;
  lostAfterDispatch = false;
  private readonly receipts = new Map<string, { provider_ref: string; receipt: Record<string, unknown> }>();

  async dispatch(op: ExternalOperation, payload: Record<string, unknown>) {
    this.dispatchCount += 1;
    const r = { provider_ref: `fake-${this.dispatchCount}`, receipt: { accepted_at: new Date().toISOString(), payload } };
    this.receipts.set(op.idempotency_key, r);
    if (this.lostAfterDispatch) throw new HarnessError("CONNECTION_LOST", "connection lost after dispatch", { operation_id: op.operation_id });
    return r;
  }
  async lookup(idempotencyKey: string) {
    const r = this.receipts.get(idempotencyKey);
    return r ? { found: true, ...r } : { found: false };
  }
}
