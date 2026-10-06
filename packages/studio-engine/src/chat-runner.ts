/**
 * The worker's chat loop (spec local-chat §3.2): runs the replies people wait for, next to the stage loops and outside
 * `claim()`. Each reply takes a `claude` slot from the lease table (`claude-slots.ts`) — when the cap is full it waits
 * in line ahead of the stages — runs `runChatTurn`, and gives the slot back. Replies of different scopes run
 * together; one scope runs one reply at a time (`nextPendingTurns`).
 */
import type { HarnessLogger } from "@harness/core";
import type { StudioBucket } from "./bucket.js";
import { runChatTurn } from "./chat.js";
import { markTurnRunning, nextPendingTurns, orphanedRunningTurns, requeueTurn } from "./chat-db.js";
import { acquireChatSlot, chatTurnsHoldingSlots, CHAT_SLOT_LEASE_SECONDS, heartbeatChatSlot, releaseChatSlot } from "./claude-slots.js";
import type { StudioEngineCore } from "./core.js";
import type { StudioDb } from "./studio-db.js";
import type { StudioClaudeOptions } from "./worker.js";

export interface ChatRunnerOptions {
  core: StudioEngineCore;
  db: StudioDb;
  bucket: StudioBucket;
  claude: StudioClaudeOptions;
  logger: HarnessLogger;
  /** Claude calls at once right now (the web setting, else env). */
  cap: () => number;
  pollMs?: number;
  heartbeatMs?: number;
}

export interface ChatRunner {
  /** Starts every reply that can run now; resolves once they have started (not finished). */
  tick(signal?: AbortSignal): Promise<void>;
  /** Replies running in this process. */
  readonly running: number;
  /** Resolves when every reply running in this process has finished. */
  idle(): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
}

export function createChatRunner(o: ChatRunnerOptions): ChatRunner {
  const { core, db, logger } = o;
  const now = () => core.clock.now();
  const inFlight = new Map<string, Promise<void>>();
  /** Replies of this process waiting for a slot (their `chat-wait` row). */
  const waiting = new Set<string>();

  const run = (turnId: string, signal?: AbortSignal) => {
    const beat = setInterval(() => heartbeatChatSlot(db, turnId, now()), o.heartbeatMs ?? (CHAT_SLOT_LEASE_SECONDS * 1000) / 4);
    const done = (async () => {
      try {
        await runChatTurn({ core, db, bucket: o.bucket, claude: o.claude, logger }, turnId, signal);
      } catch (e) {
        logger.error("chat reply failed", { turn_id: turnId, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(beat);
        // stopped mid-call: the reply goes back in line for the next worker instead of failing
        if (signal?.aborted) requeueTurn(db, turnId, now());
        releaseChatSlot(db, turnId);
        inFlight.delete(turnId);
      }
    })();
    inFlight.set(turnId, done);
  };

  const tick = async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    for (const id of orphanedRunningTurns(db, [...chatTurnsHoldingSlots(db), ...inFlight.keys()])) {
      logger.warn("chat reply left running by a stopped worker; running it again", { turn_id: id });
      requeueTurn(db, id, now());
    }
    const cap = o.cap();
    const ready = nextPendingTurns(db, now(), cap * 2).filter((t) => !inFlight.has(t.id));
    const readyIds = new Set(ready.map((t) => t.id));
    for (const id of [...waiting]) if (!readyIds.has(id)) { releaseChatSlot(db, id); waiting.delete(id); }
    for (const t of ready) {
      if (!acquireChatSlot(db, t.id, cap, now())) { waiting.add(t.id); continue; }
      waiting.delete(t.id);
      if (!markTurnRunning(db, t.id, now())) { releaseChatSlot(db, t.id); continue; }
      run(t.id, signal);
    }
  };

  return {
    tick,
    get running() { return inFlight.size; },
    idle: async () => { while (inFlight.size) await Promise.all([...inFlight.values()]); },
    runForever: async (signal) => {
      while (!signal.aborted) {
        try { await tick(signal); }
        catch (e) { logger.error("chat loop failed; keeps polling", { error: e instanceof Error ? e.message : String(e) }); }
        await new Promise<void>((res) => {
          const onAbort = () => { clearTimeout(t); res(); };
          const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); res(); }, o.pollMs ?? 1000);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      for (const id of waiting) releaseChatSlot(db, id);
      waiting.clear();
      while (inFlight.size) await Promise.all([...inFlight.values()]);
    },
  };
}
