import { beforeEach, describe, expect, it } from "vitest";
import type { MediaEngine, MediaEngineProbe } from "@harness/contracts";
import { _resetMediaProbeCacheForTests, _resetNvencProbeCacheForTests, gpuCurrentlyLeased, MEDIA_PROBE_TTL_SECONDS, mediaProbeCacheKey, NVENC_PROBE_TTL_SECONDS, resolveMediaProbe, resolveNvencProbe } from "../src/media-probe-cache.js";

const HEALTHY_PROBE: MediaEngineProbe = {
  python: "/usr/bin/python3.11", packages: { torch: "2.3.0", omnivoice: "0.1.0", whisperx: "3.1.1" }, cuda: true,
  gpu: "NVIDIA RTX 4090", vram_free_mb: 20000, models_cached: { omnivoice: true, whisperx: true },
};
const FAILED_PROBE: MediaEngineProbe = {
  python: null, packages: { torch: null, omnivoice: null, whisperx: null }, cuda: false,
  models_cached: { omnivoice: false, whisperx: false },
};

/** Counts `.probe()` calls -- the "counting fake MediaEngine" the coordinator review asked for. */
class CountingEngine implements Pick<MediaEngine, "probe"> {
  calls = 0;
  constructor(private readonly result: MediaEngineProbe = HEALTHY_PROBE) {}
  async probe(): Promise<MediaEngineProbe> {
    this.calls++;
    return this.result;
  }
}

function clockAt(startMs: number): { nowMs: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { nowMs: () => t, advance: (ms: number) => { t += ms; } };
}

describe("media-probe-cache", () => {
  beforeEach(() => {
    _resetMediaProbeCacheForTests();
  });

  it('"fresh" mode always spawns a probe, even for back-to-back calls', async () => {
    const engine = new CountingEngine();
    const clock = clockAt(0);
    const key = mediaProbeCacheKey({ python: "py", device: "cpu" });

    await resolveMediaProbe({ engine, cacheKey: key, mode: "fresh", nowMs: clock.nowMs, gpuLeased: false });
    await resolveMediaProbe({ engine, cacheKey: key, mode: "fresh", nowMs: clock.nowMs, gpuLeased: false });

    expect(engine.calls).toBe(2);
  });

  it('"cached" mode: two calls within the TTL share one probe; a call past the TTL spawns a second one', async () => {
    const engine = new CountingEngine();
    const clock = clockAt(0);
    const key = mediaProbeCacheKey({ python: "py", device: "cuda:0" });

    const first = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    expect(engine.calls).toBe(1);
    expect(first).toEqual(HEALTHY_PROBE);

    clock.advance((MEDIA_PROBE_TTL_SECONDS - 1) * 1000);
    const second = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    expect(engine.calls).toBe(1); // still within the TTL -- reused, not re-spawned
    expect(second).toEqual(HEALTHY_PROBE);

    clock.advance(2000); // now past the TTL
    await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    expect(engine.calls).toBe(2);
  });

  it("caches a failed probe result too, so an unhealthy interpreter is not re-spawned every call within the TTL", async () => {
    const engine = new CountingEngine(FAILED_PROBE);
    const clock = clockAt(0);
    const key = mediaProbeCacheKey({ python: "definitely-missing-python", device: "cpu" });

    const first = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    const second = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });

    expect(engine.calls).toBe(1);
    expect(first).toEqual(FAILED_PROBE);
    expect(second).toEqual(FAILED_PROBE);
  });

  it('"cached" mode with a cold cache and gpuLeased: true never spawns a probe, and returns undefined', async () => {
    const engine = new CountingEngine();
    const clock = clockAt(0);
    const key = mediaProbeCacheKey({ python: "py", device: "cuda:0" });

    const result = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: true });

    expect(engine.calls).toBe(0);
    expect(result).toBeUndefined();
  });

  it('"cached" mode with a stale-but-present entry and gpuLeased: true serves the stale value instead of spawning', async () => {
    const engine = new CountingEngine();
    const clock = clockAt(0);
    const key = mediaProbeCacheKey({ python: "py", device: "cuda:0" });

    await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    expect(engine.calls).toBe(1);

    clock.advance((MEDIA_PROBE_TTL_SECONDS + 1) * 1000); // now stale
    const result = await resolveMediaProbe({ engine, cacheKey: key, mode: "cached", nowMs: clock.nowMs, gpuLeased: true });

    expect(engine.calls).toBe(1); // no second spawn -- GPU is busy
    expect(result).toEqual(HEALTHY_PROBE); // still served the (stale) cached value rather than going dark
  });

  it("keys the cache by the resolved python path(s) + device -- distinct configurations never share an entry", async () => {
    const engineA = new CountingEngine(HEALTHY_PROBE);
    const engineB = new CountingEngine(FAILED_PROBE);
    const clock = clockAt(0);
    const keyA = mediaProbeCacheKey({ python: "py-a", device: "cuda:0" });
    const keyB = mediaProbeCacheKey({ python: "py-b", device: "cpu" });
    expect(keyA).not.toBe(keyB);

    const a = await resolveMediaProbe({ engine: engineA, cacheKey: keyA, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });
    const b = await resolveMediaProbe({ engine: engineB, cacheKey: keyB, mode: "cached", nowMs: clock.nowMs, gpuLeased: false });

    expect(a).toEqual(HEALTHY_PROBE);
    expect(b).toEqual(FAILED_PROBE);
    expect(engineA.calls).toBe(1);
    expect(engineB.calls).toBe(1);
  });

  it("mediaProbeCacheKey distinguishes transcribePython/ttsPython overrides from the plain python field", () => {
    const base = mediaProbeCacheKey({ python: "py", device: "cpu" });
    const withOverride = mediaProbeCacheKey({ python: "py", transcribePython: "py-transcribe", device: "cpu" });
    expect(base).not.toBe(withOverride);
  });
});

