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
  it("py_compile: engine_io.py, transcribe.py, tts.py all compile", () => {
    for (const file of ["engine_io.py", "transcribe.py", "tts.py"]) {
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

  it.each([
    ["cuda:0", "cuda", 0],
    ["cuda:1", "cuda", 1],
    ["cpu", "cpu", 0],
  ])("transcribe.py --dry-run splits device %s into (%s, device_index=%i) for whisperx.load_model", async (device, dev, index) => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    const engine = new PythonMediaEngine({ python: PYTHON, enginesDir: ENGINES_DIR, device, transcribe: transcribeCfg, tts: ttsCfg, dryRun: true });
    const job: TranscribeJob = { items: [{ source_id: newId("source_item"), audio_path: join(outDir, "a.wav"), language: "en" }], out_dir: outDir };
    const res = await engine.transcribe(job, { timeout_seconds: 30 });
    expect(res.kind, res.kind !== "ok" ? res.reason : "").toBe("ok");
    if (res.kind === "ok") expect(res.result.engine).toContain(`device=${dev},device_index=${index}`);
  });

  it("tts.py --dry-run writes a result that parses as a valid TtsRaw shape (via PythonMediaEngine)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    writeFileSync(join(outDir, "ref.wav"), Buffer.alloc(0));
    const engine = new PythonMediaEngine({ python: PYTHON, enginesDir: ENGINES_DIR, device: "cpu", transcribe: transcribeCfg, tts: ttsCfg, dryRun: true });
    const outPath = join(outDir, "L001.wav");
    const job: TtsJob = {
      lines: [{ line_id: "L001", chunks: ["Hello there.", "This is a longer second chunk."], out_path: outPath }],
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

  it("tts.py --dry-run: an unsupported dtype fails contract, not a crash", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "engine-dryrun-"));
    writeFileSync(join(outDir, "ref.wav"), Buffer.alloc(0));
    const jobPath = join(outDir, "bad-dtype-job.json");
    writeFileSync(jobPath, JSON.stringify({
      device: "cpu", model: "k2-fsa/OmniVoice", dtype: "float8", num_step: 32, speed: 1, language: "en",
      ref_audio: join(outDir, "ref.wav"), ref_text: "hi", align: false,
      lines: [{ line_id: "L001", chunks: ["hi"], out_path: join(outDir, "L001.wav") }],
    }));
    const resultPath = join(outDir, "result.json");
    const r = spawnSync(PYTHON, [join(ENGINES_DIR, "tts.py"), "--job", jobPath, "--result", resultPath, "--dry-run"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("contract");
  });

  /**
   * Task 11 (first real GPU run), regression for the defect that killed EVERY real transcribe:
   * `whisperx.load_model(..., vad_method="pyannote")` unpickles `whisperx/assets/pytorch_model.bin` through
   * `torch.load`, whose `weights_only` default flipped to `True` in torch 2.6 -- so the load died with
   * `UnpicklingError: ... Unsupported global` and the harness saw an infinitely-retried `transient`.
   * `allow_vad_checkpoint_globals()` allow-lists exactly the classes that checkpoint names.
   *
   * Runs with no GPU and no model weights: importing `transcribe` never imports torch (the import lives
   * inside `run()`), and the helper itself returns `[]` rather than raising when torch is absent -- so this
   * asserts the contract that matters on every machine (importable, callable, returns a list of names, never
   * throws), and additionally asserts the omegaconf/pyannote entries are present when those packages ARE
   * installed, which is the case that actually fixes the bug.
   */
  it("transcribe.allow_vad_checkpoint_globals() is callable without torch and allow-lists the VAD checkpoint classes when it is installed", () => {
    const probe = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(ENGINES_DIR)})`,
      "import transcribe",
      "names = transcribe.allow_vad_checkpoint_globals()",
      "assert isinstance(names, list), names",
      "try:",
      "    import torch, omegaconf, pyannote.audio",
      "    have = True",
      "except Exception:",
      "    have = False",
      "print(json.dumps({'have': have, 'names': names}))",
    ].join("\n");
    const r = spawnSync(PYTHON, ["-c", probe], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as { have: boolean; names: string[] };
    if (out.have) {
      expect(out.names).toContain("omegaconf.listconfig.ListConfig");
      expect(out.names).toContain("torch.torch_version.TorchVersion");
      expect(out.names).toContain("pyannote.audio.core.model.Introspection");
      expect(out.names).toContain("typing.Any");
    } else {
      expect(out.names).toEqual([]);
    }
  });

  /**
   * Task 11: `tts.py` used to drop the job's `language` on the floor -- it reached `whisperx.load_align_model`
   * but never `OmniVoice.generate`, whose own docs say reading is better when the language is given, and
   * whose `_resolve_language` degrades an unrecognised value to language-agnostic mode rather than raising.
   * The DoD #3 Vietnamese samples were measured WITH the language passed, so the shipped path had to match
   * what was measured.
   *
   * Runs with no GPU, no omnivoice and no numpy: it drives `tts._synth_line` directly with a recording stub
   * model and a hand-rolled array module implementing only the five operations that function uses.
   */
  it("tts.py forwards the job's language into OmniVoice.generate for every chunk", () => {
    const probe = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(ENGINES_DIR)})`,
      "import tts",
      "",
      "class Arr(list):",
      "    @property",
      "    def size(self): return len(self)",
      "class Flags(list):",
      "    def any(self): return any(self)",
      "class FakeNp:",
      "    float32 = 'f32'",
      "    @staticmethod",
      "    def zeros(n, dtype=None): return Arr([0.0] * n)",
      "    @staticmethod",
      "    def asarray(x, dtype=None): return Arr(list(x))",
      "    @staticmethod",
      "    def concatenate(parts):",
      "        out = Arr()",
      "        for p in parts: out.extend(p)",
      "        return out",
      "    @staticmethod",
      "    def isnan(a): return Flags([False] * len(a))",
      "",
      "class FakeModel:",
      "    def __init__(self): self.calls = []",
      "    def generate(self, **kw):",
      "        self.calls.append(kw)",
      "        return [[0.0] * 2400]",
      "",
      "m = FakeModel()",
      "line = {'line_id': 'L001', 'chunks': ['xin chao.', 'cau thu hai.'], 'out_path': 'x.wav', 'pause_seconds': 0.25}",
      "audio, chunks = tts._synth_line(m, FakeNp, line, 'ref.wav', 'loi mau', 32, 1.0, 'vi')",
      "print(json.dumps({'languages': [c.get('language', '<MISSING>') for c in m.calls],",
      "                  'calls': len(m.calls), 'chunks': len(chunks), 'samples': len(audio)}))",
    ].join("\n");
    const r = spawnSync(PYTHON, ["-c", probe], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as {
      languages: string[]; calls: number; chunks: number; samples: number;
    };
    expect(out.calls).toBe(2);
    expect(out.languages).toEqual(["vi", "vi"]);
    // non-vacuity: the stub really did produce the two chunks plus the 0.25 s pause between them
    expect(out.chunks).toBe(2);
    expect(out.samples).toBe(2 * 2400 + Math.round(0.25 * 24000));
  });
});
