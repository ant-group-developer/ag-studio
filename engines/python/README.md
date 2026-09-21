# Media engine (WhisperX transcribe + OmniVoice TTS)

Sub-project 5A Task 2. Two standalone scripts that `PythonMediaEngine`
(`packages/adapters/media-python`) spawns as short-lived child processes, one job/result JSON file exchange
per call. Nothing in `core` or in the TypeScript adapter imports torch/whisperx/omnivoice directly -- only
these scripts do, and only on the machine that actually has a GPU set up.

## Setup (GPU machine, once)

The venv belongs OUTSIDE the repo (nothing here is committed). What actually ran on the build machine
(Windows 11, RTX 3060 12 GB, driver 581.29, Python 3.11.15) is:

Every block below runs **from the repo root** and names the venv interpreter explicitly through `$P` --
there is no `activate` step and no `cd`, because an activated shell is exactly how the wrong `python` ends
up running these.

```sh
# 1. keep the ~20 GB of wheels, models and pip cache off the system drive
export PIP_CACHE_DIR=E:/pip-cache HF_HOME=E:/hf-cache

# the system python 3.11 that CREATES the venv -- not used for anything after this line
D:/tools/python311/python.exe -m venv E:/harness-venv

# every later command goes through $P: the venv's own interpreter
P=E:/harness-venv/Scripts/python
$P -m pip install --upgrade pip

# 2. torch FIRST, from the PyTorch CUDA index -- otherwise the requirements resolver picks the CPU wheel.
#    cu126 works against a CUDA 12.x/13-capable driver; use cu128 if no cu126 wheel exists for your Python.
$P -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126

# 3. the engines. ONE venv is enough: the resolver leaves torch alone (verified, task 11).
$P -m pip install -r engines/python/requirements.txt

$P -c "import torch, whisperx, omnivoice; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# -> 2.8.0+cu126 True NVIDIA GeForce RTX 3060
```

`docs/runbooks/studio-media.md` has the full procedure (two-venv fallback, doctor rows, measured timings).

## Pre-download models

Model weights are large; fetch them once, ahead of any real run, so the first `transcribe`/`synthesize` call
in production is not also the first (and slowest, most failure-prone) download:

```sh
export HF_HOME=E:/hf-cache
P=E:/harness-venv/Scripts/python

# whisperx.load_model wants the bare "cuda"/"cpu" plus a separate device_index -- NOT "cuda:0" (that raises
# ValueError: unsupported device cuda:0). See transcribe.py's split_device(). The allow_vad_checkpoint_globals()
# call is what `transcribe.py` itself does before load_model on torch >= 2.6; without it this line dies with
# `UnpicklingError: Weights only load failed`. `sys.path` gets engines/python so `import transcribe` resolves
# from the repo root.
$P -c "import sys; sys.path.insert(0, 'engines/python'); import transcribe; transcribe.allow_vad_checkpoint_globals(); import whisperx; whisperx.load_model('large-v3', 'cuda', device_index=0, compute_type='float16')"
# load_align_model/OmniVoice.from_pretrained take the full "cuda:0"-style string fine. One per language you
# transcribe or narrate in -- `en` is a torchaudio bundle, every other language is a Hugging Face wav2vec2.
$P -c "import whisperx; whisperx.load_align_model(language_code='en', device='cuda:0')"
$P -c "import whisperx; whisperx.load_align_model(language_code='vi', device='cuda:0')"
$P -c "import torch; from omnivoice import OmniVoice; OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map='cuda:0', dtype=torch.float16)"
```

Set `HF_HOME` first if the Hugging Face cache should live somewhere other than the default
`~/.cache/huggingface`; `PythonMediaEngine.probe()` checks that same location (or `HF_HOME`) for
`models--k2-fsa--OmniVoice` and a matching whisper model directory. Note that `HF_HOME` does **not** move
the ENGLISH alignment model: `en` resolves to the torchaudio bundle `WAV2VEC2_ASR_BASE_960H`, which lands in
the torch hub cache (`~/.cache/torch/hub/checkpoints`, ~360 MB) instead. Measured footprint after one real
run: venv 7.4 GB, `HF_HOME` 8.9 GB (OmniVoice 3.1, faster-whisper large-v3 2.9, vi wav2vec2 3.1), torch hub
0.4 GB, pip cache 3.0 GB.

## Verify

