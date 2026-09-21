import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type TranscribeJob, type TtsJob } from "@harness/contracts";
import { FakeMediaEngine } from "../src/fake-media-engine.js";
import { hasFfmpeg, makeWav } from "../../../../tests/media.js";

/** Same technique `FakeMediaEngine.transcribe` uses internally (`ffmpeg -i <path>`, no output, parse the
 * "Duration:" line from stderr) -- used here only to independently verify the wav `synthesize()` wrote. */
function probeSeconds(path: string): number {
  const r = spawnSync("ffmpeg", ["-i", path], { encoding: "utf8" });
  const m = (r.stderr ?? "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

describe.skipIf(!hasFfmpeg())("FakeMediaEngine (needs ffmpeg/ffprobe on PATH)", () => {
  it("transcribe: a 2s-wide segment across [0, duration), words divided evenly, language defaults to 'en', calls recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const audioPath = join(dir, "src.wav");
    makeWav(audioPath, 5);
    const engine = new FakeMediaEngine();
    const job: TranscribeJob = { items: [{ source_id: newId("source_item"), audio_path: audioPath, language: null }], out_dir: dir };

    const res = await engine.transcribe(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    const source = res.result.sources[0]!;
    expect(source.language).toBe("en");
    expect(source.alignment).toBe("word");
    // 5s audio -> segments [0,2), [2,4), [4,5)
    expect(source.segments).toHaveLength(3);
    expect(source.segments[0]).toMatchObject({ start: 0, end: 2, text: "w1 w2 w3" });
    expect(source.segments[1]).toMatchObject({ start: 2, end: 4, text: "w1 w2 w3" });
    expect(source.segments[2]!.start).toBe(4);
    expect(source.segments[2]!.end).toBeCloseTo(5, 1);
    for (const seg of source.segments) {
      expect(seg.words).toHaveLength(3);
      expect(seg.words[0]!.start).toBeCloseTo(seg.start, 5);
      expect(seg.words[2]!.end).toBeCloseTo(seg.end, 5);
    }
    expect(engine.calls).toEqual([{ kind: "transcribe", n: 1 }]);
  });

  it("transcribe: language passes through from the job item when set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const audioPath = join(dir, "src.wav");
    makeWav(audioPath, 1);
    const engine = new FakeMediaEngine();
    const job: TranscribeJob = { items: [{ source_id: newId("source_item"), audio_path: audioPath, language: "vi" }], out_dir: dir };
    const res = await engine.transcribe(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.result.sources[0]!.language).toBe("vi");
  });

  it("synthesize: wav duration ~= totalChars/charsPerSecond (+-0.1s), chunks proportional to chars, words split on whitespace, calls recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const engine = new FakeMediaEngine();
    const text1 = "Hello there friend";
    const text2 = "This is a much longer second chunk of narration text";
    const outPath = join(dir, "L001.wav");
    const job: TtsJob = {
      lines: [{ line_id: "L001", chunks: [text1, text2], out_path: outPath }],
      language: "en",
      voice: { ref_audio: join(dir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };

    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    const line = res.result.lines[0]!;
    const totalChars = text1.length + text2.length;
    const expectedDuration = Math.max(0.4, totalChars / 15);
    expect(Math.abs(line.duration_seconds - expectedDuration)).toBeLessThanOrEqual(0.02);

    const measured = probeSeconds(outPath);
    expect(Math.abs(measured - expectedDuration)).toBeLessThanOrEqual(0.1);

    expect(line.chunks).toHaveLength(2);
    expect(line.chunks[0]!.start).toBe(0);
    expect(line.chunks[1]!.end).toBeCloseTo(expectedDuration, 5);
    const chunk0Frac = text1.length / totalChars;
    expect(line.chunks[0]!.end).toBeCloseTo(expectedDuration * chunk0Frac, 2);

    expect(line.words).not.toBeNull();
    expect(line.words!.length).toBe(text1.split(/\s+/).length + text2.split(/\s+/).length);
    expect(line.alignment).toBe("word");
    expect(line.wav_path).toBe(outPath);
    expect(engine.calls).toEqual([{ kind: "synthesize", n: 1 }]);
  });

  it("synthesize: very short text still gets the 0.4s floor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const engine = new FakeMediaEngine();
    const outPath = join(dir, "L002.wav");
    const job: TtsJob = {
      lines: [{ line_id: "L002", chunks: ["Hi."], out_path: outPath }],
      language: "en",
      voice: { ref_audio: join(dir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.result.lines[0]!.duration_seconds).toBe(0.4);
  });

  it("synthesize: a duplicate line_id fails contract, no wav is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const engine = new FakeMediaEngine();
    const outPath = join(dir, "L003.wav");
    const job: TtsJob = {
      lines: [
        { line_id: "L003", chunks: ["Hello."], out_path: outPath },
        { line_id: "L003", chunks: ["Again."], out_path: outPath },
      ],
      language: "en",
      voice: { ref_audio: join(dir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("contract");
    if (res.kind !== "ok") expect(res.reason).toContain("duplicate line_id");
    expect(engine.calls).toEqual([]);
  });

  it("synthesize: records the job as lastTtsJob, unchanged, alongside calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const engine = new FakeMediaEngine();
    expect(engine.lastTtsJob).toBeUndefined();
    const job: TtsJob = {
      lines: [{ line_id: "L005", chunks: ["Hello there."], out_path: join(dir, "L005.wav"), pause_seconds: 0.3 }],
      language: "en",
      voice: { ref_audio: join(dir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: true,
    };
    await engine.synthesize(job, { timeout_seconds: 10 });
    expect(engine.lastTtsJob).toEqual(job);
  });

  it("synthesize: empty chunks fails contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-media-"));
    const engine = new FakeMediaEngine();
    const job: TtsJob = {
      lines: [{ line_id: "L004", chunks: [], out_path: join(dir, "L004.wav") }],
      language: "en",
      voice: { ref_audio: join(dir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("contract");
    if (res.kind !== "ok") expect(res.reason).toContain("no chunks");
  });

  it("probe(): reports no python/GPU available without throwing", async () => {
    const engine = new FakeMediaEngine();
    const probe = await engine.probe();
    expect(probe.python).toBeNull();
    expect(probe.cuda).toBe(false);
  });
});
