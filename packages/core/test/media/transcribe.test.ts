import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type MediaEngine, type ShotsIndex } from "@harness/contracts";
import { FakeMediaEngine } from "@harness/adapter-fake";
import { hasFfmpegOnPath as hasFfmpeg, makeVideo } from "../../../../tests/media.js";
import { transcribeSources } from "../../src/media/transcribe.js";

function shotsIndexFixture(sources: { source_id: string; has_audio: boolean; error?: string; duration_seconds: number }[]): ShotsIndex {
  return {
    schema_version: "harness.shots/v2",
    sources: sources.map((s, i) => ({
      source_id: s.source_id,
      index: i,
      file_name: `s${i}.mp4`,
      duration_seconds: s.duration_seconds,
      has_audio: s.has_audio,
      ...(s.error !== undefined ? { error: s.error } : {}),
      shots: s.error !== undefined ? [] : [{ shot_id: `s${String(i).padStart(3, "0")}-000`, in: 0, out: s.duration_seconds }],
    })),
  };
}

describe.skipIf(!hasFfmpeg())("transcribeSources (needs ffmpeg)", () => {
  it("skips a no-audio source (empty segments) and only sends the audio source to the engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-"));
    const withAudioId = newId("source_item");
    const noAudioId = newId("source_item");
    const withAudioPath = join(dir, "with-audio.mp4");
    const noAudioPath = join(dir, "no-audio.mp4");
    makeVideo(withAudioPath, { seconds: 3, audio: true });
    makeVideo(noAudioPath, { seconds: 3, audio: false });

    const shots = shotsIndexFixture([
      { source_id: withAudioId, has_audio: true, duration_seconds: 3 },
      { source_id: noAudioId, has_audio: false, duration_seconds: 3 },
    ]);

    const engine = new FakeMediaEngine();
    const transcript = await transcribeSources(
      { engine, ffmpeg: "ffmpeg" },
      {
        shots,
        sources: [
          { source_id: withAudioId, path: withAudioPath, language: null },
          { source_id: noAudioId, path: noAudioPath, language: "vi" },
        ],
        workDir: dir,
        deadlineSeconds: 3600,
      },
    );

    // output order follows shots.sources order
    expect(transcript.sources.map((s) => s.source_id)).toEqual([withAudioId, noAudioId]);

    const withAudioOut = transcript.sources[0]!;
    const noAudioOut = transcript.sources[1]!;
    expect(withAudioOut.segments.length).toBeGreaterThan(0);
    expect(noAudioOut.segments).toEqual([]);
    expect(noAudioOut.alignment).toBe("segment");
    expect(noAudioOut.language).toBe("vi");
    expect(engine.calls).toEqual([{ kind: "transcribe", n: 1 }]);
    expect(existsSync(join(dir, "audio", `${withAudioId}.wav`))).toBe(true);
    expect(existsSync(join(dir, "audio", `${noAudioId}.wav`))).toBe(false);
  });

  it("a source flagged with an index error is skipped the same way, even if has_audio is true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-error-source-"));
    const okId = newId("source_item");
    const erroredId = newId("source_item");
    const okPath = join(dir, "ok.mp4");
    makeVideo(okPath, { seconds: 2, audio: true });

    const shots = shotsIndexFixture([
      { source_id: okId, has_audio: true, duration_seconds: 2 },
      { source_id: erroredId, has_audio: true, duration_seconds: 2, error: "probe failed" },
    ]);

    const engine = new FakeMediaEngine();
    const transcript = await transcribeSources(
      { engine, ffmpeg: "ffmpeg" },
      {
        shots,
        sources: [
          { source_id: okId, path: okPath, language: null },
          { source_id: erroredId, path: join(dir, "does-not-exist.mp4"), language: null },
        ],
        workDir: dir,
        deadlineSeconds: 3600,
      },
    );

    expect(engine.calls).toEqual([{ kind: "transcribe", n: 1 }]);
    const erroredOut = transcript.sources.find((s) => s.source_id === erroredId)!;
    expect(erroredOut.segments).toEqual([]);
    expect(erroredOut.alignment).toBe("segment");
  });

  it("no source has audio: the engine is never called and every source comes back empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-no-audio-"));
    const id = newId("source_item");
    const clipPath = join(dir, "clip.mp4");
    makeVideo(clipPath, { seconds: 2, audio: false });
    const shots = shotsIndexFixture([{ source_id: id, has_audio: false, duration_seconds: 2 }]);
    const engine = new FakeMediaEngine();

    const transcript = await transcribeSources(
      { engine, ffmpeg: "ffmpeg" },
      { shots, sources: [{ source_id: id, path: clipPath, language: "en" }], workDir: dir, deadlineSeconds: 3600 },
    );

    expect(engine.calls).toEqual([]);
    expect(transcript.sources).toEqual([{ source_id: id, language: "en", alignment: "segment", segments: [] }]);
  });

  it("throws CONFIG_INVALID when the engine reports a contract failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-contract-"));
    const id = newId("source_item");
    const clipPath = join(dir, "clip.mp4");
    makeVideo(clipPath, { seconds: 2, audio: true });
    const shots = shotsIndexFixture([{ source_id: id, has_audio: true, duration_seconds: 2 }]);

    const contractEngine: MediaEngine = {
      name: "contract-fake",
      async transcribe() {
        return { kind: "contract", reason: "boom" };
      },
      async synthesize() {
        throw new Error("not used in this test");
      },
      async probe() {
        return { python: null, packages: {}, cuda: false, models_cached: {} };
      },
    };

    await expect(
      transcribeSources(
        { engine: contractEngine, ffmpeg: "ffmpeg" },
        { shots, sources: [{ source_id: id, path: clipPath, language: null }], workDir: dir, deadlineSeconds: 3600 },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("throws IO_ERROR when the engine reports a transient failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-transient-"));
    const id = newId("source_item");
    const clipPath = join(dir, "clip.mp4");
    makeVideo(clipPath, { seconds: 2, audio: true });
    const shots = shotsIndexFixture([{ source_id: id, has_audio: true, duration_seconds: 2 }]);

    const transientEngine: MediaEngine = {
      name: "transient-fake",
      async transcribe() {
        return { kind: "transient", reason: "gpu busy" };
      },
      async synthesize() {
        throw new Error("not used in this test");
      },
      async probe() {
        return { python: null, packages: {}, cuda: false, models_cached: {} };
      },
    };

    await expect(
      transcribeSources(
        { engine: transientEngine, ffmpeg: "ffmpeg" },
        { shots, sources: [{ source_id: id, path: clipPath, language: null }], workDir: dir, deadlineSeconds: 3600 },
      ),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
  });

  it("throws IO_ERROR when deadlineSeconds leaves no time before ffmpeg or the engine ever runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-deadline-"));
    const id = newId("source_item");
    const clipPath = join(dir, "clip.mp4");
    makeVideo(clipPath, { seconds: 2, audio: true });
    const shots = shotsIndexFixture([{ source_id: id, has_audio: true, duration_seconds: 2 }]);
    const engine = new FakeMediaEngine();

    await expect(
      transcribeSources(
        { engine, ffmpeg: "ffmpeg" },
        { shots, sources: [{ source_id: id, path: clipPath, language: null }], workDir: dir, deadlineSeconds: 0 },
      ),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(engine.calls).toEqual([]);
  });
});
