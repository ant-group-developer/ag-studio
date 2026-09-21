import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type MediaConfig, type TranscribeJob, type TtsJob } from "@harness/contracts";
import { PythonMediaEngine, type PythonMediaEngineOptions } from "../src/python-media-engine.js";

/**
 * A `.py` file with no `package.json` (`"type": "module"`) above it in the directory tree runs as CommonJS
 * when Node executes it directly (`node file.py`) -- this fake stands in for the real transcribe.py/tts.py so
 * the protocol between `PythonMediaEngine` and a child process can be exercised without python or any ML
 * dependency on the test machine.
 *
 * Behavior is selected through the job payload's `model` field (`"FAKE:<mode>"`), not an env var: the whole
 * point of several of these tests is that `mediaChildEnv` strips everything outside its allow-list, so a
 * test-only env var would never reach this script in the first place. Every invocation, regardless of mode,
 * also writes one "env-dump" stderr line listing any `HARNESS_SECRET_*` var it can still see -- used by the
 * env-dump test below, and a free regression check on every other test in this file.
 */
const FAKE_SCRIPT = `
const fs = require("fs");

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const jobPath = getArg("--job");
const resultPath = getArg("--result");

const leaked = Object.keys(process.env).filter((k) => /^HARNESS_SECRET_/i.test(k));
process.stderr.write(JSON.stringify({ level: "info", msg: "env-dump", leaked }) + "\\n");

function writeResult(obj) {
  fs.writeFileSync(resultPath, JSON.stringify(obj));
}

const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const mode = typeof job.model === "string" && job.model.startsWith("FAKE:") ? job.model.slice(5) : "ok";

if (mode === "exit-noresult") {
  process.stderr.write("x".repeat(3000));
  process.exit(3);
}

if (mode === "bad-json") {
  fs.writeFileSync(resultPath, "{not valid json");
  process.exit(0);
}

if (mode === "contract") {
  writeResult({ ok: false, kind: "contract", reason: "fake contract failure" });
  process.exit(0);
}

if (mode === "transient") {
  writeResult({ ok: false, kind: "transient", reason: "fake transient failure" });
  process.exit(0);
}

if (mode === "hang") {
  setTimeout(() => { writeResult({ ok: true, engine: "fake", sources: [] }); }, 5000);
  return;
}

if (Array.isArray(job.items)) {
  const sources = job.items.map((it) => ({
    source_id: it.source_id,
    language: it.language || "en",
    alignment: "word",
    segments: [{ start: 0, end: 1, text: "hi", words: [{ word: "hi", start: 0, end: 1 }] }],
  }));
  writeResult({ ok: true, engine: "fake:whisperx", sources });
} else if (Array.isArray(job.lines)) {
  const lines = job.lines.map((l) => ({
    line_id: l.line_id,
    wav_path: l.out_path,
    duration_seconds: 1.2,
    chunks: l.chunks.map((t, i) => ({ text: t, start: i, end: i + 1 })),
    words: null,
    alignment: "chunk",
  }));
  writeResult({ ok: true, lines });
} else {
  writeResult({ ok: false, kind: "contract", reason: "unrecognized job shape" });
}
process.exit(0);
`;

function makeFakeEnginesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-engine-fake-"));
  writeFileSync(join(dir, "transcribe.py"), FAKE_SCRIPT);
  writeFileSync(join(dir, "tts.py"), FAKE_SCRIPT);
  return dir;
}

const transcribeCfg: MediaConfig["transcribe"] = { engine: "whisperx", model: "large-v3", compute_type: "float16", batch_size: 8 };
const ttsCfg: MediaConfig["tts"] = { engine: "omnivoice", model: "k2-fsa/OmniVoice", dtype: "float16", num_step: 32, max_chars: 280, pause_seconds: 0.25, loudness_lufs: -16 };

function makeEngine(enginesDir: string, opts?: Partial<PythonMediaEngineOptions>): PythonMediaEngine {
  return new PythonMediaEngine({
    python: process.execPath,
    enginesDir,
    device: "cpu",
    transcribe: transcribeCfg,
    tts: ttsCfg,
    ...opts,
  });
}

function makeTranscribeJob(outDir: string): TranscribeJob {
  return { items: [{ source_id: newId("source_item"), audio_path: join(outDir, "a.wav"), language: "en" }], out_dir: outDir };
}

