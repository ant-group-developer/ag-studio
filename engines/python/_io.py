"""Shared IO helpers for the sub-project 5A media engine scripts (transcribe.py, tts.py).

Job/result protocol (spec sub-project 5A Task 2): the TypeScript `PythonMediaEngine` writes a job JSON file,
spawns `python <script> --job <job.json> --result <result.json> [--dry-run]`, and reads back the result JSON
file this module's `write_result` wrote. Every log line goes to stderr as one JSON object per line (`log`) so
the TS side can forward each line to its own logger without guessing at a text format; stdout is never used
for anything here (results travel through the result file, not a pipe).

IMPORTANT: this file is loaded by `transcribe.py`/`tts.py` via `importlib` under an explicit module name
(never a plain `import _io`) -- CPython already has a real *built-in* module registered in `sys.modules` under
the exact name `_io` (the io module's C implementation), so a plain `import _io` silently binds that built-in
instead of this file and every call below would raise `AttributeError`. See each script's `_load_io_module()`.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from typing import Any


def _reconfigure_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except Exception:
                pass


_reconfigure_utf8()


def read_job(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_result(path: str, data: dict[str, Any]) -> None:
    """Atomic write: a caller polling for `path` must never observe a partially-written file. Writes to a
    sibling temp file in the same directory (guaranteed same filesystem, so `os.replace` is atomic) and
    renames it into place last."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".engine-result-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def log(level: str, msg: str, **data: Any) -> None:
    """One JSON object per line on stderr; `PythonMediaEngine.run()` forwards each such line to the caller's
    `log` callback verbatim."""
    line = {"level": level, "msg": msg, "ts": time.time(), **data}
    print(json.dumps(line, default=str), file=sys.stderr, flush=True)