1. Dry run first -- no GPU, no model weights, not even torch: this only exercises the process/JSON contract,
   so ANY python 3.11 works here. From the repo root:

   Python writes the job files itself, so every path inside them is spelled the way the interpreter will
   read it. (Do not hand-write `/tmp/...` into the JSON on Windows: a shell like Git Bash rewrites
   command-line arguments but not file *contents*, so `out_path` would land on a different drive than the
   `--result` next to it. Only the values inside the JSON are affected -- the engine itself is fine.)

   ```sh
   D=$(python -c "import json,os,tempfile;d=tempfile.mkdtemp(prefix='engine-check-');p=lambda n:os.path.join(d,n);open(p('ref.wav'),'wb').close();json.dump({'device':'cuda:0','model':'large-v3','compute_type':'float16','batch_size':8,'items':[{'source_id':'src_01ARZ3NDEKTSV4RRFFQ69G5FAV','audio_path':p('a.wav'),'language':'en'}]},open(p('tr-job.json'),'w'));json.dump({'device':'cuda:0','model':'k2-fsa/OmniVoice','dtype':'float16','num_step':32,'speed':1,'language':'en','ref_audio':p('ref.wav'),'ref_text':'hi','align':False,'lines':[{'line_id':'L001','chunks':['Hello there.'],'out_path':p('L001.wav'),'pause_seconds':0.25}]},open(p('tts-job.json'),'w'));print(d)")

   python engines/python/transcribe.py --job "$D/tr-job.json"  --result "$D/tr.json"  --dry-run
   python engines/python/tts.py        --job "$D/tts-job.json" --result "$D/tts.json" --dry-run
   python -c "import json,os,sys;d=sys.argv[1];[print(json.load(open(os.path.join(d,f)))) for f in ('tr.json','tts.json')];print('L001.wav bytes:', os.path.getsize(os.path.join(d,'L001.wav')))" "$D"
   ```

   Both results must be `{'ok': True, ...}` -- `transcribe` echoes the split device
   (`whisperx:large-v3(dry-run,device=cuda,device_index=0)`, see `split_device()`), `tts` reports one line of
   `duration_seconds: 0.1` with `alignment: 'chunk'` and leaves a ~4.8 kB silent `L001.wav` behind.

   The same two dry runs are what `packages/adapters/media-python/test/python-scripts.test.ts` drives through
   the real `PythonMediaEngine`, so a green `pnpm vitest run packages/adapters/media-python` covers this too.

2. Then run one real sentence through each script **with the venv interpreter** (small `items`/`lines`, real
   `audio_path`/`ref_audio`) and `--dry-run` dropped, and confirm `result.json` has `ok: true` and a real
   `.wav`/segments before pointing a whole project at `adapters.media: python`:

   ```sh
   HF_HOME=E:/hf-cache E:/harness-venv/Scripts/python engines/python/tts.py \
     --job <a real job.json> --result /tmp/engine-check/tts-real.json
   ```

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

## torch >= 2.6 and the VAD checkpoint

`transcribe.py` calls `allow_vad_checkpoint_globals()` before `whisperx.load_model`. WhisperX's default
`vad_method="pyannote"` unpickles `whisperx/assets/pytorch_model.bin` (a file inside the installed wheel,
not a download) through `torch.load`, whose `weights_only` default flipped to `True` in torch 2.6 -- without
the allow-list every real transcribe dies with `UnpicklingError: Weights only load failed ... Unsupported
global` and the harness retries it forever as a `transient`. The helper allow-lists exactly the classes that
checkpoint names (omegaconf config nodes, `TorchVersion`, pyannote's `Introspection`/`Specifications`,
`typing.Any` and a few builtins) rather than turning `weights_only` off wholesale, and logs the list it
allowed. A machine with no torch gets an empty list instead of an exception, which is how the regression test
in `packages/adapters/media-python/test/python-scripts.test.ts` runs with no GPU.

`engine_io.py` (shared by both scripts, `import engine_io`) is deliberately not named `_io.py` -- CPython
already has a built-in module named `_io` and a plain `import _io` would silently bind that instead of this
file. Its `write_result` also refuses to write a NaN/Infinity into the result JSON (invalid JSON, and a known
WhisperX alignment failure mode): that case falls back to a clean `{ ok: false, kind: "transient", ... }`
instead of a broken/partial result file.
