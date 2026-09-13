import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeVideo, makeWav } from "../../../../tests/media.js";
import { FfprobeMediaProber } from "../src/ffprobe-prober.js";

describe.skipIf(!hasFfmpeg())("FfprobeMediaProber (needs ffmpeg/ffprobe on PATH)", () => {
  let clip: string;
  let tone: string;
  let silent: string;
  const prober = new FfprobeMediaProber();

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "ffprobe-adapter-"));
    clip = join(dir, "clip.mp4");
    tone = join(dir, "tone.wav");
    silent = join(dir, "silent.wav");
    makeVideo(clip, { seconds: 2, audio: true });
    makeWav(tone, 1, { silent: false });
    makeWav(silent, 1, { silent: true });
  });

  it("probes a video with audio", async () => {
    const probe = await prober.probe(clip);
    expect(probe).not.toBeNull();
    expect(probe!.container).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    expect(probe!.mime_type).toBe("video/mp4");
    expect(probe!.duration_seconds).toBeGreaterThan(1.8);
    expect(probe!.duration_seconds).toBeLessThan(2.2);
    expect(probe!.media).toMatchObject({ width: 320, height: 180, has_audio: true });
    expect(probe!.video?.codec).toBe("h264");
    expect(probe!.audio?.channels).toBeGreaterThanOrEqual(1);
  });

  it("probes an audio-only wav with no video stream", async () => {
    const probe = await prober.probe(tone);
    expect(probe).not.toBeNull();
    expect(probe!.media).toBeNull();
    expect(probe!.mime_type).toBe("audio/wav");
  });

  it("measures the silence ratio", async () => {
    expect(await prober.silenceRatio(silent)).toBeGreaterThanOrEqual(0.9);
    expect(await prober.silenceRatio(tone)).toBeLessThanOrEqual(0.1);
  });

  it("returns null when the file does not exist", async () => {
    expect(await prober.probe("/no/such/file.mp4")).toBeNull();
  });

  it("isAvailable is false for a bad binary", () => {
    expect(FfprobeMediaProber.isAvailable({ ffprobe: "no-such-binary" })).toBe(false);
  });
});
