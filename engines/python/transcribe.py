"""WhisperX transcribe worker (sub-project 5A Task 2). Invoked by `PythonMediaEngine` as a short-lived child
process:

    python transcribe.py --job <job.json> --result <result.json> [--dry-run]

Job:    { device, model, compute_type, batch_size, items: [{ source_id, audio_path, language|null }] }
Result: { ok: true, engine: "whisperx:<model>", sources: [{ source_id, language, alignment, segments }] }
      | { ok: false, kind: "contract" | "transient", reason }
Exit code is always 0 -- every failure is reported through the result file, never a traceback on stderr, so
the TS side can tell "this input is unfixable" (`contract`) from "try again" (`transient`) instead of just
"the process died".

`--dry-run` never imports torch/whisperx/omnivoice: it validates the job and writes an empty-segment result
per item, so CI (no GPU, no model weights on this machine) can still exercise the process/JSON contract.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any


def _load_io_module():
    """Loads `_io.py` (this script's sibling) under an explicit module name. A plain `import _io` would
    silently resolve to CPython's own built-in `_io` module (already cached in `sys.modules` before this
    script even starts) instead of our file -- see `_io.py`'s module docstring."""
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("harness_media_engine_io", os.path.join(here, "_io.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_io = _load_io_module()
read_job = _io.read_job
write_result = _io.write_result
log = _io.log


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def validate_job(job: dict[str, Any]) -> str | None:
    for key in ("device", "model", "compute_type", "batch_size", "items"):
        if key not in job:
            return f"job missing required field: {key}"
    if not isinstance(job["items"], list):
        return "job.items must be a list"
    for i, item in enumerate(job["items"]):
        for key in ("source_id", "audio_path"):
            if key not in item:
                return f"job.items[{i}] missing required field: {key}"
    return None


def dry_run(job: dict[str, Any], result_path: str) -> None:
    sources = [
        {"source_id": item["source_id"], "language": item.get("language"), "alignment": "word", "segments": []}
        for item in job["items"]
    ]
    write_result(result_path, {"ok": True, "engine": f"whisperx:{job['model']}(dry-run)", "sources": sources})


def run(job: dict[str, Any], result_path: str) -> None:
    device = job["device"]

    try:
        import torch
        import whisperx
    except ImportError as e:
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"required python package not importable: {e}"})
        return

    if device.startswith("cuda") and not torch.cuda.is_available():
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"device {device!r} requested but CUDA is not available"})
        return

    try:
        model = whisperx.load_model(job["model"], device, compute_type=job["compute_type"])
    except Exception as e:  # model load / download / OOM
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"failed to load whisperx model: {e}"})
        return

    # Cache the alignment model per language for the lifetime of this process -- items commonly share a
    # language, and reloading it per item would be needless GPU churn.
    align_cache: dict[str, tuple[Any, Any] | None] = {}
    sources: list[dict[str, Any]] = []
    try:
        for item in job["items"]:
            audio_path = item["audio_path"]
            if not os.path.exists(audio_path):
                write_result(result_path, {"ok": False, "kind": "contract", "reason": f"audio_path not found: {audio_path}"})
                return

            audio = whisperx.load_audio(audio_path)
            transcribed = model.transcribe(audio, batch_size=job["batch_size"], language=item.get("language"))
            language = transcribed.get("language") or item.get("language") or "en"

            if language not in align_cache:
                try:
                    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
                    align_cache[language] = (align_model, metadata)
                except Exception as e:
                    align_cache[language] = None
                    log("warn", "no alignment model for language, falling back to segment-level timing", language=language, reason=str(e))

            cached = align_cache[language]
            segments_in = transcribed.get("segments", [])
            if cached is not None:
                align_model, metadata = cached
                aligned = whisperx.align(segments_in, align_model, metadata, audio, device, return_char_alignments=False)
                segments = [
                    {
                        "start": s.get("start", 0.0),
                        "end": s.get("end", 0.0),
                        "text": s.get("text", ""),
                        "words": [
                            {"word": w["word"], "start": w["start"], "end": w["end"], **({"score": w["score"]} if "score" in w else {})}
                            for w in s.get("words", [])
                            if "start" in w and "end" in w
                        ],
                    }
                    for s in aligned.get("segments", segments_in)
                ]
                alignment = "word"
            else:
                segments = [
                    {"start": s.get("start", 0.0), "end": s.get("end", 0.0), "text": s.get("text", ""), "words": []}
                    for s in segments_in
                ]
                alignment = "segment"

            sources.append({"source_id": item["source_id"], "language": language, "alignment": alignment, "segments": segments})
    except MemoryError as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"out of memory: {e}"})
        return
    except RuntimeError as e:
        kind_reason = f"out of memory: {e}" if "out of memory" in str(e).lower() else f"transcribe failed: {e}"
        write_result(result_path, {"ok": False, "kind": "transient", "reason": kind_reason})
        return
    except Exception as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"transcribe failed: {e}"})
        return

    write_result(result_path, {"ok": True, "engine": f"whisperx:{job['model']}", "sources": sources})


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        job = read_job(args.job)
    except Exception as e:
        write_result(args.result, {"ok": False, "kind": "contract", "reason": f"could not read job file: {e}"})
        return

    error = validate_job(job)
    if error:
        write_result(args.result, {"ok": False, "kind": "contract", "reason": error})
        return

    if args.dry_run:
        dry_run(job, args.result)
        return

    run(job, args.result)


if __name__ == "__main__":
    main()
