import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, mediaConfigSchema, newId, type MediaEngine, type Narration, type VoiceProfile } from "@harness/contracts";
import { FakeMediaEngine } from "@harness/adapter-fake";
import { hasFfmpeg } from "../../../../tests/media.js";
import { NarrationTimingSchema } from "@harness/contracts";
import { ttsCacheKey, synthesizeNarration, type TtsDeps } from "../../src/media/tts.js";

const sha = "sha256:" + "a".repeat(64);

function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

/** Local duration probe -- `synthesizeNarration`'s `probeDuration` is caller-injected (core never imports an
 * adapter), same pattern as `packages/core/test/library/voices.test.ts`. */
function probeDuration(path: string): number | null {
  const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { format?: { duration?: string } };
    const d = Number(parsed.format?.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schema_version: "harness.voice/v1",
    voice_id: newId("voice_profile"),
    display_name: "Test Voice",
    language: "en",
    origin: "synthetic",
    origin_note: "",
    ref_audio: { path: "ref.wav", checksum: sha, duration_seconds: 5 },
    ref_text: "hello there",
    params: { speed: 1, num_step: 32 },
    revision: 1,
    status: "active",
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function narrationFixture(lines: { line_id: string; edl_order: number; text: string }[]): Narration {
  return { schema_version: "harness.narration/v1", language: "en", lines };
}

describe("ttsCacheKey", () => {
  it("changes when speed changes", () => {
    const base = { text: "hello", voice_checksum: sha, model: "m1", language: "en" };
    const k1 = ttsCacheKey({ ...base, params: { speed: 1, num_step: 32 } });
    const k2 = ttsCacheKey({ ...base, params: { speed: 1.2, num_step: 32 } });
    expect(k1).not.toBe(k2);
  });

  it("is a 64-char hex digest, stable for identical input", () => {
    const p = { text: "hello", voice_checksum: sha, params: { speed: 1, num_step: 32 }, model: "m1", language: "en" };
    const k1 = ttsCacheKey(p);
    const k2 = ttsCacheKey(p);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unaffected by JSON key order", () => {
    const k1 = ttsCacheKey({ text: "hello", voice_checksum: sha, params: { speed: 1, num_step: 32 }, model: "m1", language: "en" });
    const k2 = ttsCacheKey({ language: "en", model: "m1", params: { num_step: 32, speed: 1 }, voice_checksum: sha, text: "hello" });
    expect(k1).toBe(k2);
  });
});

describe.skipIf(!hasFfmpeg())("synthesizeNarration (needs ffmpeg/ffprobe)", () => {
  function deps(): TtsDeps & { engine: FakeMediaEngine } {
    const engine = new FakeMediaEngine();
    return { engine, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", probeDuration, cacheDir: tempDir("tts-cache-") };
  }

  it("voiceMode !== \"tts\" returns an empty timing, creates outDir, never calls the engine", async () => {
    const d = deps();
    const outDir = join(tempDir("tts-out-"), "voice");
    const narration = narrationFixture([{ line_id: "L001", edl_order: 0, text: "Hello there." }]);
    const timing = await synthesizeNarration(d, {
      narration, voiceMode: "original", cfg: mediaConfigSchema.parse({}).tts, outDir, deadlineSeconds: 3600,
    });
    expect(timing).toEqual({ schema_version: "harness.narration-timing/v1", voice_id: null, voice_revision: null, total_seconds: 0, lines: [] });
    expect(d.engine.calls).toEqual([]);
  });

  it("empty narration.lines returns an empty timing without calling the engine, even for voiceMode tts", async () => {
    const d = deps();
    const outDir = join(tempDir("tts-out-"), "voice");
    const narration = narrationFixture([]);
    const timing = await synthesizeNarration(d, {
      narration, voiceMode: "tts", voice: { profile: voiceProfile(), ref_audio_path: "unused" }, cfg: mediaConfigSchema.parse({}).tts, outDir, deadlineSeconds: 3600,
    });
    expect(timing.lines).toEqual([]);
    expect(d.engine.calls).toEqual([]);
  });

  it("3 lines synthesize 3 wavs, cache miss, then a re-run hits the cache and never calls the engine again", async () => {
    const d = deps();
    const outDir = join(tempDir("tts-out-"), "voice");
    const profile = voiceProfile();
    const narration = narrationFixture([
      { line_id: "L001", edl_order: 0, text: "This is the first line of narration." },
      { line_id: "L002", edl_order: 1, text: "Here is a second, slightly different line." },
      { line_id: "L003", edl_order: 2, text: "And a third one to round it out." },
    ]);
    const cfg = mediaConfigSchema.parse({}).tts;
    const voice = { profile, ref_audio_path: "unused-ref.wav" };

    const timing1 = await synthesizeNarration(d, { narration, voiceMode: "tts", voice, cfg, outDir, deadlineSeconds: 3600 });
    const parsed1 = NarrationTimingSchema.parse(timing1);
    expect(parsed1.lines).toHaveLength(3);
    expect(parsed1.lines.every((l) => l.cached === false)).toBe(true);
    expect(parsed1.voice_id).toBe(profile.voice_id);
    expect(parsed1.voice_revision).toBe(profile.revision);
    for (const l of parsed1.lines) {
      expect(readFileSync(join(outDir, `${l.line_id}.wav`)).length).toBeGreaterThan(0);
      expect(l.duration_seconds).toBeGreaterThan(0);
    }
    expect(d.engine.calls).toEqual([{ kind: "synthesize", n: 3 }]);

    // re-run: same content -> full cache hit, engine not called again
    const outDir2 = join(tempDir("tts-out2-"), "voice");
    const timing2 = await synthesizeNarration(d, { narration, voiceMode: "tts", voice, cfg, outDir: outDir2, deadlineSeconds: 3600 });
    expect(d.engine.calls).toEqual([{ kind: "synthesize", n: 3 }]); // unchanged
    expect(timing2.lines.every((l) => l.cached === true)).toBe(true);
    expect(timing2.total_seconds).toBeCloseTo(timing1.total_seconds, 5);
  });

  it("editing one line's text sends the engine exactly that one line", async () => {
    const d = deps();
    const profile = voiceProfile();
    const cfg = mediaConfigSchema.parse({}).tts;
    const voice = { profile, ref_audio_path: "unused-ref.wav" };
    const narration1 = narrationFixture([
      { line_id: "L001", edl_order: 0, text: "This line stays the same." },
      { line_id: "L002", edl_order: 1, text: "This line will change." },
    ]);
    await synthesizeNarration(d, { narration: narration1, voiceMode: "tts", voice, cfg, outDir: join(tempDir("tts-out-"), "voice"), deadlineSeconds: 3600 });
    expect(d.engine.calls).toEqual([{ kind: "synthesize", n: 2 }]);

    const narration2 = narrationFixture([
      { line_id: "L001", edl_order: 0, text: "This line stays the same." },
      { line_id: "L002", edl_order: 1, text: "This line has changed instead." },
    ]);
    await synthesizeNarration(d, { narration: narration2, voiceMode: "tts", voice, cfg, outDir: join(tempDir("tts-out2-"), "voice"), deadlineSeconds: 3600 });
    expect(d.engine.calls).toEqual([{ kind: "synthesize", n: 2 }, { kind: "synthesize", n: 1 }]);
  });

  it("voiceMode tts with no voice supplied throws CONFIG_INVALID", async () => {
    const d = deps();
    const narration = narrationFixture([{ line_id: "L001", edl_order: 0, text: "Hello." }]);
    await expect(
      synthesizeNarration(d, { narration, voiceMode: "tts", cfg: mediaConfigSchema.parse({}).tts, outDir: join(tempDir("tts-out-"), "voice"), deadlineSeconds: 3600 }),
    ).rejects.toSatisfy((e) => isHarnessError(e, "CONFIG_INVALID"));
  });

  it("an engine contract failure surfaces as CONFIG_INVALID", async () => {
    const contractEngine: MediaEngine = {
      name: "contract-fake",
      async transcribe() {
        throw new Error("not used in this test");
      },
      async synthesize() {
        return { kind: "contract", reason: "boom" };
      },
      async probe() {
        return { python: null, packages: {}, cuda: false, models_cached: {} };
      },
    };
    const d: TtsDeps = { engine: contractEngine, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", probeDuration, cacheDir: tempDir("tts-cache-") };
    const narration = narrationFixture([{ line_id: "L001", edl_order: 0, text: "Hello there." }]);
    await expect(
      synthesizeNarration(d, {
        narration, voiceMode: "tts", voice: { profile: voiceProfile(), ref_audio_path: "unused" }, cfg: mediaConfigSchema.parse({}).tts,
        outDir: join(tempDir("tts-out-"), "voice"), deadlineSeconds: 3600,
      }),
    ).rejects.toSatisfy((e) => isHarnessError(e, "CONFIG_INVALID"));
  });

  it("an engine transient failure surfaces as IO_ERROR", async () => {
    const transientEngine: MediaEngine = {
      name: "transient-fake",
      async transcribe() {
        throw new Error("not used in this test");
      },
      async synthesize() {
        return { kind: "transient", reason: "gpu busy" };
      },
      async probe() {
        return { python: null, packages: {}, cuda: false, models_cached: {} };
      },
    };
    const d: TtsDeps = { engine: transientEngine, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", probeDuration, cacheDir: tempDir("tts-cache-") };
    const narration = narrationFixture([{ line_id: "L001", edl_order: 0, text: "Hello there." }]);
    await expect(
      synthesizeNarration(d, {
        narration, voiceMode: "tts", voice: { profile: voiceProfile(), ref_audio_path: "unused" }, cfg: mediaConfigSchema.parse({}).tts,
        outDir: join(tempDir("tts-out-"), "voice"), deadlineSeconds: 3600,
      }),
    ).rejects.toSatisfy((e) => isHarnessError(e, "IO_ERROR"));
  });
});
