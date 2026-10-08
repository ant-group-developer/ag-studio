import type { Clock, StateStore } from "@harness/contracts";
import { addSeconds } from "@harness/core";

export interface HeartbeatHandle { stop(): void; readonly lost: boolean }

/**
 * Renews the attempt's lease every `intervalMs`; `onLost` once a renewal is refused. With `stageRunId`, each beat
 * also looks at the stage: `onCancelRequested` once its run was cancelled while the attempt runs, so the executor can
 * stop instead of finishing work nobody will read.
 */
export function startHeartbeat(o: {
  store: StateStore; attemptId: string; fencingToken: number; leaseSeconds: number; intervalMs: number; clock: Clock; onLost: () => void;
  stageRunId?: string; onCancelRequested?: () => void;
}): HeartbeatHandle {
  let lost = false;
  let cancelSeen = false;
  const beat = () => {
    if (lost) return;
    const ok = o.store.heartbeat(o.attemptId, o.fencingToken, addSeconds(o.clock.now(), o.leaseSeconds));
    if (!ok) { lost = true; clearInterval(timer); o.onLost(); return; }
    if (!cancelSeen && o.stageRunId && o.onCancelRequested && o.store.getStageRun(o.stageRunId)?.state === "CANCEL_REQUESTED") {
      cancelSeen = true;
      o.onCancelRequested();
    }
  };
  const timer = setInterval(beat, o.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), get lost() { return lost; } };
}
