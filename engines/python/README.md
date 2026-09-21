# Media engine (WhisperX transcribe + OmniVoice TTS)

Sub-project 5A Task 2. Two standalone scripts that `PythonMediaEngine`
(`packages/adapters/media-python`) spawns as short-lived child processes, one job/result JSON file exchange
per call. Nothing in `core` or in the TypeScript adapter imports torch/whisperx/omnivoice directly -- only
these scripts do, and only on the machine that actually has a GPU set up.

## Setup (GPU machine, once)

```sh
cd engines/python
python -m venv .venv
# Windows: .venv\Scripts\activate    POSIX: source .venv/bin/activate
.venv\Scripts\activate

# CUDA 12.6 build; match this to the CUDA toolkit actually installed on this machine.
pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126

pip install -r requirements.txt
```

## Pre-download models

Model weights are large; fetch them once, ahead of any real run, so the first `transcribe`/`synthesize` call
in production is not also the first (and slowest, most failure-prone) download:

```sh
python -c "import whisperx; whisperx.load_model('large-v3', 'cuda:0', compute_type='float16')"
python -c "import whisperx; whisperx.load_align_model(language_code='en', device='cuda:0')"
python -c "import torch; from omnivoice import OmniVoice; OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map='cuda:0', dtype=torch.float16)"
```

Set `HF_HOME` first if the Hugging Face cache should live somewhere other than the default
`~/.cache/huggingface`; `PythonMediaEngine.probe()` checks that same location (or `HF_HOME`) for
`models--k2-fsa--OmniVoice` and a matching whisper model directory.

## Verify

1. Dry run first -- no GPU, no model weights, just the process/JSON contract:

   ```sh
   python transcribe.py --job <a job.json> --result /tmp/result.json --dry-run
   python tts.py --job <a job.json> --result /tmp/result.json --dry-run
   ```

2. Then run one real sentence through each script (small `items`/`lines`, real `audio_path`/`ref_audio`) with
   `--dry-run` dropped, and confirm `result.json` has `ok: true` and a real `.wav`/segments before pointing a
   whole project at `adapters.media: python`.

## Protocol (kept in sync with `packages/adapters/media-python/src/python-media-engine.ts`)

```
python transcribe.py --job <job.json> --result <result.json> [--dry-run]
python tts.py        --job <job.json> --result <result.json> [--dry-run]
```

Exit code is always `0`. Every failure is reported through the result file as
`{ "ok": false, "kind": "contract" | "transient", "reason": "..." }` -- `contract` for input problems that a
retry can never fix (missing `ref_audio`, an unimportable package, `cuda:*` requested with no CUDA available);
`transient` for everything else (OOM, a model failed to download/load). A non-zero exit code, a timeout, or a
missing/corrupt result file are all treated by the TypeScript side as `transient` too, since the process
itself misbehaved rather than reporting a clean failure.

`_io.py` (shared by both scripts) is loaded via `importlib`, never `import _io` -- CPython already has a
built-in module named `_io` and a plain import would silently bind that instead of this file.
