import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newId, type TranscribeJob, type TtsJob } from "@harness/contracts";
import { PythonMediaEngine } from "../src/python-media-engine.js";

const ENGINES_DIR = fileURLToPath(new URL("../../../../engines/python", import.meta.url));
const PYTHON = process.env.PYTHON_PATH ?? "python";

function hasPython(): boolean {
  const r = spawnSync(PYTHON, ["--version"]);
  return r.status === 0;
}

const transcribeCfg = { engine: "whisperx" as const, model: "large-v3", compute_type: "float16", batch_size: 8 };
const ttsCfg = { engine: "omnivoice" as const, model: "k2-fsa/OmniVoice", dtype: "float16", num_step: 32, max_chars: 280, pause_seconds: 0.25, loudness_lufs: -16 };

/**
 * `python` IS on PATH on the machine these were written on (no torch/whisperx/omnivoice) -- so these run for
 * real there, exercising `py_compile` and the `--dry-run` path of both scripts against the real
 * `PythonMediaEngine`. On a machine with no python at all, `describe.skipIf` drops the whole suite.
 */
describe.skipIf(!hasPython())("python engine scripts (engines/python)", () => {
  it("py_compile: _io.py, transcribe.py, tts.py all compile", () => {
    for (const file of ["_io.py", "transcribe.py", "tts.py"]) {
      const r = spawnSync(PYTHON, ["-m", "py_compile", join(ENGINES_DIR, file)], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it("transcribe.py --dry-run writes a result that parses with TranscriptSchema (via PythonMediaEngine)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    const engine = new PythonMediaEngine({ python: PYTHON, enginesDir: ENGINES_DIR, device: "cpu", transcribe: transcribeCfg, tts: ttsCfg, dryRun: true });
    const job: TranscribeJob = {
      items: [
        { source_id: newId("source_item"), audio_path: join(outDir, "a.wav"), language: "en" },
        { source_id: newId("source_item"), audio_path: join(outDir, "b.wav"), language: null },
      ],
      out_dir: outDir,
    };
    const res = await engine.transcribe(job, { timeout_seconds: 30 });
    expect(res.kind, res.kind !== "ok" ? res.reason : "").toBe("ok");
    if (res.kind === "ok") {
      expect(res.result.sources).toHaveLength(2);
      expect(res.result.sources[0]!.segments).toEqual([]);
      expect(res.result.sources[1]!.language).toBeNull();
    }
  });

  it("tts.py --dry-run writes a result that parses as a valid TtsRaw shape (via PythonMediaEngine)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    writeFileSync(join(outDir, "ref.wav"), Buffer.alloc(0));
    const engine = new PythonMediaEngine({ python: PYTHON, enginesDir: ENGINES_DIR, device: "cpu", transcribe: transcribeCfg, tts: ttsCfg, dryRun: true });
    const outPath = join(outDir, "L001.wav");
    const job: TtsJob = {
      lines: [
        { line_id: "L001", text: "Hello there.", out_path: outPath },
        { line_id: "L001", text: "This is a longer second chunk.", out_path: outPath },
      ],
      language: "en",
      voice: { ref_audio: join(outDir, "ref.wav"), ref_text: "hi", params: { speed: 1, num_step: 32 } },
      align: false,
    };
    const res = await engine.synthesize(job, { timeout_seconds: 30 });
    expect(res.kind, res.kind !== "ok" ? res.reason : "").toBe("ok");
    if (res.kind === "ok") {
      expect(res.result.lines).toHaveLength(1);
      const line = res.result.lines[0]!;
      expect(line.chunks).toHaveLength(2);
      expect(line.duration_seconds).toBeCloseTo(0.1, 2);
      expect(line.words).toBeNull();
      expect(line.alignment).toBe("chunk");
    }
  });

  it("transcribe.py --dry-run: a job missing a required field fails contract, not a crash", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    const jobPath = join(outDir, "bad-job.json");
    writeFileSync(jobPath, JSON.stringify({ device: "cpu" })); // missing model/compute_type/batch_size/items
    const resultPath = join(outDir, "result.json");
    const r = spawnSync(PYTHON, [join(ENGINES_DIR, "transcribe.py"), "--job", jobPath, "--result", resultPath, "--dry-run"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("contract");
  });
});
