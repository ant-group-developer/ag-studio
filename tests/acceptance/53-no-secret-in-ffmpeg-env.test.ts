import { afterAll, describe, expect, it } from "vitest";
import { spawn as nodeSpawn, spawnSync, type spawnSync as spawnSyncType } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositionSchema, newId, type Composition, type MediaProbe, type MediaProber } from "@harness/contracts";
import { childEnvWithoutSecrets, renderComposition, type SpawnFn } from "@harness/core";
import { probeFfmpegCapabilities } from "../../packages/cli/src/media-probe-cache.js";
import { hasFfmpeg, makeVideo } from "../media.js";

const SECRET_VALUE = "s3cret";
const SECRET_NAME = "HARNESS_SECRET_X_Y";
const SECRET_NAME_LOWER = "harness_secret_a_b";
const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

// Acceptance 53 (sub-project 5B review fix wave, I3): ffmpeg is a child process like any other, so the repo
// rule "child processes never receive HARNESS_SECRET_*" (AGENTS.md, ADR mục 77) applies to it too. Before
// this wave only the media engine (5A's `mediaChildEnv`), the Playwright publisher and the agent runtime
// filtered their child env; every ffmpeg the renderer, the checkers and `harness doctor` spawned inherited
// the worker's environment whole.
//
// Design note, mirroring acceptance 45's own: 45 asserts the Python half at the ADAPTER BOUNDARY because
// there is no seam for a stand-in interpreter. Here the guarantee is asserted against REAL ffmpeg processes
// instead of a fake script, because a fake "ffmpeg" would have to be an executable script, and Node on
// Windows refuses to spawn a `.cmd`/`.bat` without `shell: true` (CVE-2024-27980's fix) -- a test that
// silently skipped on the machine this harness runs on would be worse than no test. `RenderDeps.spawn` is
// already injectable, so the test wraps the REAL `node:child_process.spawn`, renders a real (tiny) 4K
// episode with the secret present in this process' env, and reads back the env every real ffmpeg child was
// actually handed.

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Runs `fn` with both a upper- and a lower-case `HARNESS_SECRET_*` really present in `process.env`, and
 * restores the previous values afterwards whatever happens. */
async function withSecretInEnv(fn: () => Promise<void> | void): Promise<void> {
  const previous = { upper: process.env[SECRET_NAME], lower: process.env[SECRET_NAME_LOWER] };
  process.env[SECRET_NAME] = SECRET_VALUE;
  process.env[SECRET_NAME_LOWER] = SECRET_VALUE;
  try {
    await fn();
  } finally {
    if (previous.upper === undefined) delete process.env[SECRET_NAME];
    else process.env[SECRET_NAME] = previous.upper;
    if (previous.lower === undefined) delete process.env[SECRET_NAME_LOWER];
    else process.env[SECRET_NAME_LOWER] = previous.lower;
  }
}

function expectSecretFree(env: Record<string, string> | undefined, label: string): void {
  expect(env, `${label}: spawned without an explicit env`).toBeDefined();
  expect(Object.keys(env!).filter((k) => k.toLowerCase().startsWith("harness_secret_")), `${label}: ${JSON.stringify(Object.keys(env!))}`).toEqual([]);
  expect(Object.values(env!), `${label}: the secret VALUE is in the child env`).not.toContain(SECRET_VALUE);
  // ...and not passing on an empty env: ffmpeg needs an ordinary user environment (this is a denylist, not
  // an allowlist -- unlike `agentChildEnv`).
  expect(env!.PATH ?? env!.Path, `${label}: PATH did not survive`).toBe(process.env.PATH ?? process.env.Path);
}

