import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositionSchema, isHarnessError, newId, type Composition } from "@harness/contracts";
import { rebaseNarrationWavs } from "../src/commands/media.js";

// Review fix wave, I2: `media-compose` bakes `composition.narration[].wav` as absolute paths into its OWN
// attempt workspace. `media-render` runs in a different attempt workspace and materializes the same
// `voice_set` artifact again under its own `input/`, so the render must re-base those paths onto the
// directory it was actually given -- otherwise the render depends on the compose workspace still existing,
// which `harness artifacts sweep` (or another machine) makes false.

const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
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

function composition(narration: Composition["narration"]): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 25, codec: "h264" },
    voice: "tts",
    language: "vi",
    total_seconds: 4,
    request_id: newId("content_request"),
    brand: null,
    segments: [{
      order: 0, source_id: SRC_A, source_path: "/abs/a.mp4", in: 0, out: 4, start: 0, end: 4,
      fit: "scale_pad", has_audio: true, transition_out: { kind: "cut", seconds: 0.4, tail_available: false },
    }],
    text_events: [],
    captions: { mode: "none", cues: [] },
    music: null,
    logo: null,
    narration,
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
  });
}

/** A `voice_set` directory as `media-tts` writes it: one flat directory of wavs. */
function voiceSet(lines: string[]): string {
  const dir = join(tempDir("render-voice-"), "voice");
  mkdirSync(dir, { recursive: true });
  for (const line of lines) writeFileSync(join(dir, `${line}.wav`), "not really a wav");
  return dir;
}

describe("rebaseNarrationWavs", () => {
  it("re-points every wav at THIS stage's voice_set, even when the compose workspace is gone", () => {
    // The compose attempt workspace the paths were baked against -- created, then deleted, exactly as a
    // workspace prune would leave things.
    const composeWs = tempDir("compose-ws-");
    rmSync(composeWs, { recursive: true, force: true });

    const renderVoice = voiceSet(["L001", "L002"]);
    const comp = composition([
      { line_id: "L001", wav: join(composeWs, "input", "voice", "voice", "L001.wav"), start: 0, end: 1 },
      { line_id: "L002", wav: join(composeWs, "input", "voice", "voice", "L002.wav"), start: 1, end: 2 },
    ]);

    rebaseNarrationWavs(comp, renderVoice);

    expect(comp.narration.map((n) => n.wav)).toEqual([join(renderVoice, "L001.wav"), join(renderVoice, "L002.wav")]);
  });

  it("is a no-op for a composition with no narration (voice: none/original)", () => {
    const comp = composition([]);
    expect(() => rebaseNarrationWavs(comp, voiceSet([]))).not.toThrow();
    expect(comp.narration).toEqual([]);
  });

  it("a wav missing from the voice_set is CONFIG_INVALID (contract, no retry) and names the file", () => {
    const renderVoice = voiceSet(["L001"]);
    const comp = composition([
      { line_id: "L001", wav: "/gone/L001.wav", start: 0, end: 1 },
      { line_id: "L002", wav: "/gone/L002.wav", start: 1, end: 2 },
    ]);

    let thrown: unknown;
    try { rebaseNarrationWavs(comp, renderVoice); } catch (e) { thrown = e; }

    expect(isHarnessError(thrown, "CONFIG_INVALID"), String(thrown)).toBe(true);
    expect((thrown as Error).message).toContain(join(renderVoice, "L002.wav"));
  });
});
