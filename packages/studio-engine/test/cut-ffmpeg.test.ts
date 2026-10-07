/**
 * The async ffmpeg/ffprobe helpers of the shot-cut stages, on real synthetic clips (skipped without ffmpeg + ffprobe;
 * FFMPEG_PATH / FFPROBE_PATH may point at any build, e.g. ffmpeg-static on a dev machine).
 */
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { detectCuts, extractAudio16k, grabFrame, probeMedia, runTool, tileSheet } from "../src/index.js";
import { hasFfmpeg, makeSceneClip } from "../../../tests/media.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

describe("runTool", () => {
  it("answers the exit code and output of a program, and a missing program as an error", async () => {
    const ok = await runTool(process.execPath, ["-e", "process.stdout.write('hi'); process.stderr.write('warn'); process.exit(3)"], { timeoutMs: 10_000 });
    expect(ok).toMatchObject({ code: 3, stdout: "hi", stderr: "warn", timedOut: false });
    await expect(runTool("no-such-tool-xyz", [], { timeoutMs: 5_000 })).rejects.toThrow(/no-such-tool-xyz/);
  });

  it("kills a program that runs past its time", async () => {
    const r = await runTool(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg())("shot-cut ffmpeg helpers (needs ffmpeg + ffprobe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cut-ffmpeg-"));
  const clip = join(dir, "three.mp4");
  const silent = join(dir, "silent.mp4");
  beforeAll(() => {
    makeSceneClip(clip, { seconds: 9, colors: ["black", "white", "gray"], cuts: [3, 6] }); // luma jumps: the scene score sees them
    makeSceneClip(silent, { seconds: 4, colors: ["white"], audio: null });
  });

  it("probes duration, size, frame rate and sound", async () => {
    const p = await probeMedia(FFPROBE, clip);
    expect(p?.duration_s).toBeCloseTo(9, 0);
    expect(p).toMatchObject({ width: 320, height: 180, has_audio: true });
    expect(p?.fps).toBeCloseTo(25, 0);
    expect((await probeMedia(FFPROBE, silent))?.has_audio).toBe(false);
    expect(await probeMedia(FFPROBE, join(dir, "nope.mp4"))).toBeNull();
  });

  it("finds the scene cuts", async () => {
    const cuts = await detectCuts(FFMPEG, clip, 0.3);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toBeCloseTo(3, 0);
    expect(cuts[1]).toBeCloseTo(6, 0);
  });

  it("extracts 16 kHz mono audio, and says when a file has none", async () => {
    const wav = join(dir, "three.wav");
    expect(await extractAudio16k(FFMPEG, clip, wav)).toBe(true);
    expect((await probeMedia(FFPROBE, wav))?.duration_s).toBeCloseTo(9, 0);
    expect(await extractAudio16k(FFMPEG, silent, join(dir, "silent.wav"))).toBe(false);
  });

  it("grabs a frame at a time and tiles frames into one sheet", async () => {
    const frames = [1.5, 4.5, 7.5].map((t, i) => join(dir, `f${i}.png`));
    for (const [i, t] of [1.5, 4.5, 7.5].entries()) await grabFrame(FFMPEG, clip, t, frames[i]!, 160);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    const sheet = join(dir, "sheet.png");
    await tileSheet(FFMPEG, frames, 4, sheet);
    const p = await probeMedia(FFPROBE, sheet);
    expect(p).toMatchObject({ width: 640, height: 90 });
  });
});
