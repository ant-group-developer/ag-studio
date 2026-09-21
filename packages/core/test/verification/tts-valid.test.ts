import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type Checker, type StageRequest, type StageResult } from "@harness/contracts";
import { mediaCheckers } from "../../src/verification/media-checkers.js";
import { NullMediaProber } from "../../src/source-catalog/prober.js";
import { hasFfmpeg } from "../../../../tests/media.js";

const sha = "sha256:" + "a".repeat(64);

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "media-tts",
    workflow: { id: "w", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-21T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [],
    fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1",
    attempt_id: newId("attempt"),
    outcome: "succeeded",
    outputs,
    checks: [],
    usage: { wall_seconds: 1, cost_usd: 0 },
    external_operations: [],
    errors: [],
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tts-valid-"));
}

/** A pure sine wav, `seconds` long, at 44.1kHz; `gainDb` (positive) drives it toward/into clipping so its
 * ffmpeg `volumedetect` peak lands at/above 0 dBFS -- used for the "peak too loud" failure case. */
function makeSineWav(path: string, seconds: number, gainDb?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const args = ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", String(seconds)];
  if (gainDb !== undefined) args.push("-af", `volume=${gainDb}dB`);
  args.push("-c:a", "pcm_s16le", path);
  spawnSync(ffmpegPath(), args);
}

function timingFixture(lines: { line_id: string; text: string; duration_seconds: number; wav: string }[]) {
  return {
    schema_version: "harness.narration-timing/v1",
    voice_id: newId("voice_profile"),
    voice_revision: 1,
    total_seconds: lines.reduce((s, l) => s + l.duration_seconds, 0),
    lines: lines.map((l) => ({
      line_id: l.line_id,
      edl_order: 0,
      text: l.text,
      wav: l.wav,
      duration_seconds: l.duration_seconds,
      chunks: [{ text: l.text, start: 0, end: l.duration_seconds }],
      words: [],
      alignment: "chunk" as const,
      cached: false,
    })),
  };
}

describe.skipIf(!hasFfmpeg())("tts-valid (needs ffmpeg)", () => {
  const outputsFor = (): StageResult["outputs"] => [
    { path: "output/narration-timing.json", type: "narration_timing", checksum: sha, size_bytes: 1, kind: "file" },
    { path: "output/voice", type: "voice_set", checksum: sha, size_bytes: 0, kind: "directory" },
  ];

  it("passes a well-formed line, at a reasonable reading rate and below 0 dBFS", () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 2);
    const timing = timingFixture([{ line_id: "L001", text: "This line reads at a normal pace today.", duration_seconds: 2, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = checker.check({ request, result, workspaceDir: ws });
    return outcome.then((o) => {
      expect(o.verdict).toBe("pass");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  it("fails when a line's wav is missing", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    const timing = timingFixture([{ line_id: "L001", text: "This line has no wav file on disk at all.", duration_seconds: 2, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("missing wav");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails a reading rate outside 5-30 chars/second (100 chars/second here)", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 1);
    // 100 chars over a 1-second line -> 100 chars/sec, over the 30 ceiling
    const text = "x".repeat(100);
    const timing = timingFixture([{ line_id: "L001", text, duration_seconds: 1, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("reading rate out of range");
    rmSync(ws, { recursive: true, force: true });
  });

  // Review finding (Task 5 fix round 1, Important #2): the 5 cps floor previously hard-failed every short
  // line -- a 1-char line against a 0.4s-minimum wav is 2.5 cps, a 2-char line sits exactly on the boundary
  // and flips on any drift, and a real short interjection ("Ừ.") is well under 5 cps too. The floor now only
  // applies to lines with text.length >= 10; the 30 cps ceiling still applies to every line regardless.
  it("a 1-char line (2.5 cps) and a 2-char line (exactly 5.0 cps) both pass: the 5 cps floor is exempt below 10 chars", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 0.4);
    makeSineWav(join(ws, "output", "voice", "L002.wav"), 0.4);
    const timing = timingFixture([
      { line_id: "L001", text: "x", duration_seconds: 0.4, wav: "voice/L001.wav" },
      { line_id: "L002", text: "xy", duration_seconds: 0.4, wav: "voice/L002.wav" },
    ]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });

  it("a 40-char line at 2 chars/second still fails: the 5 cps floor applies once text.length >= 10", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 20);
    const text = "x".repeat(40); // 40 chars / 20s = 2 chars/second, under the 5 floor
    const timing = timingFixture([{ line_id: "L001", text, duration_seconds: 20, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("reading rate out of range");
    rmSync(ws, { recursive: true, force: true });
  });

  it("an unmeasurable peak (ffmpeg not runnable) does not fail the line: recorded as unknown in the evidence, other checks still run", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 2); // built with the real ffmpeg
    const timing = timingFixture([{ line_id: "L001", text: "This line reads at a normal pace today.", duration_seconds: 2, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    // point the checker itself at a binary that cannot run, so its own peak measurement fails
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: "definitely-not-a-real-ffmpeg-binary-xyz" }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    expect(outcome.evidence.peak).toBe("unknown");
    expect(outcome.evidence.unknown_peaks).toEqual(["voice/L001.wav"]);
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when the wav's peak is at/above 0 dBFS", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output", "voice"), { recursive: true });
    makeSineWav(join(ws, "output", "voice", "L001.wav"), 2, 20); // clipped -> ~0.0 dB peak
    const timing = timingFixture([{ line_id: "L001", text: "This line clips because it is far too loud.", duration_seconds: 2, wav: "voice/L001.wav" }]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult(outputsFor());
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("peak at or above 0 dBFS");
    rmSync(ws, { recursive: true, force: true });
  });

  it("passes trivially when lines is empty, without needing a voice_set output", async () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "output"), { recursive: true });
    const timing = timingFixture([]);
    writeFileSync(join(ws, "output", "narration-timing.json"), JSON.stringify(timing));

    const request = baseRequest();
    const result = baseResult([{ path: "output/narration-timing.json", type: "narration_timing", checksum: sha, size_bytes: 1, kind: "file" }]);
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    const outcome = await checker.check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });

  it("skips when no narration_timing output is present, and skips (unavailable) when ffmpeg/ffprobe is not on PATH", async () => {
    const ws = tmpWorkspace();
    const request = baseRequest();
    const result = baseResult([]);
    const checker = checkerById(mediaCheckers(new NullMediaProber(), { available: true, ffmpeg: ffmpegPath() }), "tts-valid");
    expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("skip");

    const unavailableChecker = checkerById(mediaCheckers(new NullMediaProber(), { available: false }), "tts-valid");
    expect(await unavailableChecker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no media prober available" } });
    rmSync(ws, { recursive: true, force: true });
  });
});
