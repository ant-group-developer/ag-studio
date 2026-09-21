import type { MediaEngine, MediaEngineProbe, StateStore } from "@harness/contracts";

/**
 * How long a cached `MediaEngine.probe()` result is trusted before `computeDoctorRows`'s `"cached"` mode
 * spawns a fresh one (sub-project 5A Task 9 fix round, coordinator review Important 2): a studio worker calls
 * `writeDashboardSnapshot` roughly every `dashboard.refreshSeconds` (default 60s) forever, and `probe()` has
 * no memoisation of its own -- without this cache, every idle poll would spawn a torch-importing python
 * subprocess, competing with a real GPU stage and able to stall the idle loop for up to 30s (`probe()`'s own
 * timeout).
 */
export const MEDIA_PROBE_TTL_SECONDS = 900;

interface CacheEntry { probe: MediaEngineProbe; atMs: number }

/** Process-level (module-scope) cache: one CLI/worker process serves one ops project, so a plain `Map` keyed
 * by the resolved python configuration is enough -- nothing here is meant to survive a process restart. */
const cache = new Map<string, CacheEntry>();

/** Test-only: clears the module-level cache between tests. Never called from production code. */
export function _resetMediaProbeCacheForTests(): void {
  cache.clear();
}

/** Cache key: the resolved python path(s) + device -- exactly what a probe result actually depends on, so two
 * distinct configurations (or the same project's `media.python`/`media.device` changing mid-process, e.g. in a
 * test) never share a cache entry. */
export function mediaProbeCacheKey(o: { python: string; transcribePython?: string; ttsPython?: string; device: string }): string {
  return `${o.python}|${o.transcribePython ?? ""}|${o.ttsPython ?? ""}|${o.device}`;
}

export interface ResolveMediaProbeOptions {
  engine: Pick<MediaEngine, "probe">;
  cacheKey: string;
  mode: "fresh" | "cached";
  /** Injectable clock (milliseconds since epoch) so tests never need real timers. */
  nowMs: () => number;
  /** Cheaply-known "a GPU resource lease is currently held" (composition root:
   * `gpuCurrentlyLeased(ctx.store)`) -- only consulted in `"cached"` mode, and only once there is no still-fresh
   * cache entry to serve instead: never spawn a probe while a real GPU stage might be running. */
  gpuLeased: boolean;
}

/**
 * Resolves the `MediaEngineProbe` `DoctorInput.media` needs.
 *  - `"fresh"` (`harness doctor`, an operator asking for ground truth right now): always spawns, but still
 *    refreshes the cache so a following `"cached"` call benefits.
 *  - `"cached"` (the dashboard snapshot path, `writeDashboardSnapshot`): reuses a still-fresh cache entry
 *    (`MEDIA_PROBE_TTL_SECONDS`, including a cached *failure* -- an unhealthy interpreter must not be
 *    re-spawned every minute either). When the cache is cold or stale, it spawns UNLESS `gpuLeased` is true, in
 *    which case it returns whatever is cached (possibly stale, possibly nothing at all -- the caller treats
 *    `undefined` as "skip the media:* rows this round") rather than compete with a running GPU stage.
 */
export async function resolveMediaProbe(o: ResolveMediaProbeOptions): Promise<MediaEngineProbe | undefined> {
  if (o.mode === "fresh") {
    const probe = await o.engine.probe();
    cache.set(o.cacheKey, { probe, atMs: o.nowMs() });
    return probe;
  }

  const cached = cache.get(o.cacheKey);
  if (cached && o.nowMs() - cached.atMs < MEDIA_PROBE_TTL_SECONDS * 1000) return cached.probe;
  if (o.gpuLeased) return cached?.probe;

  const probe = await o.engine.probe();
  cache.set(o.cacheKey, { probe, atMs: o.nowMs() });
  return probe;
}

/** Whether a `gpu` resource lease is currently held (any stage, any run) -- the cheap, already-indexed
 * `countLeasedResources()` query `resources status`/the worker's own claim loop already use, not a new scan.
 * `library-production@1.2.0`'s `media-transcribe`/`media-tts` stages declare `requires_resources: [gpu]`
 * (`project-template/executors/scripts.yaml`'s convention), so this is the one resource name worth checking. */
export function gpuCurrentlyLeased(store: Pick<StateStore, "countLeasedResources">): boolean {
  return (store.countLeasedResources().gpu ?? 0) > 0;
}
