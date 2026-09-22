import { spawnSync } from "node:child_process";
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

/** How long a `probeNvenc()` answer is trusted (sub-project 5B Task 8). Same 900 s budget as
 * `MEDIA_PROBE_TTL_SECONDS`, and for the same reason: `media-render` spawns one throwaway ffmpeg encode to
 * find out whether NVENC works, and a studio running episodes back to back would otherwise pay for that
 * probe on every single render. A driver that dies mid-run is still handled inside `renderComposition`
 * itself (it steps the whole run down to `cpu` on the first NVENC failure), so a stale `true` here costs at
 * most one failed segment encode, never a wrong result. */
export const NVENC_PROBE_TTL_SECONDS = 900;

interface NvencCacheEntry { available: boolean; atMs: number }
const nvencCache = new Map<string, NvencCacheEntry>();

/** Test-only: clears the module-level NVENC cache between tests. Never called from production code. */
export function _resetNvencProbeCacheForTests(): void {
  nvencCache.clear();
}

export interface ResolveNvencProbeOptions {
  /** The ffmpeg binary the render will actually use -- also the cache key, so `FFMPEG_PATH` changing
   * mid-process (a test, an operator switching builds) never reuses the other binary's answer. */
  ffmpeg: string;
  probe: (ffmpeg: string) => Promise<boolean>;
  /** Injectable clock (milliseconds since epoch) so tests never need real timers. */
  nowMs: () => number;
}

/** `probeNvenc(ffmpeg)` behind a `NVENC_PROBE_TTL_SECONDS` cache, shaped like `resolveMediaProbe` above.
 * A cached `false` is kept just as long as a cached `true`: a machine with no NVENC must not re-spawn the
 * probe encode for every render either. */
export async function resolveNvencProbe(o: ResolveNvencProbeOptions): Promise<boolean> {
  const cached = nvencCache.get(o.ffmpeg);
  if (cached && o.nowMs() - cached.atMs < NVENC_PROBE_TTL_SECONDS * 1000) return cached.available;
  const available = await o.probe(o.ffmpeg);
  nvencCache.set(o.ffmpeg, { available, atMs: o.nowMs() });
  return available;
}

/** ffmpeg's own reported filter/encoder names (sub-project 5B Task 9) -- just the name tokens, not the
 * flags/description columns `-filters`/`-encoders` also print. */
export interface FfmpegCapabilities { filters: string[]; encoders: string[] }

/** How long a resolved `FfmpegCapabilities` answer is trusted -- same 900 s budget as `MEDIA_PROBE_TTL_SECONDS`/
 * `NVENC_PROBE_TTL_SECONDS` and for the same reason: `harness doctor`'s `media:render` row (studio role, any
 * adapter) spawns two ffmpeg calls, and the dashboard snapshot path polls doctor roughly every
 * `dashboard.refreshSeconds` forever -- a given ffmpeg build's filter/encoder list never changes mid-process. */
export const FFMPEG_CAPS_TTL_SECONDS = 900;

interface FfmpegCapsCacheEntry { caps: FfmpegCapabilities | null; atMs: number }
const ffmpegCapsCache = new Map<string, FfmpegCapsCacheEntry>();

/** Test-only: clears the module-level ffmpeg-capabilities cache between tests. Never called from production
 * code. */
export function _resetFfmpegCapabilitiesCacheForTests(): void {
  ffmpegCapsCache.clear();
}

const FFMPEG_CAPS_PROBE_TIMEOUT_MS = 20_000;

/** Only the name token per output line -- ffmpeg's `-filters`/`-encoders` lines are `<flags> <name> <io/type>
 * <description...>`, so the name is always the second whitespace-separated field. The legend/header lines
 * ffmpeg prints above the real entries (`Filters:`, `  T.. = Timeline support`, the `------` divider) never
 * have a real name there -- the legend's second field is always the literal `=`, and the header/divider lines
 * have no second field at all -- so they drop out on their own without any special-casing. */
function parseCapabilityNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const name = fields[1];
    if (!name || !/^[A-Za-z][\w-]*$/.test(name)) continue;
    names.push(name);
  }
  return names;
}

