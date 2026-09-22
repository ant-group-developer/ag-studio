import { beforeEach, describe, expect, it } from "vitest";
import type { MediaEngine, MediaEngineProbe } from "@harness/contracts";
import {
  _resetFfmpegCapabilitiesCacheForTests, _resetMediaProbeCacheForTests, _resetNvencProbeCacheForTests, FFMPEG_CAPS_TTL_SECONDS, type FfmpegCapabilities,
  gpuCurrentlyLeased, MEDIA_PROBE_TTL_SECONDS, mediaProbeCacheKey, NVENC_PROBE_TTL_SECONDS, probeFfmpegCapabilities, resolveFfmpegCapabilities, resolveMediaProbe, resolveNvencProbe,
} from "../src/media-probe-cache.js";

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

// Sub-project 5B Task 9: ffmpeg `-filters`/`-encoders` capability probing behind the same TTL-cache shape.
const FAKE_FILTERS_OUTPUT = [
  "Filters:",
  "  T.. = Timeline support",
  "  .S. = Slice threading",
  "  A = Audio input/output",
  "  V = Video input/output",
  "  N = Dynamic number and/or type of input/output",
  "  | = Source or sink filter",
  "  ------",
  " TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.",
  " ... ass               V->V       Render ASS/SSA subtitles.",
  " ... xfade             VV->V      Cross fade two videos.",
  " ... loudnorm          A->A       EBU R128 loudness normalization.",
  " ... sidechaincompress AA->A      Sidechain compressor.",
  " ... overlay           VV->V      Overlay a video source on top of another.",
].join("\n");
const FAKE_ENCODERS_OUTPUT = [
  "Encoders:",
  " V..... = Video",
  " A..... = Audio",
  " ------",
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC encoder",
  " V....D h264_nvenc           NVIDIA NVENC H.264 encoder",
].join("\n");

type SpawnSyncResult = ReturnType<typeof import("node:child_process").spawnSync>;

/** A fake `spawnSync`-shaped function: answers `-filters`/`-encoders` with the canned output above, or an
 * `error` (ffmpeg not runnable) for whichever of the two `fail` names. */
function fakeSpawnSync(o: { fail?: "filters" | "encoders" } = {}): { fn: typeof import("node:child_process").spawnSync; calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((_bin: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push(argv);
    const isFilters = argv.includes("-filters");
    if ((isFilters && o.fail === "filters") || (!isFilters && o.fail === "encoders")) {
      return { error: new Error("spawn ENOENT"), stdout: "", stderr: "", status: null, signal: null, pid: 0, output: [] } as unknown as SpawnSyncResult;
    }
    return { stdout: isFilters ? FAKE_FILTERS_OUTPUT : FAKE_ENCODERS_OUTPUT, stderr: "", status: 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncResult;
  }) as typeof import("node:child_process").spawnSync;
  return { fn, calls };
}

describe("probeFfmpegCapabilities", () => {
  it("parses only the name token of each filter/encoder line, dropping headers and legend lines", () => {
    const { fn } = fakeSpawnSync();
    const caps = probeFfmpegCapabilities("ffmpeg", fn);
    expect(caps).toEqual<FfmpegCapabilities>({
      filters: ["aap", "ass", "xfade", "loudnorm", "sidechaincompress", "overlay"],
      encoders: ["libx264", "h264_nvenc"],
    });
  });

  it("calls -filters then -encoders, both with -hide_banner", () => {
    const { fn, calls } = fakeSpawnSync();
    probeFfmpegCapabilities("ffmpeg", fn);
    expect(calls).toEqual([
      ["-hide_banner", "-filters"],
      ["-hide_banner", "-encoders"],
    ]);
  });

  it("returns null when the -filters call cannot spawn ffmpeg at all", () => {
    const { fn } = fakeSpawnSync({ fail: "filters" });
    expect(probeFfmpegCapabilities("definitely-not-ffmpeg", fn)).toBeNull();
  });

  it("returns null when the -encoders call cannot spawn ffmpeg at all", () => {
    const { fn } = fakeSpawnSync({ fail: "encoders" });
    expect(probeFfmpegCapabilities("definitely-not-ffmpeg", fn)).toBeNull();
  });
});

describe("resolveFfmpegCapabilities", () => {
  beforeEach(() => {
    _resetFfmpegCapabilitiesCacheForTests();
  });

  it('"fresh" mode always spawns, even for back-to-back calls', async () => {
    let calls = 0;
    const probe = (): FfmpegCapabilities => { calls++; return { filters: ["ass"], encoders: ["libx264"] }; };
    const clock = clockAt(0);

    await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg", probe, mode: "fresh", nowMs: clock.nowMs });
    await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg", probe, mode: "fresh", nowMs: clock.nowMs });

    expect(calls).toBe(2);
  });

  it('"cached" mode: calls within the TTL share one probe; a call past the TTL spawns a second one', async () => {
    let calls = 0;
    const caps: FfmpegCapabilities = { filters: ["ass", "xfade"], encoders: ["libx264"] };
    const probe = (): FfmpegCapabilities => { calls++; return caps; };
    const clock = clockAt(0);

    const first = await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg", probe, mode: "cached", nowMs: clock.nowMs });
    expect(calls).toBe(1);
    expect(first).toEqual(caps);

    clock.advance((FFMPEG_CAPS_TTL_SECONDS - 1) * 1000);
    const second = await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg", probe, mode: "cached", nowMs: clock.nowMs });
    expect(calls).toBe(1);
    expect(second).toEqual(caps);

    clock.advance(2000);
    await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg", probe, mode: "cached", nowMs: clock.nowMs });
    expect(calls).toBe(2);
  });

  it("caches a null (ffmpeg not runnable) answer too, so it is not re-probed every call within the TTL", async () => {
    let calls = 0;
    const probe = (): null => { calls++; return null; };
    const clock = clockAt(0);

    const first = await resolveFfmpegCapabilities({ ffmpeg: "definitely-not-ffmpeg", probe, mode: "cached", nowMs: clock.nowMs });
    const second = await resolveFfmpegCapabilities({ ffmpeg: "definitely-not-ffmpeg", probe, mode: "cached", nowMs: clock.nowMs });

    expect(calls).toBe(1);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });

  it("keys the cache on the ffmpeg binary, so two builds never share an answer", async () => {
    const clock = clockAt(0);
    const seen: string[] = [];
    const probe = (bin: string): FfmpegCapabilities => { seen.push(bin); return { filters: [bin], encoders: [] }; };

    const a = await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg-a", probe, mode: "cached", nowMs: clock.nowMs });
    const b = await resolveFfmpegCapabilities({ ffmpeg: "ffmpeg-b", probe, mode: "cached", nowMs: clock.nowMs });

    expect(a).toEqual({ filters: ["ffmpeg-a"], encoders: [] });
    expect(b).toEqual({ filters: ["ffmpeg-b"], encoders: [] });
    expect(seen).toEqual(["ffmpeg-a", "ffmpeg-b"]);
  });

  it("defaults to the real probeFfmpegCapabilities when none is injected", async () => {
    const clock = clockAt(0);
    const caps = await resolveFfmpegCapabilities({ ffmpeg: "definitely-not-a-real-binary-xyz", mode: "fresh", nowMs: clock.nowMs });
    expect(caps).toBeNull();
  });
});