describe("gpuCurrentlyLeased", () => {
  it("true only when the store reports at least one held \"gpu\" lease", () => {
    expect(gpuCurrentlyLeased({ countLeasedResources: () => ({ gpu: 1 }) })).toBe(true);
    expect(gpuCurrentlyLeased({ countLeasedResources: () => ({ gpu: 0 }) })).toBe(false);
    expect(gpuCurrentlyLeased({ countLeasedResources: () => ({}) })).toBe(false);
    expect(gpuCurrentlyLeased({ countLeasedResources: () => ({ cpu: 3 }) })).toBe(false);
  });
});

// Sub-project 5B Task 8: the NVENC probe behind the same kind of TTL cache. `media-render` would otherwise
// spawn a throwaway ffmpeg encode before every single episode.
describe("resolveNvencProbe", () => {
  beforeEach(() => {
    _resetNvencProbeCacheForTests();
  });

  it("probes once, then serves the cached answer until the TTL expires", async () => {
    const clock = clockAt(1_000_000);
    let calls = 0;
    const probe = async (): Promise<boolean> => { calls++; return true; };

    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(true);
    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(true);
    expect(calls).toBe(1);

    clock.advance((NVENC_PROBE_TTL_SECONDS - 1) * 1000);
    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(true);
    expect(calls).toBe(1);

    clock.advance(2000);
    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(true);
    expect(calls).toBe(2);
  });

  it("caches a negative answer just as long: a machine with no NVENC must not re-probe every render", async () => {
    const clock = clockAt(0);
    let calls = 0;
    const probe = async (): Promise<boolean> => { calls++; return false; };

    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(false);
    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(false);
    expect(calls).toBe(1);
  });

  it("keys on the ffmpeg binary, so two builds never share an answer", async () => {
    const clock = clockAt(0);
    const seen: string[] = [];
    const probe = async (bin: string): Promise<boolean> => { seen.push(bin); return bin === "ffmpeg-nvenc"; };

    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg", probe, nowMs: clock.nowMs })).toBe(false);
    expect(await resolveNvencProbe({ ffmpeg: "ffmpeg-nvenc", probe, nowMs: clock.nowMs })).toBe(true);
    expect(seen).toEqual(["ffmpeg", "ffmpeg-nvenc"]);
  });
});
