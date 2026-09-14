import { HarnessError, type TransitionKind } from "@harness/contracts";

export const TRANSITIONS: Record<TransitionKind, Record<string, readonly string[]>> = {
  run: {
    DRAFT: ["READY", "CANCELLED"],
    READY: ["RUNNING", "CANCEL_REQUESTED"],
    RUNNING: ["WAITING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED"],
    WAITING: ["RUNNING", "CANCEL_REQUESTED"],
    CANCEL_REQUESTED: ["CANCELLED"],
    CANCELLED: [], SUCCEEDED: [], FAILED: [],
  },
  stage_run: {
    PENDING: ["READY", "SUCCEEDED", "CANCEL_REQUESTED", "CANCELLED"], // SUCCEEDED: reused from the cache at release, never dispatched
    READY: ["CLAIMED", "CANCEL_REQUESTED", "CANCELLED"],
    CLAIMED: ["RUNNING", "READY", "FAILED", "CANCEL_REQUESTED"],  // READY/FAILED: lease abandoned
    RUNNING: ["VERIFYING", "WAITING_EXTERNAL", "WAITING_HUMAN", "FAILED", "READY", "CANCEL_REQUESTED"], // RUNNING -> READY: lease abandoned
    VERIFYING: ["SUCCEEDED", "FAILED", "WAITING_HUMAN", "READY", "CANCEL_REQUESTED"], // READY: lease abandoned during verify
    // CANCELLED direct from the three parked states: no worker holds them, so nothing has to acknowledge the cancel
    WAITING_EXTERNAL: ["RUNNING", "NEEDS_RECONCILIATION", "CANCEL_REQUESTED", "CANCELLED"],
    NEEDS_RECONCILIATION: ["RUNNING", "READY", "CANCEL_REQUESTED", "CANCELLED"],       // READY: reconciled, retry with new attempt (spec addition v1)
    WAITING_HUMAN: ["READY", "CANCEL_REQUESTED", "CANCELLED"],
    FAILED: ["READY"],                                            // retry policy
    CANCEL_REQUESTED: ["CANCELLED"],
    CANCELLED: [], SUCCEEDED: [],
  },
  attempt: {
    CLAIMED: ["RUNNING", "ABANDONED", "CANCELLED", "FAILED"],
    RUNNING: ["SUCCEEDED", "FAILED", "ABANDONED", "CANCELLED"],
    SUCCEEDED: [], FAILED: [], ABANDONED: [], CANCELLED: [],
  },
  artifact: {
    PROVISIONAL: ["ACCEPTED", "REJECTED"],
    ACCEPTED: ["STALE", "ARCHIVED"],
    STALE: ["ARCHIVED"],
    REJECTED: [], ARCHIVED: [],
  },
  external_operation: {
    INTENT_RECORDED: ["DISPATCHED", "FAILED"],
    DISPATCHED: ["CONFIRMED", "FAILED", "NEEDS_RECONCILIATION"],
    NEEDS_RECONCILIATION: ["CONFIRMED", "FAILED", "DISPATCHED"],
    CONFIRMED: [], FAILED: [],
  },
  publication_job: {
    DRAFT: ["READY"],
    READY: ["UPLOADING", "FAILED"],
    UPLOADING: ["PROCESSING", "NEEDS_RECONCILIATION", "READY"],   // READY: refused/busy — the upload never happened
    PROCESSING: ["SCHEDULED", "NEEDS_RECONCILIATION", "FAILED"],
    SCHEDULED: ["PUBLISHED", "NEEDS_RECONCILIATION", "FAILED"],
    NEEDS_RECONCILIATION: ["PROCESSING", "SCHEDULED", "PUBLISHED", "READY", "FAILED"],
    PUBLISHED: [], FAILED: [],
  },
};

export function assertTransition(kind: TransitionKind, from: string, to: string): void {
  const allowed = TRANSITIONS[kind][from];
  if (!allowed || !allowed.includes(to)) {
    throw new HarnessError("INVALID_TRANSITION", `${kind}: ${from} -> ${to} is not allowed`, { kind, from, to });
  }
}

export function isTerminal(kind: TransitionKind, state: string): boolean {
  return (TRANSITIONS[kind][state] ?? []).length === 0;
}

export const TABLE_BY_KIND: Record<TransitionKind, string> = {
  run: "run", stage_run: "stage_run", attempt: "attempt", artifact: "artifact", external_operation: "external_operation",
  publication_job: "publication_job",
};
export const STATE_FIELD_BY_KIND: Record<TransitionKind, "state" | "status"> = {
  run: "state", stage_run: "state", attempt: "state", artifact: "status", external_operation: "status",
  publication_job: "state",
};
