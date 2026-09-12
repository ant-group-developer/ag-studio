import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type ExternalOperation, type ExternalProvider, type StageRequest } from "@harness/contracts";
import { ExternalOperationJournal } from "../../src/orchestration/journal.js";
import { beginAttempt, openTempStore, seedStage } from "../helpers.js";

class Provider implements ExternalProvider {
  readonly name = "p"; dispatchCount = 0; lost = false; receipts = new Map<string, { provider_ref: string; receipt: Record<string, unknown> }>();
  async dispatch(op: ExternalOperation) { this.dispatchCount++; const r = { provider_ref: `ref-${this.dispatchCount}`, receipt: { ok: true } }; this.receipts.set(op.idempotency_key, r); if (this.lost) throw Object.assign(new Error("lost"), { code: "CONNECTION_LOST" }); return r; }
  async lookup(key: string) { const r = this.receipts.get(key); return r ? { found: true, ...r } : { found: false }; }
}
function world() {
  const t = openTempStore();
  seedStage(t.store);
  const claim = t.store.claim({ owner: "w", capabilities: [], now: t.clock.now(), leaseSeconds: 90 })!;
  beginAttempt(t.store, claim);
  const request = { run_id: claim.stageRun.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id } as StageRequest;
  const provider = new Provider();
  return { ...t, claim, request, provider, journal: new ExternalOperationJournal(t.store, provider, t.clock) };
}

describe("ExternalOperationJournal", () => {
  it("records intent before dispatch, then confirms with the provider receipt", async () => {
    const { journal, provider, request, store } = world();
    const intent = journal.recordIntent({ request, provider: "p", kind: "upload", target: "channel-01", payload: { v: 1 } });
    expect(intent.status).toBe("INTENT_RECORDED");
    expect(intent.idempotency_key).toBe(journal.keyFor({ kind: "upload", target: "channel-01", payload: { v: 1 } }));
    const done = await journal.dispatch(intent, { v: 1 });
    expect(done.status).toBe("CONFIRMED");
    expect(done.provider_ref).toBe("ref-1");
    expect(store.listEvents({ run_id: request.run_id }).map((e) => e.event_type)).toEqual(expect.arrayContaining(["external_operation.intent_recorded", "external_operation.dispatched", "external_operation.confirmed"]));
    expect(provider.dispatchCount).toBe(1);
  });
  it("returns the existing operation for the same idempotency key instead of creating a duplicate", () => {
    const { journal, request } = world();
    const a = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    const b = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    expect(b.operation_id).toBe(a.operation_id);
  });
  it("marks NEEDS_RECONCILIATION when the connection drops after dispatch and rethrows", async () => {
    const { journal, provider, request, store } = world();
    provider.lost = true;
    const intent = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    await journal.dispatch(intent, {}).then(() => { throw new Error("no throw"); }, (e) => expect(isHarnessError(e, "CONNECTION_LOST") || (e as { code?: string }).code === "CONNECTION_LOST").toBe(true));
    expect(store.getExternalOperation(intent.operation_id)?.status).toBe("NEEDS_RECONCILIATION");
    expect(journal.findConfirmedByKey(intent.idempotency_key)).toBeUndefined();
  });
});