/** One `ffmpeg -hide_banner -filters` + one `-encoders` call (20 s timeout each, `spawnSync` -- this is a
 * doctor/dashboard-only probe, on the same footing as the also-synchronous `FfprobeMediaProber.isAvailable()`
 * check, never on the render hot path where blocking the event loop would matter). `null` when ffmpeg cannot
 * even be spawned (missing binary, killed by the timeout) -- `resolveFfmpegCapabilities`'s caller
 * (`computeDoctorRows`) turns that into `media:render`'s "ffmpeg not runnable" row. Exported with an
 * injectable `spawnFn` purely for tests; production code only ever calls this through
 * `resolveFfmpegCapabilities`'s TTL cache below. */
export function probeFfmpegCapabilities(ffmpeg: string, spawnFn: typeof spawnSync = spawnSync): FfmpegCapabilities | null {
  const filters = spawnFn(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: FFMPEG_CAPS_PROBE_TIMEOUT_MS });
  if (filters.error) return null;
  const encoders = spawnFn(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: FFMPEG_CAPS_PROBE_TIMEOUT_MS });
  if (encoders.error) return null;
  return { filters: parseCapabilityNames(filters.stdout ?? ""), encoders: parseCapabilityNames(encoders.stdout ?? "") };
}

export interface ResolveFfmpegCapabilitiesOptions {
  /** The ffmpeg binary `media-render` will actually use -- also the cache key, same convention as
   * `ResolveNvencProbeOptions.ffmpeg`. */
  ffmpeg: string;
  mode: "fresh" | "cached";
  /** Injectable clock (milliseconds since epoch) so tests never need real timers. */
  nowMs: () => number;
  /** Injectable for tests; defaults to the real `probeFfmpegCapabilities` (a synchronous, blocking probe --
   * wrapped in `Promise.resolve` here only so this function has the same async shape as
   * `resolveMediaProbe`/`resolveNvencProbe`). */
  probe?: (ffmpeg: string) => FfmpegCapabilities | null;
}

/** `probeFfmpegCapabilities(ffmpeg)` behind a `FFMPEG_CAPS_TTL_SECONDS` cache, shaped exactly like
 * `resolveMediaProbe`/`resolveNvencProbe` above: `"fresh"` always spawns (still refreshing the cache so a
 * following `"cached"` call benefits); `"cached"` reuses a still-fresh entry -- including a cached `null`, so
 * an unrunnable ffmpeg is not re-spawned every minute either -- and spawns a fresh one once the cache is cold
 * or stale. No `gpuLeased` gating (unlike `resolveMediaProbe`): this probe never touches the GPU, so it never
 * needs to defer to a running GPU stage. */
export async function resolveFfmpegCapabilities(o: ResolveFfmpegCapabilitiesOptions): Promise<FfmpegCapabilities | null> {
  const probe = o.probe ?? probeFfmpegCapabilities;
  if (o.mode === "fresh") {
    const caps = probe(o.ffmpeg);
    ffmpegCapsCache.set(o.ffmpeg, { caps, atMs: o.nowMs() });
    return caps;
  }
  const cached = ffmpegCapsCache.get(o.ffmpeg);
  if (cached && o.nowMs() - cached.atMs < FFMPEG_CAPS_TTL_SECONDS * 1000) return cached.caps;
  const caps = probe(o.ffmpeg);
  ffmpegCapsCache.set(o.ffmpeg, { caps, atMs: o.nowMs() });
  return caps;
}

/** Whether a `gpu` resource lease is currently held (any stage, any run) -- the cheap, already-indexed
 * `countLeasedResources()` query `resources status`/the worker's own claim loop already use, not a new scan.
 * `library-production@1.2.0`'s `media-transcribe`/`media-tts` stages declare `requires_resources: [gpu]`
 * (`project-template/executors/scripts.yaml`'s convention), so this is the one resource name worth checking. */
export function gpuCurrentlyLeased(store: Pick<StateStore, "countLeasedResources">): boolean {
  return (store.countLeasedResources().gpu ?? 0) > 0;
}
