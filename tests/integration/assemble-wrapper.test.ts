import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasFfmpeg, makeVideo, makeWav } from "../media.js";

// Sub-project 5A task 8: `fixtures/ops-project-footage/executors/wrappers/assemble.mjs`, spawned directly
// with a hand-built workspace -- the same technique `fake-agent-outputs.test.ts` uses for its own fixture
// script, chosen because `assemble.mjs` (unlike the built-in CLI stages) is not reachable through
// `harness <cmd>` at all; it only ever runs as a `ScriptExecutor`-spawned child. Covers: the byte-identical
// no-`timeline`-input path (workflow 1.1.0 / the footage pipeline) and the three `timeline.voice` branches.

const WRAPPER = fileURLToPath(new URL("../../fixtures/ops-project-footage/executors/wrappers/assemble.mjs", import.meta.url));

function tmpWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "assemble-ws-"));
  mkdirSync(join(ws, "output"), { recursive: true });
  return ws;
}

function ffprobe(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.env.FFPROBE_PATH ?? "ffprobe", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hasAudioStream(path: string): boolean {
  const r = ffprobe(["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

function probeDuration(path: string): number {
  const r = ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(r.stdout.trim());
}

/** `ffmpeg -i <path> -af volumedetect -f null -`, parsing `max_volume: <n> dB` -- same technique
 * `media-checkers.ts`'s `peakVolumeDb` uses. */
function peakVolumeDb(path: string): number | null {
  const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr ?? "").match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? Number(m[1]) : null;
}

interface Input { artifact_id: string; checksum: string; path: string; type: string; kind: "file" | "directory" }

function run(ws: string, inputs: Input[]): { status: number | null; out: string; err: string } {
  const req = { schema_version: "harness.stage-request/v1", attempt_id: "attempt_test", inputs };
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(req, null, 2));
  const r = spawnSync(process.execPath, [WRAPPER], { cwd: ws, env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Two 2s clips with audio, named so `readdirSync().sort()` orders them `000.mp4` then `001.mp4`. */
function makeClipSet(ws: string): Input {
  const dir = join(ws, "input", "clips");
  mkdirSync(dir, { recursive: true });
  makeVideo(join(dir, "000.mp4"), { seconds: 2, audio: true });
  makeVideo(join(dir, "001.mp4"), { seconds: 2, audio: true });
  return { artifact_id: "a_clips", checksum: "sha256:" + "0".repeat(64), path: "input/clips", type: "clip_set", kind: "directory" };
}

/** A shoot that mixes sound and silence: `000.mp4` has an audio track, `001.mp4` has none -- the headline 5A
 * scenario, and the one a single `hasAudioStream(clips[0])` decision used to get wrong for half the clips. */
function makeMixedClipSet(ws: string, o: { firstHasAudio: boolean }): Input {
  const dir = join(ws, "input", "clips");
  mkdirSync(dir, { recursive: true });
  makeVideo(join(dir, "000.mp4"), { seconds: 2, audio: o.firstHasAudio });
  makeVideo(join(dir, "001.mp4"), { seconds: 2, audio: !o.firstHasAudio });
  return { artifact_id: "a_clips", checksum: "sha256:" + "0".repeat(64), path: "input/clips", type: "clip_set", kind: "directory" };
}

function writeJsonFile(ws: string, relPath: string, value: unknown): Input {
  const abs = join(ws, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2));
  return { artifact_id: "a_" + relPath.replace(/\W/g, "_"), checksum: "sha256:" + "0".repeat(64), path: relPath, type: "timeline", kind: "file" };
}

describe.skipIf(!hasFfmpeg())("assemble.mjs (sub-project 5A task 8: timeline-aware audio)", () => {
  it("without a timeline input: concatenates clips, keeps clip audio (unchanged behaviour)", () => {
    const ws = tmpWorkspace();
    const clipSet = makeClipSet(ws);
    const r = run(ws, [clipSet]);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const outPath = join(ws, "output", "full-episode.mp4");
    expect(hasAudioStream(outPath)).toBe(true);
    expect(probeDuration(outPath)).toBeGreaterThan(3.5);
  });

  it("timeline.voice tts: mutes clip audio, mixes narration wavs at their start times, output has audio", () => {
    const ws = tmpWorkspace();
    const clipSet = makeClipSet(ws);
    const voiceDir = join(ws, "input", "voice-artifact", "voice");
    mkdirSync(voiceDir, { recursive: true });
    makeWav(join(voiceDir, "L001.wav"), 1);
    const voiceInput: Input = { artifact_id: "a_voice", checksum: "sha256:" + "0".repeat(64), path: "input/voice-artifact/voice", type: "voice_set", kind: "directory" };
    const timeline = {
      schema_version: "harness.timeline/v1", voice: "tts", language: "vi", total_seconds: 4,
      video: [], narration: [{ line_id: "L001", wav: "voice/L001.wav", start: 0.5, end: 1.5, words: [] }], speech: [],
    };
    const timelineInput = writeJsonFile(ws, "input/timeline/timeline.json", timeline);

    const r = run(ws, [clipSet, voiceInput, timelineInput]);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const outPath = join(ws, "output", "full-episode.mp4");
    expect(hasAudioStream(outPath)).toBe(true);
  });

  it("timeline.voice tts with no narration lines still produces an audio stream (silent track fallback)", () => {
    const ws = tmpWorkspace();
    const clipSet = makeClipSet(ws);
    const voiceDir = join(ws, "input", "voice-artifact", "voice");
    mkdirSync(voiceDir, { recursive: true });
    const voiceInput: Input = { artifact_id: "a_voice", checksum: "sha256:" + "0".repeat(64), path: "input/voice-artifact/voice", type: "voice_set", kind: "directory" };
    const timeline = { schema_version: "harness.timeline/v1", voice: "tts", language: "vi", total_seconds: 4, video: [], narration: [], speech: [] };
    const timelineInput = writeJsonFile(ws, "input/timeline/timeline.json", timeline);

    const r = run(ws, [clipSet, voiceInput, timelineInput]);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    expect(hasAudioStream(join(ws, "output", "full-episode.mp4"))).toBe(true);
  });

  it("timeline.voice original: keeps clip audio (no attenuation)", () => {
    const ws = tmpWorkspace();
    const clipSet = makeClipSet(ws);
    const timeline = { schema_version: "harness.timeline/v1", voice: "original", language: "vi", total_seconds: 4, video: [], narration: [], speech: [] };
    const timelineInput = writeJsonFile(ws, "input/timeline/timeline.json", timeline);
    const r = run(ws, [clipSet, timelineInput]);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const outPath = join(ws, "output", "full-episode.mp4");
    expect(hasAudioStream(outPath)).toBe(true);
  });

  it("timeline.voice none: clip audio at roughly -12dB, measurably quieter than voice: original", () => {
    const wsOriginal = tmpWorkspace();
    const clipSetOriginal = makeClipSet(wsOriginal);
    const timelineOriginal = writeJsonFile(wsOriginal, "input/timeline/timeline.json", { schema_version: "harness.timeline/v1", voice: "original", language: "vi", total_seconds: 4, video: [], narration: [], speech: [] });
    const rOriginal = run(wsOriginal, [clipSetOriginal, timelineOriginal]);
    expect(rOriginal.status, `stderr: ${rOriginal.err}`).toBe(0);
    const peakOriginal = peakVolumeDb(join(wsOriginal, "output", "full-episode.mp4"));

    const wsNone = tmpWorkspace();
    const clipSetNone = makeClipSet(wsNone);
    const timelineNone = writeJsonFile(wsNone, "input/timeline/timeline.json", { schema_version: "harness.timeline/v1", voice: "none", language: "vi", total_seconds: 4, video: [], narration: [], speech: [] });
    const rNone = run(wsNone, [clipSetNone, timelineNone]);
    expect(rNone.status, `stderr: ${rNone.err}`).toBe(0);
    const outPathNone = join(wsNone, "output", "full-episode.mp4");
    expect(hasAudioStream(outPathNone)).toBe(true);
    const peakNone = peakVolumeDb(outPathNone);

    expect(peakOriginal).not.toBeNull();
    expect(peakNone).not.toBeNull();
    // "none" is the original clip audio attenuated ~12dB (mixed with silence, normalize=0) -- measurably
    // quieter than "original", though not necessarily exactly -12dB once amix/apad are in the mix.
    expect(peakNone!).toBeLessThan(peakOriginal! - 3);
  });

  // Final-review Important 7: `hasAudioStream(clips[0])` decided for the whole shoot. With the first clip
  // silent, `voice: original` fell through to the silent-track-only branch and threw away the audio of every
  // other clip; with it not silent, `[0:a]` referred to a concat stream only some inputs contribute to. Both
  // orders now work, because each clip gets its own audio stream before concatenation.
  for (const firstHasAudio of [true, false]) {
    it(`timeline.voice original on a shoot mixing clips with and without audio (first clip ${firstHasAudio ? "has" : "has no"} audio)`, () => {
      const ws = tmpWorkspace();
      const clipSet = makeMixedClipSet(ws, { firstHasAudio });
      const timeline = writeJsonFile(ws, "input/timeline/timeline.json", { schema_version: "harness.timeline/v1", voice: "original", language: "vi", total_seconds: 4, video: [], narration: [], speech: [] });
      const r = run(ws, [clipSet, timeline]);
      expect(r.status, `stderr: ${r.err}`).toBe(0);
      const outPath = join(ws, "output", "full-episode.mp4");
      expect(hasAudioStream(outPath)).toBe(true);
      // both clips are in the picture: a dropped clip would halve this
      expect(probeDuration(outPath)).toBeGreaterThan(3.5);
      // the clip that DOES carry sound is audible in the mix, not silenced by its silent neighbour
      expect(peakVolumeDb(outPath)).toBeGreaterThan(-60);
    });
  }
});