function prober(): MediaProber {
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  return {
    async probe(path: string): Promise<MediaProbe | null> {
      const r = spawnSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) return null;
      let parsed: { format?: { duration?: string }; streams?: Record<string, unknown>[] };
      try { parsed = JSON.parse(r.stdout) as typeof parsed; } catch { return null; }
      const streams = parsed.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video");
      const a = streams.find((s) => s.codec_type === "audio");
      const rate = (s: Record<string, unknown>): number | null => {
        const [num, den] = String(s.avg_frame_rate ?? "0/0").split("/").map(Number);
        return num && den ? num / den : null;
      };
      const duration = Number(parsed.format?.duration);
      return {
        media: null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        mime_type: null,
        container: null,
        video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: rate(v) } : null,
        audio: a ? { codec: String(a.codec_name), channels: Number(a.channels), sample_rate: Number(a.sample_rate) } : null,
      };
    },
  };
}

function composition(sourcePath: string): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 25, codec: "h264" },
    voice: "none",
    language: "vi",
    total_seconds: 1,
    request_id: newId("content_request"),
    brand: null,
    segments: [{
      order: 0, source_id: SRC_A, source_path: sourcePath, in: 0, out: 1, start: 0, end: 1,
      fit: "scale_pad", has_audio: true, transition_out: { kind: "cut", seconds: 0.4, tail_available: false },
    }],
    text_events: [],
    captions: { mode: "none", cues: [] },
    music: null,
    logo: null,
    narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
  });
}

describe("acceptance 53: no secret reaches any ffmpeg child", () => {
  it("childEnvWithoutSecrets strips HARNESS_SECRET_* (either case) from a parent env that has one", () => {
    const parent = { ...process.env, [SECRET_NAME]: SECRET_VALUE, [SECRET_NAME_LOWER]: SECRET_VALUE, PATH: process.env.PATH ?? "" };
    expectSecretFree(childEnvWithoutSecrets(parent), "childEnvWithoutSecrets");
  });

  it.skipIf(!hasFfmpeg())("every ffmpeg a real render spawns is handed a secret-free env", async () => {
    await withSecretInEnv(async () => {
      const srcDir = tempDir("acc53-src-");
      const source = join(srcDir, "a.mp4");
      makeVideo(source, { seconds: 2, audio: true });

      const envs: (Record<string, string> | undefined)[] = [];
      // The REAL spawn, wrapped: every ffmpeg below is a real process; the wrapper only records the env each
      // one was actually given.
      const spy = ((bin: string, args: readonly string[], opts: { env?: Record<string, string> }) => {
        envs.push(opts.env);
        return (nodeSpawn as unknown as (b: string, a: readonly string[], o: unknown) => unknown)(bin, args, opts);
      }) as unknown as SpawnFn;

      const { report } = await renderComposition(
        {
          ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
          prober: prober(),
          cache: { dir: join(tempDir("acc53-cache-"), "mezz"), maxBytes: 1024 ** 3 },
          nvencAvailable: async () => false,
          clock: { now: () => new Date().toISOString() },
          spawn: spy,
        },
        {
          composition: composition(source),
          assPath: null,
          outDir: join(tempDir("acc53-out-"), "out"),
          encoderCfg: "cpu",
          timeoutSeconds: 600,
          sourceChecksums: new Map([[SRC_A, "sha256:" + "a".repeat(64)]]),
        },
      );

      // Non-vacuity: a real episode really was produced, over several real ffmpeg calls (mezzanine, loudnorm
      // measurement pass, final encode, `-version`).
      expect(report.output.width).toBe(3840);
      expect(envs.length, "no ffmpeg was spawned at all").toBeGreaterThanOrEqual(3);
      envs.forEach((env, i) => expectSecretFree(env, `render ffmpeg call ${i}`));
    });
  }, 600_000);

  it("the doctor/dashboard ffmpeg capability probe is handed a secret-free env too", async () => {
    await withSecretInEnv(() => {
      const envs: (Record<string, string> | undefined)[] = [];
      const spy = ((_bin: string, _args: readonly string[], opts: { env?: Record<string, string> }) => {
        envs.push(opts.env);
        return { error: new Error("not run"), stdout: "", stderr: "", status: null, signal: null, output: [], pid: 0 };
      }) as unknown as typeof spawnSyncType;

      probeFfmpegCapabilities("ffmpeg", spy);

      expect(envs.length).toBeGreaterThan(0);
      envs.forEach((env, i) => expectSecretFree(env, `capability probe call ${i}`));
    });
  });
});
