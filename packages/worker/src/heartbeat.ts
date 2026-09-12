import type { Clock, StateStore } from "@harness/contracts";
import { addSeconds } from "@harness/core";

export interface HeartbeatHandle { stop(): void; readonly lost: boolean }

export function startHeartbeat(o: { store: StateStore; attemptId: string; fencingToken: number; leaseSeconds: number; intervalMs: number; clock: Clock; onLost: () => void }): HeartbeatHandle {
  let lost = false;
  const beat = () => {
    if (lost) return;
    const ok = o.store.heartbeat(o.attemptId, o.fencingToken, addSeconds(o.clock.now(), o.leaseSeconds));
    if (!ok) { lost = true; clearInterval(timer); o.onLost(); }
  };
  const timer = setInterval(beat, o.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), get lost() { return lost; } };
}
