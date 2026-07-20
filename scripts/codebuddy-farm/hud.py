"""Line-log emitters for dashboard (CODEBUDDY_UI=log)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


def _env(key: str, default: str = "") -> str:
    import os

    return (os.environ.get(key) or default).strip()


UI_MODE = (_env("CODEBUDDY_UI") or _env("GROK_UI") or "log").lower()
VERBOSE = (_env("CODEBUDDY_VERBOSE") or _env("GROK_VERBOSE") or "true").lower() in (
    "1",
    "true",
    "yes",
    "on",
)

_log_fp: TextIO[str] | None = None


def open_log(path: Path) -> None:
    global _log_fp
    path.parent.mkdir(parents=True, exist_ok=True)
    _log_fp = open(path, "a", encoding="utf-8")


def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _write(line: str) -> None:
    print(line, flush=True)
    if _log_fp:
        try:
            _log_fp.write(line + "\n")
            _log_fp.flush()
        except Exception:
            pass


def vlog(msg: str) -> None:
    if VERBOSE or UI_MODE == "log":
        _write(f"{_ts()}  {msg}")


def emit_event(payload: dict[str, Any]) -> None:
    try:
        _write("CODEBUDDY_EVENT " + json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def emit_progress(attempt: int, step: str, detail: str = "", email: str = "") -> None:
    step_u = (step or "progress").upper().replace("-", "_")
    parts = [f"{_ts()}  [STEP]  #{attempt}"]
    if email:
        parts.append(email)
    parts.append(step_u if not detail else f"{step_u}  {detail}")
    _write("  ".join(parts))
    emit_event(
        {
            "t": "step",
            "attempt": attempt,
            "email": email or None,
            "step": step_u,
            "detail": detail or None,
        }
    )


def emit_success(attempt: int, email: str, detail: str = "ok") -> None:
    _write(f"{_ts()}  [OK]  #{attempt}  {email}  {detail}")
    emit_event({"t": "ok", "attempt": attempt, "email": email, "detail": detail})


def emit_failed(attempt: int, email: str, detail: str) -> None:
    _write(f"{_ts()}  [FAIL]  #{attempt}  {email or '-'}  {detail}")
    emit_event(
        {
            "t": "fail",
            "attempt": attempt,
            "email": email or None,
            "detail": detail,
            "error": detail,
        }
    )