function makeTtsJob(outDir: string): TtsJob {
  const outPath = join(outDir, "L001.wav");
  return {
    lines: [{ line_id: "L001", chunks: ["Hello there.", "This is a test."], out_path: outPath }],
    language: "en",
    voice: { ref_audio: join(outDir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
    align: false,
  };
}

function fakeModeCfg(mode: string): { transcribe: MediaConfig["transcribe"] } {
  return { transcribe: { ...transcribeCfg, model: `FAKE:${mode}` } };
}

describe("PythonMediaEngine", () => {
  afterEach(() => {
    delete process.env.HARNESS_SECRET_TEST_KEY;
  });

  it("ok: transcribe result parses as a valid Transcript, kind ok", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir);
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.result.sources).toHaveLength(1);
      expect(res.result.sources[0]!.segments[0]!.text).toBe("hi");
      expect(res.result.engine).toBe("fake:whisperx");
    }
  });

  it("ok: synthesize result parses as valid TtsRaw, kind ok, one line with its chunks", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir);
    const res = await engine.synthesize(makeTtsJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.result.lines).toHaveLength(1);
      expect(res.result.lines[0]!.chunks).toHaveLength(2);
    }
  });

  it("synthesize: a duplicate line_id fails contract before spawning anything", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir);
    const outPath = join(outDir, "L001.wav");
    const job: TtsJob = {
      lines: [
        { line_id: "L001", chunks: ["Hello there."], out_path: outPath },
        { line_id: "L001", chunks: ["This is a test."], out_path: outPath },
      ],
      language: "en",
      voice: { ref_audio: join(outDir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("contract");
    if (res.kind !== "ok") expect(res.reason).toContain("duplicate line_id");
  });

  it("synthesize: empty chunks fails contract before spawning anything", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir);
    const job: TtsJob = {
      lines: [{ line_id: "L001", chunks: [], out_path: join(outDir, "L001.wav") }],
      language: "en",
      voice: { ref_audio: join(outDir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 10 });
    expect(res.kind).toBe("contract");
    if (res.kind !== "ok") expect(res.reason).toContain("no chunks");
  });

  it("contract: { ok:false, kind:'contract' } passes through verbatim", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, fakeModeCfg("contract"));
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("contract");
    if (res.kind !== "ok") expect(res.reason).toBe("fake contract failure");
  });

  it("transient: { ok:false, kind:'transient' } passes through verbatim", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, fakeModeCfg("transient"));
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("transient");
    if (res.kind !== "ok") expect(res.reason).toBe("fake transient failure");
  });

  it("exit code 3 with no result file: transient, with a stderr tail <= 2000 chars", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, fakeModeCfg("exit-noresult"));
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("transient");
    if (res.kind !== "ok") {
      expect(res.reason).toContain("exited with code 3");
      const tailMatch = res.reason.match(/x+$/);
      expect(tailMatch).not.toBeNull();
      expect(tailMatch![0].length).toBeLessThanOrEqual(2000);
    }
  });

  it("corrupt result JSON: transient", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, fakeModeCfg("bad-json"));
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("transient");
  });

  it("hang: killed at its timeout, transient reason mentions 'timed out'", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, fakeModeCfg("hang"));
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 1 });
    expect(res.kind).toBe("transient");
    if (res.kind !== "ok") expect(res.reason).toContain("timed out");
  }, 15_000);

  it("env-dump: the child process never sees a HARNESS_SECRET_* env var", async () => {
    process.env.HARNESS_SECRET_TEST_KEY = "s3cret";
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir);
    const logs: string[] = [];
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10, log: (l) => logs.push(l) });
    expect(res.kind).toBe("ok");
    const dumpLine = logs.find((l) => l.includes("env-dump"));
    expect(dumpLine).toBeDefined();
    expect(JSON.parse(dumpLine!).leaked).toEqual([]);
    expect(logs.join("\n")).not.toContain("s3cret");
  });

  it("missing python binary: spawn ENOENT resolves transient instead of crashing the process", async () => {
    const enginesDir = makeFakeEnginesDir();
    const outDir = mkdtempSync(join(tmpdir(), "media-job-"));
    const engine = makeEngine(enginesDir, { python: "definitely-missing-python-xyz" });
    const res = await engine.transcribe(makeTranscribeJob(outDir), { timeout_seconds: 10 });
    expect(res.kind).toBe("transient");
  });

  it("probe(): missing python resolves the all-null/false shape instead of throwing", async () => {
    const engine = makeEngine(makeFakeEnginesDir(), { python: "definitely-missing-python-xyz" });
    const probe = await engine.probe();
    expect(probe).toEqual({ python: null, packages: { torch: null, omnivoice: null, whisperx: null }, cuda: false, models_cached: { omnivoice: false, whisperx: false } });
  });
});
