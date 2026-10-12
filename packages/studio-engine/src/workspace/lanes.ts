/**
 * How many project jobs the worker runs at once: its own lanes, plus one for each farm machine sitting idle. Most job
 * time is spent on the farm (what is said, narration, renders), so a free machine is a job that could start now; when
 * the machines are busy it falls back to the worker's own lanes. The farm is asked at most every `everyMs`, in the
 * background (the job loop's tick does not wait); a farm that does not answer counts no idle machine.
 */
import type { ProjectFarm } from "./farm.js";

/** Farm job types a project job sends: a machine taking none of them does not count. */
const STUDIO_FARM_KINDS = /^studio\./;

export interface FarmLanesOptions {
  farm: ProjectFarm;
  /** Lanes with no idle machine (`STUDIO_JOB_LANES`). */
  base: number;
  /** Lanes at most, however many machines are idle (`STUDIO_JOB_LANES_MAX`). */
  max: number;
  /** How often the farm's machines are read; default 15 s. */
  everyMs?: number;
  onError?: (e: unknown) => void;
}

/** Farm machines online, taking a Studio job type, running nothing. */
export function idleFarmNodes(nodes: { online: boolean; running_jobs: number; kinds: readonly string[] }[]): number {
  return nodes.filter((n) => n.online && n.running_jobs === 0 && n.kinds.some((k) => STUDIO_FARM_KINDS.test(k))).length;
}

/** `() => lanes now` for the job runner. */
export function farmLanes(o: FarmLanesOptions): () => number {
  const base = Math.max(1, Math.floor(o.base));
  const max = Math.max(base, Math.floor(o.max));
  const everyMs = o.everyMs ?? 15_000;
  let idle = 0;
  let readAt = -Infinity;
  let reading = false;
  const read = async () => {
    reading = true;
    try {
      idle = o.farm.listNodes ? idleFarmNodes((await o.farm.listNodes()).nodes) : 0;
    } catch (e) {
      idle = 0;
      o.onError?.(e);
    } finally {
      readAt = Date.now();
      reading = false;
    }
  };
  return () => {
    if (!reading && Date.now() - readAt >= everyMs) void read();
    return Math.min(max, base + idle);
  };
}

/** At most `n` at once; the rest wait in order. */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= n) await new Promise<void>((res) => waiting.push(res));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
