#!/usr/bin/env python3
"""
HTTP-only xAI Grok account farmer (no browser / CloakBrowser).

Stack:
  - Boterdrop-Solver :8000 → cf_clearance + Turnstile
  - curl_cffi firefox135  → TLS impersonation
  - Digitalin mail API     → OTP
  - gRPC-Web               → signup
  - HTTP server action     → OAuth consent → tokens

Usage:
  python http_farm.py                  # interactive prompt
  python http_farm.py -n 10 -c 3 -y    # batch
  python http_farm.py --verbose        # detail
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import random
import re
import secrets
import string
import sys
import threading
import time
import shutil
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests as plain
from curl_cffi import requests as creq

from etteum_push import (
    parse_push_cli_flags,
    push_enabled_from_env,
    preflight_etteum,
    push_one_farm_result,
    push_accounts_to_etteum,
    account_to_import_item,
)

ROOT = Path(__file__).resolve().parent

# ── Env ──────────────────────────────────────────────────────────────────────
def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()

def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")

try:
    from dotenv import load_dotenv
    # Do not override parent-injected env (dashboard sets ETTEUM_API_KEY / ETTEUM_URL).
    # Stale keys in scripts/grok-farm/.env must not clobber a live API key.
    load_dotenv(ROOT / ".env", override=False)
except ImportError:
    env_f = ROOT / ".env"
    if env_f.is_file():
        for line in env_f.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)

# ── Config ───────────────────────────────────────────────────────────────────
SOLVER = _env("BOTERDROP_URL", "http://127.0.0.1:8000").rstrip("/")
MAIL_API = _env("GROK_TEMPMAIL_API_URL", "https://digitalin-id-mail-api.halimcakep45.workers.dev").rstrip("/")
MAIL_KEY = _env("GROK_TEMPMAIL_API_KEY")
PASSWORD = _env("GROK_PASSWORD", "ChangeMe123!")
SITEKEY = "0x4AAAAAAAhr9JGVDZbrZOo0"
BASE = "https://accounts.x.ai"
AUTH = f"{BASE}/auth_mgmt.AuthManagement"
IMPERSONATE = _env("GROK_IMPERSONATE", "firefox135")
PROXY_FILE = _env("GROK_PROXY_FILE", str(ROOT / "proxies.txt"))

XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token"
XAI_AUTHORIZE = "https://auth.x.ai/oauth2/authorize"
XAI_REDIRECT = "http://127.0.0.1:56121/callback"
XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
SERVER_ACTION_ID = _env("GROK_SERVER_ACTION_ID", "401b73e22a5e68737d0037e1aa449fef82cd1b35fb")

MAX_ACCOUNTS = int(_env("GROK_MAX_ACCOUNTS", "1") or "1")
CONCURRENT = int(_env("GROK_CONCURRENT", "1") or "1")
SPAWN_DELAY = float(_env("GROK_SPAWN_DELAY", "2") or "2")
EMAIL_LOCAL_LEN = max(10, min(32, int(_env("GROK_EMAIL_LOCAL_LEN", "16") or "16")))

ETTEUM_URL = _env("ETTEUM_URL", "http://127.0.0.1:1930")
ETTEUM_API_KEY = _env("ETTEUM_API_KEY") or _env("API_KEY")
GROK_PUSH_ETTEUM = _env_bool("GROK_PUSH_ETTEUM", True)
GROK_PUSH_MODE = _env("GROK_PUSH_MODE", "per_success").lower()
GROK_OTP_TIMEOUT = int(_env("GROK_OTP_TIMEOUT", "90") or "90")

RESULTS_ROOT = Path(_env("GROK_RESULTS_DIR", str(ROOT / "results")))
USED_EMAILS_FILE = Path(_env("GROK_USED_EMAILS_FILE", str(RESULTS_ROOT / "used_emails.txt")))
RESULTS_ROOT.mkdir(parents=True, exist_ok=True)

FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Avery", "Parker", "Sage", "River", "Skyler", "Dakota", "Reese", "Finley", "Rowan", "Charlie", "Emerson", "Hayden", "Jamie"]
LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris"]

# ── Proxy pool ───────────────────────────────────────────────────────────────
def _normalize_proxy_url(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if not s:
        return None
    if "://" in s:
        return s
    parts = s.split(":")
    if len(parts) >= 4 and parts[1].isdigit() and "@" not in parts[0]:
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        if host and user:
            return f"http://{user}:{password}@{host}:{port}"
    if "@" in s:
        return f"http://{s}"
    if len(parts) == 2 and parts[1].isdigit():
        return f"http://{parts[0]}:{parts[1]}"
    return None


def _load_proxy() -> tuple[list[str], str]:
    pfile = Path(PROXY_FILE)
    if not pfile.is_absolute():
        pfile = (ROOT / pfile).resolve()
    if not pfile.is_file():
        return [], "direct (no proxy file)"
    pool: list[str] = []
    for line in open(pfile, encoding="utf-8", errors="replace"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        u = _normalize_proxy_url(s)
        if u:
            pool.append(u)
    desc = f"file:{pfile} ({len(pool)})"
    if pool and _env_bool("GROK_PROXY_SHUFFLE", False):
        random.shuffle(pool)
        desc += " shuffled"
    return pool, desc


PROXY_POOL, PROXY_SOURCE = _load_proxy()
_proxy_idx = 0
_proxy_lock = asyncio.Lock()


async def next_proxy(exclude: set[str] | None = None) -> str | None:
    pinned = _env("GROK_HTTP_PROXY")
    if pinned:
        return pinned
    if not PROXY_POOL:
        return None
    exclude = exclude or set()
    global _proxy_idx
    async with _proxy_lock:
        for _ in range(len(PROXY_POOL)):
            p = PROXY_POOL[_proxy_idx % len(PROXY_POOL)]
            _proxy_idx += 1
            if p not in exclude or len(exclude) >= len(PROXY_POOL):
                return p
        return [p for p in PROXY_POOL if p not in exclude][0] if any(p not in exclude for p in PROXY_POOL) else PROXY_POOL[0]


def pick_proxy_sync(exclude: set[str] | None = None) -> str | None:
    pinned = _env("GROK_HTTP_PROXY")
    if pinned:
        return pinned
    if not PROXY_POOL:
        return None
    exclude = exclude or set()
    candidates = [p for p in PROXY_POOL if p not in exclude] or PROXY_POOL
    return candidates[0]


# ── HUD (same ANSI table as farm.py) ─────────────────────────────────────────
_UI_ENV = _env("GROK_UI", "").lower()
UI_MODE = "hud" if _UI_ENV in ("hud", "tui", "progress") else ("log" if _UI_ENV in ("log", "verbose", "full") else ("hud" if sys.stdout.isatty() else "log"))
VERBOSE = _env_bool("GROK_VERBOSE", False)

_STEP_LABELS: dict[str, str] = {
    "start": "START", "clearance": "SOLVER", "mail_create": "MAIL",
    "mail_otp": "OTP", "rpc_create_email": "SIGNUP", "rpc_verify_email": "VERIFY",
    "rpc_validate": "PROFILE", "turnstile": "CAPTCHA", "rpc_create_user": "SIGNUP",
    "rpc_login": "LOGIN", "oauth_authorize": "OAUTH", "oauth_consent": "OAUTH",
    "oauth_token": "TOKEN",
}
_STUCK_THRESHOLDS: dict[str, int] = {"OTP": 30, "CAPTCHA": 45, "OAUTH": 60, "TOKEN": 30, "LOGIN": 45, "VERIFY": 30, "SOLVER": 30}
_STUCK_DEFAULT = 90
_STEP_COLORS: dict[str, str] = {
    "START": "gray", "SOLVER": "gray", "SIGNUP": "cyan", "MAIL": "cyan",
    "OTP": "cyan", "VERIFY": "cyan", "PROFILE": "cyan", "CAPTCHA": "yellow",
    "LOGIN": "cyan", "OAUTH": "green", "TOKEN": "green", "IDLE": "gray",
}
_ANSI_RE = re.compile(r"\033\[[0-9;]*m")
_RST = "\033[0m"
_BG = {
    "green": "\033[42m\033[30m", "red": "\033[41m\033[97m",
    "yellow": "\033[43m\033[30m", "cyan": "\033[46m\033[30m",
    "gray": "\033[100m\033[97m", "bar": "\033[42m\033[32m",
    "bar_empty": "\033[100m\033[90m",
}


def _vlen(s: str) -> int:
    return len(_ANSI_RE.sub("", s or ""))


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s or "")


def _trunc(s: str, width: int) -> str:
    s = s or ""
    if width <= 0: return ""
    if len(s) <= width: return s
    if width <= 3: return s[:width]
    return s[:width - 3] + "..."


def _pad(s: str, width: int, align: str = "left") -> str:
    s = _trunc(s or "", width)
    pad = width - len(s)
    if pad <= 0: return s
    if align == "right": return (" " * pad) + s
    if align == "center":
        left = pad // 2
        return (" " * left) + s + (" " * (pad - left))
    return s + (" " * pad)


def _bg_cell(text: str, width: int, color: str | None, align: str = "left") -> str:
    text = (text or "").strip()
    if width >= 3:
        body = " " + _pad(text, width - 2, align) + " "
    else:
        body = _pad(text, width, align)
    if not color or color not in _BG:
        return body
    return f"{_BG[color]}{body}{_RST}"


def _step_label(step: str) -> str:
    s = (step or "").strip()
    if not s: return "-"
    if s in _STEP_LABELS: return _STEP_LABELS[s]
    return s.upper().replace("-", "_")


def _fail_detail(message: str = "", error: str = "") -> str:
    blob = f"{error} {message}".strip()
    low = blob.lower()
    if "turnstile" in low or "captcha" in low: return "CAPTCHA:FAIL"
    if "otp" in low: return "OTP:FAIL"
    if "oauth" in low: return "OAUTH:FAIL"
    if "token" in low: return "TOKEN:FAIL"
    if "login" in low: return "LOGIN:FAIL"
    if "signup" in low or "email taken" in low: return "SIGNUP:REJECT"
    if "proxy" in low: return "PROXY:FAIL"
    if "timeout" in low: return "TIMEOUT"
    raw = (error or message or "ERROR").strip()
    tag = re.sub(r"\s+", " ", raw).split(":")[0].split(" ")[0]
    return re.sub(r"[^A-Za-z0-9_]", "", tag).upper()[:24] or "ERROR"


def _fmt_dur(seconds: int | float) -> str:
    s = max(0, int(seconds))
    if s < 60: return f"{s}S"
    m, sec = divmod(s, 60)
    if m < 60: return f"{m}M{sec:02d}S" if sec else f"{m}M"
    h, m = divmod(m, 60)
    return f"{h}H{m:02d}M"


def _fmt_elapsed_clock(seconds: int | float) -> str:
    s = max(0, int(seconds))
    mm, ss = divmod(s, 60)
    hh, mm = divmod(mm, 60)
    if hh: return f"{hh}:{mm:02d}:{ss:02d}"
    return f"{mm:02d}:{ss:02d}"


def _progress_bar(done: int, total: int, width: int) -> str:
    if width <= 0: return ""
    if total <= 0: return f"{_BG['bar_empty']}{'░' * width}{_RST}"
    filled = max(0, min(width, int(width * min(done, total) / total)))
    empty_n = width - filled
    parts = []
    if filled: parts.append(f"{_BG['bar']}{'█' * filled}{_RST}")
    if empty_n: parts.append(f"{_BG['bar_empty']}{'░' * empty_n}{_RST}")
    return "".join(parts) if parts else f"{_BG['bar_empty']}{'░' * width}{_RST}"


def _term_width(min_w: int = 72, max_w: int = 100) -> int:
    try:
        w = shutil.get_terminal_size(fallback=(88, 40)).columns
    except Exception:
        w = 88
    return max(min_w, min(max_w, w))


def _row(cells: list[str], widths: list[int], aligns: list[str] | None = None, colors: list[str | None] | None = None) -> str:
    aligns = aligns or ["left"] * len(cells)
    colors = colors or [None] * len(cells)
    parts = [_bg_cell(str(cell), w, col, al) for cell, w, al, col in zip(cells, widths, aligns, colors)]
    return "│" + "│".join(parts) + "│"


def _sep(widths: list[int], left: str = "├", mid: str = "┼", right: str = "┤", fill: str = "─") -> str:
    return left + mid.join(fill * w for w in widths) + right


def _hline(inner: int, left: str = "├", right: str = "┤", fill: str = "─") -> str:
    return left + (fill * inner) + right


def _box_line(text: str, inner: int) -> str:
    vis = _vlen(text)
    if vis > inner:
        text = _trunc(_strip_ansi(text), inner)
        vis = len(text)
    pad = inner - vis
    return "│" + text + (" " * max(0, pad)) + "│"


class FarmHUD:
    def __init__(self) -> None:
        self.enabled = UI_MODE == "hud"
        self.total = 0
        self.ok = 0
        self.fail = 0
        self.batch_id = ""
        self.batch_dir = ""
        self.started = time.time()
        self._workers: dict[int, dict[str, Any]] = {}
        self._recent: list[dict[str, Any]] = []
        self._slock = threading.Lock()
        self._drawn_lines = 0
        self._started_draw = False
        self._log_fp = None
        self._real_stdout = sys.stdout
        self._color_tty = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

    def open_log(self, path: Path) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._log_fp = open(path, "a", encoding="utf-8")
            self._log_fp.write(f"\n===== FARM START {datetime.now(timezone.utc).isoformat()} =====\n")
            self._log_fp.flush()
        except Exception:
            self._log_fp = None

    def close_log(self) -> None:
        if self._log_fp:
            try: self._log_fp.close()
            except Exception: pass
            self._log_fp = None

    def _write_log_file(self, plain: str) -> None:
        if not self._log_fp: return
        try: self._log_fp.write(plain + "\n"); self._log_fp.flush()
        except Exception: pass

    def _emit_terminal_log(self, plain: str, result: str | None = None) -> None:
        if self.enabled and not VERBOSE: return
        line = plain
        if self._color_tty and result in ("OK", "FAIL", "STEP"):
            color = {"OK": "green", "FAIL": "red", "STEP": "cyan"}.get(result)
            if color and f"[{result}]" in plain:
                badge = _bg_cell(f" {result} ", len(result) + 2, color, "center")
                line = plain.replace(f"[{result}]", badge, 1)
        try: self._real_stdout.write(line + "\n"); self._real_stdout.flush()
        except Exception: pass

    def log_line(self, line: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        plain = f"{ts}  {line}"
        self._write_log_file(plain)
        self._emit_terminal_log(plain)

    def _log_event(self, result: str, attempt: int, email: str = "", detail: str = "") -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        em = (email or "").strip()
        det = (detail or "").strip()
        parts = [ts, f"[{result}]", f"#{attempt}"]
        if em: parts.append(em)
        if det: parts.append(det)
        plain = "  ".join(parts)
        self._write_log_file(plain)
        self._emit_terminal_log(plain, result=result)

    def start(self, total: int, batch_id: str = "", batch_dir: str = "") -> None:
        self.total = total
        self.ok = 0; self.fail = 0
        self.batch_id = batch_id; self.batch_dir = batch_dir
        self.started = time.time()
        self._workers.clear(); self._recent.clear()
        self._drawn_lines = 0; self._started_draw = False
        if self.enabled:
            try: self._real_stdout.write("\033[?25l"); self._real_stdout.flush()
            except Exception: pass
        self.render(force=True)

    def stop(self) -> None:
        if self.enabled:
            try: self._real_stdout.write("\033[?25h\n"); self._real_stdout.flush()
            except Exception: pass

    def set_progress(self, attempt: int, step: str, message: str = "", email: str = "") -> None:
        label = _step_label(step)
        with self._slock:
            now = time.time()
            w = self._workers.get(attempt)
            if not w:
                w = {"attempt": attempt, "email": email or "", "step": step, "label": label, "message": message, "t0": now, "step_t0": now}
            else:
                if step and step != w.get("step"): w["step_t0"] = now
                if email: w["email"] = email
                w["step"] = step; w["label"] = label; w["message"] = message
            w["updated"] = now
            self._workers[attempt] = w
            em = w.get("email") or email or ""
        self._log_event("STEP", attempt, em, label)
        self.render()

    def mark_ok(self, attempt: int, email: str, message: str = "ok") -> None:
        with self._slock:
            self.ok += 1
            w = self._workers.pop(attempt, None)
            t0 = (w or {}).get("t0", time.time())
            dur = _fmt_dur(time.time() - t0)
            em = email or (w or {}).get("email") or ""
            self._recent.append({"time": datetime.now().strftime("%H:%M:%S"), "result": "OK", "attempt": attempt, "email": em, "detail": dur})
            self._recent = self._recent[-10:]
        self._log_event("OK", attempt, em, dur)
        self.render(force=True)

    def mark_fail(self, attempt: int, message: str, error: str = "") -> None:
        with self._slock:
            self.fail += 1
            w = self._workers.pop(attempt, None)
            em = (w or {}).get("email") or ""
            step_label = (w or {}).get("label") or ""
            detail = _fail_detail(message, error)
            if step_label and detail in ("ERROR", "TIMEOUT", "FAIL") and ":" not in detail:
                if detail == "TIMEOUT": detail = f"{step_label}:TIMEOUT"
            self._recent.append({"time": datetime.now().strftime("%H:%M:%S"), "result": "FAIL", "attempt": attempt, "email": em, "detail": detail})
            self._recent = self._recent[-10:]
        self._log_event("FAIL", attempt, em, detail)
        self.render(force=True)

    def _status_for(self, w: dict[str, Any], now: float) -> tuple[str, str | None]:
        age = int(now - w.get("step_t0", w.get("t0", now)))
        label = w.get("label") or _step_label(w.get("step") or "")
        thresh = _STUCK_THRESHOLDS.get(label, _STUCK_DEFAULT)
        if age >= thresh: return "STUCK", "yellow"
        return "RUNNING", "cyan"

    def _content_email_width(self) -> int:
        longest = 0
        for w in self._workers.values(): longest = max(longest, len((w.get("email") or "").strip()))
        for ev in self._recent: longest = max(longest, len((ev.get("email") or "").strip()))
        content = max(24, longest or 24)
        return content + 2

    def _col_widths(self, term_w: int) -> tuple[list[int], list[int], int]:
        w_num, w_step, w_status, w_time = 5, 10, 10, 8
        w_email = self._content_email_width()
        worker_ws = [w_num, w_email, w_step, w_status, w_time]
        worker_inner = sum(worker_ws) + len(worker_ws) - 1
        r_time, r_result, r_num, r_detail = 10, 8, 5, 18
        r_email = w_email
        recent_ws = [r_time, r_result, r_num, r_email, r_detail]
        recent_inner = sum(recent_ws) + len(recent_ws) - 1
        stats_min = 58
        inner = max(worker_inner, recent_inner, stats_min)
        max_inner = max(40, term_w - 2)
        if inner > max_inner:
            overflow = inner - max_inner
            cut = min(overflow, max(0, w_email - 16))
            w_email -= cut; overflow -= cut
            if overflow > 0:
                cut_d = min(overflow, max(0, r_detail - 12))
                r_detail -= cut_d
            worker_ws = [w_num, w_email, w_step, w_status, w_time]
            recent_ws = [r_time, r_result, r_num, w_email, r_detail]
            inner = max_inner
        def _fill(ws: list[int], email_idx: int) -> list[int]:
            target = inner - (len(ws) - 1)
            cur = sum(ws)
            ws = list(ws)
            if cur < target: ws[email_idx] += target - cur
            elif cur > target: ws[email_idx] = max(14, ws[email_idx] - (cur - target))
            return ws
        worker_ws = _fill(worker_ws, 1)
        recent_ws = _fill(recent_ws, 3)
        return worker_ws, recent_ws, inner

    def _build_lines(self) -> list[str]:
        now = time.time()
        elapsed = now - self.started
        et = _fmt_elapsed_clock(elapsed)
        done = self.ok; running = len(self._workers); total = self.total
        pct = int(100 * done / total) if total else 0
        if elapsed >= 1 and done > 0:
            per_min = done / (elapsed / 60.0)
            rate_s = f"{per_min:.1f}/MIN"
            remain = max(0, total - done)
            eta_s = _fmt_dur((remain / per_min) * 60) if per_min > 0 and remain > 0 else "-"
        else:
            rate_s = "-/MIN"; eta_s = "-"
        term_w = _term_width()
        worker_ws, recent_ws, inner = self._col_widths(term_w)
        lines: list[str] = []
        lines.append("┌" + "─" * inner + "┐")
        count_txt = f"  {done}/{total}  {pct}%"
        bar_w = max(8, inner - len(count_txt) - 1)
        bar = _progress_bar(done, total, bar_w)
        bar_line_inner = " " + bar + count_txt
        vis = _vlen(bar_line_inner)
        if vis < inner: bar_line_inner = bar_line_inner + (" " * (inner - vis))
        elif vis > inner: bar_line_inner = _pad(_strip_ansi(bar_line_inner), inner)
        lines.append("│" + bar_line_inner + "│")
        lines.append(_hline(inner))
        stats = f" OK {self.ok}  ·  FAIL {self.fail}  ·  RUN {running}  ·  RATE {rate_s}  ·  ETA {eta_s}  ·  {et} "
        lines.append(_box_line(stats, inner))
        lines.append(_sep(worker_ws, left="├", mid="┬", right="┤"))
        _ctr = ["center"] * 5
        lines.append(_row(["#", "EMAIL", "STEP", "STATUS", "TIME"], worker_ws, aligns=_ctr))
        lines.append(_sep(worker_ws, left="├", mid="┼", right="┤"))
        workers = sorted(self._workers.values(), key=lambda x: x["attempt"])
        if not workers:
            lines.append(_row(["-", "-", "IDLE", "WAITING", "-"], worker_ws, aligns=_ctr, colors=[None, None, "gray", "gray", None]))
        else:
            show = workers[:12]
            for i, w in enumerate(show):
                if i > 0: lines.append(_sep(worker_ws, left="├", mid="┼", right="┤"))
                age = int(now - w.get("step_t0", w.get("t0", now)))
                status, scolor = self._status_for(w, now)
                em = (w.get("email") or "-").strip() or "-"
                label = w.get("label") or _step_label(w.get("step") or "")
                step_color = _STEP_COLORS.get(label, "cyan")
                lines.append(_row([str(w["attempt"]), em, label, status, _fmt_dur(age)], worker_ws, aligns=_ctr, colors=[None, None, step_color, scolor, None]))
            if len(workers) > 12:
                lines.append(_sep(worker_ws, left="├", mid="┼", right="┤"))
                lines.append(_row(["-", f"+{len(workers) - 12} MORE", "-", "-", "-"], worker_ws, aligns=_ctr))
        lines.append(_sep(worker_ws, left="├", mid="┴", right="┤"))
        lines.append(_box_line(" RECENT", inner))
        lines.append(_sep(recent_ws, left="├", mid="┬", right="┤"))
        lines.append(_row(["TIME", "RESULT", "#", "EMAIL", "DETAIL"], recent_ws, aligns=_ctr))
        lines.append(_sep(recent_ws, left="├", mid="┼", right="┤"))
        recent = list(reversed(self._recent[-10:]))
        if not recent:
            lines.append(_row(["-", "-", "-", "-", "-"], recent_ws, aligns=_ctr))
        else:
            for i, ev in enumerate(recent):
                if i > 0: lines.append(_sep(recent_ws, left="├", mid="┼", right="┤"))
                result = ev.get("result") or "-"
                rcolor = {"OK": "green", "FAIL": "red"}.get(result)
                att = ev.get("attempt")
                lines.append(_row([str(ev.get("time") or "-"), str(result), str(att) if att is not None else "-", str(ev.get("email") or "-"), str(ev.get("detail") or "-")], recent_ws, aligns=_ctr, colors=[None, rcolor, None, None, None]))
        lines.append("└" + "─" * inner + "┘")
        return lines

    def render(self, force: bool = False) -> None:
        if not self.enabled: return
        with self._slock:
            lines = self._build_lines()
            out = self._real_stdout
            try:
                if self._started_draw and self._drawn_lines > 0:
                    out.write(f"\033[{self._drawn_lines}A")
                for line in lines:
                    out.write("\033[2K" + line + "\n")
                if self._started_draw and self._drawn_lines > len(lines):
                    extra = self._drawn_lines - len(lines)
                    for _ in range(extra): out.write("\033[2K\n")
                    out.write(f"\033[{extra}A")
                out.flush()
                self._drawn_lines = len(lines)
                self._started_draw = True
            except Exception: pass

    async def ticker(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                if self.ok >= self.total and not self._workers: break
                self.render()
        except asyncio.CancelledError: return


HUD = FarmHUD()


def emit_progress(attempt: int, step: str, message: str, email: str = "") -> None:
    HUD.set_progress(attempt, step, message, email)


def emit_success(attempt: int, email: str, message: str) -> None:
    HUD.mark_ok(attempt, email, message)


def emit_failed(attempt: int, message: str, error: str = "") -> None:
    HUD.mark_fail(attempt, message, error)


def vlog(msg: str, attempt: int | None = None) -> None:
    prefix = f"#{attempt}  " if attempt is not None else ""
    HUD.log_line(prefix + msg)


# ── Email uniqueness ─────────────────────────────────────────────────────────
_used_emails: set[str] = set()
_emails_lock = asyncio.Lock()
_ALPHANUM = string.ascii_lowercase + string.digits


def _crypto_local_part(length: int) -> str:
    return "".join(secrets.choice(_ALPHANUM) for _ in range(length))


def _emails_from_json(path: Path) -> set[str]:
    out: set[str] = set()
    if not path.is_file(): return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            for row in data:
                if isinstance(row, dict):
                    e = (row.get("email") or "").lower().strip()
                    if e: out.add(e)
    except Exception: pass
    return out


def _load_used_emails() -> None:
    global _used_emails
    _used_emails = set()
    if USED_EMAILS_FILE.is_file():
        try:
            for line in USED_EMAILS_FILE.read_text(encoding="utf-8").splitlines():
                e = line.strip().lower()
                if e and not e.startswith("#"): _used_emails.add(e)
        except Exception: pass
    _used_emails |= _emails_from_json(RESULTS_ROOT / "accounts.json")
    if RESULTS_ROOT.is_dir():
        for batch in sorted(RESULTS_ROOT.glob("batch_*")):
            if batch.is_dir():
                _used_emails |= _emails_from_json(batch / "accounts.json")


def _persist_used_email(email: str) -> None:
    e = email.lower().strip()
    if not e: return
    USED_EMAILS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(USED_EMAILS_FILE, "a", encoding="utf-8") as f:
        f.write(e + "\n")


# ── Tempmail ─────────────────────────────────────────────────────────────────
_tempmail_tokens: dict[str, str] = {}
_tempmail_seen_ids: set[str] = set()


def _tempmail_headers(auth: bool = True) -> dict[str, str]:
    h = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "grok-farm/1.0"}
    if auth and MAIL_KEY: h["Authorization"] = f"Bearer {MAIL_KEY}"
    return h


def _tempmail_request(method: str, path: str, body: dict | None = None, auth: bool = True, timeout: float = 20) -> dict:
    url = f"{MAIL_API}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_tempmail_headers(auth=auth), method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        err_body = ""
        try: err_body = e.read().decode("utf-8", "replace")[:400]
        except Exception: pass
        raise RuntimeError(f"tempmail HTTP {e.code}: {err_body or e}") from e
    except Exception as e:
        raise RuntimeError(f"tempmail {method} {path} failed: {e}") from e
    if not raw.strip(): return {}
    payload = json.loads(raw)
    if isinstance(payload, dict) and payload.get("success") is False:
        err = payload.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else str(err)
        raise RuntimeError(f"tempmail API error: {msg or payload}")
    return payload if isinstance(payload, dict) else {"result": payload}


def _tempmail_create_mailbox_sync() -> str:
    if not MAIL_KEY: raise RuntimeError("GROK_TEMPMAIL_API_KEY required")
    body: dict[str, Any] = {"note": "grok-farm"}
    payload = _tempmail_request("POST", "/api/key/mailboxes", body=body, auth=True)
    result = payload.get("result") or {}
    email = (result.get("email") or "").strip().lower()
    token = (result.get("inbox_token") or "").strip()
    if not email or not token: raise RuntimeError(f"tempmail create missing fields: {result}")
    _tempmail_tokens[email] = token
    return email


def _tempmail_get_token(email: str) -> str | None:
    return _tempmail_tokens.get(email.lower().strip())


_XAI_CODE_RE = re.compile(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b")


def _is_plausible_xai_otp(code: str) -> bool:
    code = (code or "").upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", code): return False
    left, right = code.split("-", 1)
    if re.fullmatch(r"[A-Z]+", left) and re.fullmatch(r"\d+", right): return False
    if re.fullmatch(r"\d+", left) and re.fullmatch(r"\d+", right): return False
    if code in {"PER-100", "RGB-255", "PX-16", "EM-16", "REM-16", "MS-300", "MS-200"}: return False
    return True


def _extract_xai_code(subject: str, body: str) -> str | None:
    subj_l = (subject or "").upper()
    if "XAI" in subj_l or "CONFIRMATION" in subj_l:
        for m in _XAI_CODE_RE.finditer(subj_l):
            code = m.group(1).upper()
            if _is_plausible_xai_otp(code): return code
    for m in _XAI_CODE_RE.finditer(subj_l):
        code = m.group(1).upper()
        if _is_plausible_xai_otp(code): return code
    plain_body = body or ""
    plain_body = re.sub(r"<style[\s\S]*?</style>", " ", plain_body, flags=re.I)
    plain_body = re.sub(r"<script[\s\S]*?</script>", " ", plain_body, flags=re.I)
    plain_body = re.sub(r"<[^>]+>", " ", plain_body)
    for m in _XAI_CODE_RE.finditer(plain_body.upper()):
        code = m.group(1).upper()
        if _is_plausible_xai_otp(code): return code
    return None


def _tempmail_msg_looks_xai(msg: dict) -> bool:
    blob = " ".join(str(msg.get(k) or "") for k in ("subject", "sender", "text_body", "html_body")).lower()
    return ("xai" in blob) or ("x.ai" in blob) or ("confirmation code" in blob)


def _tempmail_poll_once(email: str) -> str | None:
    token = _tempmail_get_token(email)
    if not token: return None
    try:
        payload = _tempmail_request("GET", f"/api/inbox/{token}", auth=False)
        result = payload.get("result") or {}
        messages = sorted(
            [m for m in (result.get("messages") or []) if isinstance(m, dict)],
            key=lambda m: (0 if _tempmail_msg_looks_xai(m) else 1, str(m.get("id") or ""))
        )
        for msg in messages:
            mid = str(msg.get("id") or "")
            if mid and mid in _tempmail_seen_ids: continue
            subject = msg.get("subject") or ""
            body = " ".join(filter(None, [msg.get("text_body") or "", msg.get("html_body") or ""]))
            code = _extract_xai_code(subject, body)
            if mid: _tempmail_seen_ids.add(mid)
            if code: return code
        latest = result.get("latest_otp")
        if isinstance(latest, str) and latest.upper().replace("-", "").isalnum():
            c = _extract_xai_code("", latest)
            if c: return c
    except Exception as e:
        vlog(f"[MAIL] poll warn: {e}")
    return None


def wait_otp(email: str, timeout: int = 120) -> str:
    t0 = time.time()
    while time.time() - t0 < timeout:
        code = _tempmail_poll_once(email)
        if code: return code.replace("-", "")
        time.sleep(1.5)
    raise TimeoutError(f"OTP timeout for {email}")


async def generate_email() -> str:
    async with _emails_lock:
        for _ in range(200):
            addr = await asyncio.to_thread(_tempmail_create_mailbox_sync)
            key = addr.lower()
            if key not in _used_emails:
                _used_emails.add(key)
                _persist_used_email(key)
                return addr
    raise RuntimeError("Could not generate unique email after 200 attempts")


def random_name() -> tuple[str, str]:
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)


# ── Solver ────────────────────────────────────────────────────────────────────
def solver_poll(task_id: str, timeout: float = 120) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = plain.get(f"{SOLVER}/result", params={"id": task_id}, timeout=30)
        j = r.json() if "application/json" in (r.headers.get("content-type") or "") else {}
        st = j.get("status")
        if st == "success": return j
        if st == "error": raise RuntimeError(f"solver error: {j}")
        time.sleep(1.2)
    raise TimeoutError(f"solver timeout {task_id}")


def _wait_solver(kind: str, url: str, timeout: int = 90, proxy: str | None = None, **extra) -> dict:
    for attempt in range(40):
        params: dict[str, Any] = {"url": url, "timeout": timeout, **extra}
        if proxy: params["proxy"] = proxy
        r = plain.get(f"{SOLVER}/{kind}", params=params, timeout=30)
        j = r.json() if "application/json" in (r.headers.get("content-type") or "") else {}
        if j.get("task_id"): return solver_poll(j["task_id"], timeout=timeout + 30)
        vlog(f"[SOLVER] {kind} busy try={attempt + 1}")
        time.sleep(3)
    raise RuntimeError(f"solver {kind} unavailable")


def get_clearance(url: str = f"{BASE}/sign-up", proxy: str | None = None) -> dict:
    return _wait_solver("clearance", url, proxy=proxy)


def get_turnstile(url: str = f"{BASE}/sign-up", sitekey: str = SITEKEY, proxy: str | None = None) -> str:
    result = _wait_solver("turnstile", url, sitekey=sitekey, proxy=proxy)
    value = result.get("value") or result.get("token") or ""
    if not value: raise RuntimeError(f"turnstile no token: {result}")
    return value


# ── gRPC-Web protobuf ────────────────────────────────────────────────────────
def _varint(n: int) -> bytes:
    out = bytearray()
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n & 0x7F)
    return bytes(out)


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def pb_str(field: int, value: str) -> bytes:
    b = value.encode("utf-8")
    return _key(field, 2) + _varint(len(b)) + b


def pb_msg(field: int, value: bytes) -> bytes:
    return _key(field, 2) + _varint(len(value)) + value


def pb_varint(field: int, value: int) -> bytes:
    return _key(field, 0) + _varint(value)


def grpc_web_frame(msg: bytes) -> bytes:
    return b"\x00" + len(msg).to_bytes(4, "big") + msg


def parse_grpc_web(data: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {"frames": [], "trailers": {}, "raw": data}
    i = 0
    while i + 5 <= len(data):
        flags = data[i]
        ln = int.from_bytes(data[i + 1: i + 5], "big")
        i += 5
        payload = data[i: i + ln]
        i += ln
        if flags & 0x80:
            for line in payload.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    k, _, v = line.partition(":")
                    out["trailers"][k.strip()] = v.strip()
        else:
            out["frames"].append(payload)
    return out


def parse_pb_fields(data: bytes) -> list[tuple]:
    i = 0
    out = []
    while i < len(data):
        key = 0; shift = 0
        while i < len(data):
            b = data[i]; i += 1
            key |= (b & 0x7F) << shift
            if not (b & 0x80): break
            shift += 7
        if i >= len(data): break
        fn, wt = key >> 3, key & 7
        if wt == 0:
            val = 0; shift = 0
            while i < len(data):
                b_ = data[i]; i += 1
                val |= (b_ & 0x7F) << shift
                if not (b_ & 0x80): break
                shift += 7
            out.append((fn, "varint", val))
        elif wt == 2:
            ln = 0; shift = 0
            while i < len(data):
                b_ = data[i]; i += 1
                ln |= (b_ & 0x7F) << shift
                if not (b_ & 0x80): break
                shift += 7
            if i + ln > len(data): break
            val = data[i: i + ln]; i += ln
            try: out.append((fn, "str", val.decode("utf-8")))
            except Exception: out.append((fn, "bytes", val))
        else: break
    return out


def msg_anti_abuse(turnstile_token: str) -> bytes:
    return pb_str(1, turnstile_token)


def msg_create_user_and_session(email: str, given: str, family: str, password: str, code: str, turnstile: str) -> bytes:
    user = pb_str(1, given) + pb_str(2, family) + pb_str(3, email) + pb_str(5, password) + pb_varint(6, 1)
    return pb_msg(1, user) + pb_msg(6, msg_anti_abuse(turnstile)) + pb_str(9, code)


def msg_create_session_email_password(email: str, password: str, turnstile: str = "") -> bytes:
    ep = pb_str(1, email) + pb_str(2, password)
    cred = pb_msg(1, ep)
    parts = [pb_msg(1, cred)]
    if turnstile: parts.append(pb_msg(4, msg_anti_abuse(turnstile)))
    return b"".join(parts)


def extract_session_cookie(parsed: dict) -> str | None:
    for fr in parsed.get("frames") or []:
        for fn, typ, val in parse_pb_fields(fr):
            if fn == 2 and typ == "str" and str(val).startswith("eyJ"): return str(val)
            if typ == "bytes" and isinstance(val, (bytes, bytearray)):
                try: nested = parse_pb_fields(bytes(val))
                except Exception: nested = []
                for nfn, ntyp, nval in nested:
                    if nfn == 2 and ntyp == "str" and str(nval).startswith("eyJ"): return str(nval)
        if b"eyJ" in fr:
            try:
                s = fr.decode("utf-8", "ignore")
                m = re.search(r"eyJ[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+", s)
                if m: return m.group(0)
            except Exception: pass
    return None


# ── HTTP client ──────────────────────────────────────────────────────────────
class XAIHttp:
    def __init__(self, proxy: str | None):
        self.proxy = proxy
        self.ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0"
        proxies = {"http": proxy, "https": proxy} if proxy else None
        self.s = creq.Session(impersonate=IMPERSONATE, proxies=proxies)

    def seed_clearance(self, clr: dict) -> None:
        self.ua = clr.get("user_agent") or self.ua
        for part in (clr.get("cookies") or "").split(";"):
            part = part.strip()
            if "=" in part:
                k, _, v = part.partition("=")
                self.s.cookies.set(k.strip(), v.strip())
        if "xai_anon_id" not in dict(self.s.cookies):
            self.s.cookies.set("xai_anon_id", str(uuid.uuid4()))
        if "__cuid" not in dict(self.s.cookies):
            self.s.cookies.set("__cuid", str(uuid.uuid4()))

    def set_sso(self, session_cookie: str) -> None:
        for domain in (".x.ai", "accounts.x.ai", "auth.x.ai"):
            self.s.cookies.set("sso", session_cookie, domain=domain)

    def get(self, url: str, **kw):
        headers = kw.pop("headers", {})
        headers.setdefault("user-agent", self.ua)
        return self.s.get(url, headers=headers, timeout=kw.pop("timeout", 45), **kw)

    def rpc(self, method: str, msg: bytes, referer: str = f"{BASE}/sign-up"):
        headers = {
            "content-type": "application/grpc-web+proto", "accept": "*/*",
            "origin": BASE, "referer": referer, "x-grpc-web": "1",
            "x-user-agent": "connect-es/2.1.1", "user-agent": self.ua,
        }
        r = self.s.post(f"{AUTH}/{method}", data=grpc_web_frame(msg), headers=headers, timeout=45)
        parsed = parse_grpc_web(r.content)
        return r, parsed

    def ok(self, parsed: dict, status: int) -> bool:
        if status != 200: return False
        trailers = parsed.get("trailers") or {}
        frames = parsed.get("frames") or []
        if not trailers and not frames: return False
        return str(trailers.get("grpc-status", "0")) in ("0", "")


# ── OAuth ─────────────────────────────────────────────────────────────────────
_discovered_action_id: str | None = None


def discover_oauth_action_id(client: XAIHttp, consent_html: str) -> str:
    global _discovered_action_id
    if _discovered_action_id: return _discovered_action_id
    paths = []
    for pth in re.findall(r"/_next/static/chunks/[^\"\\'\s]+", consent_html or ""):
        pth = pth.rstrip("\\")
        if pth.endswith(".js") and pth not in paths: paths.append(pth)
    found = ""
    for path in paths:
        url = f"https://accounts.x.ai{path}"
        try: r = client.get(url, timeout=45)
        except Exception: continue
        if getattr(r, "status_code", 0) != 200: continue
        t = r.text or ""
        if "submitOAuth2Consent" not in t and "createServerReference" not in t: continue
        m = re.search(r'createServerReference\)\("([a-f0-9]{40,64})",[^,]+,[^,]+,[^,]+,"submitOAuth2Consent"', t)
        if not m: m = re.search(r'createServerReference\("([a-f0-9]{40,64})",[^,]+,[^,]+,[^,]+,"submitOAuth2Consent"', t)
        if m:
            found = m.group(1)
            vlog(f"[OAUTH] action id {found[:16]}... from {path.split('/')[-1]}")
            break
    if found: _discovered_action_id = found; return found
    vlog(f"[OAUTH] action id miss - fallback {SERVER_ACTION_ID[:16]}...")
    return SERVER_ACTION_ID


def parse_oauth_action_response(text: str) -> dict:
    text = text or ""
    for line in text.splitlines():
        line = line.strip()
        if not line: continue
        payload_s = line
        if re.match(r"^\d+:", line): payload_s = line.split(":", 1)[1]
        try: obj = json.loads(payload_s)
        except Exception: obj = None
        if isinstance(obj, dict) and (obj.get("code") or obj.get("success") is not None): return obj
    try:
        j = json.loads(text)
        if isinstance(j, dict): return j
    except Exception: pass
    m = re.search(r'"code"\s*:\s*"([^"]+)"', text)
    if m: return {"success": True, "action": "allow", "code": m.group(1)}
    return {"raw": text[:1500]}


def submit_oauth2_consent(client: XAIHttp, consent_url: str, payload: dict, consent_html: str = "") -> dict:
    candidates = []
    if consent_html:
        discovered = discover_oauth_action_id(client, consent_html)
        if discovered not in candidates: candidates.append(discovered)
    if SERVER_ACTION_ID not in candidates: candidates.append(SERVER_ACTION_ID)
    body = json.dumps([payload])
    last: dict = {"raw": "no attempts"}
    for aid in candidates:
        headers = {
            "user-agent": client.ua, "origin": BASE, "referer": consent_url,
            "accept": "text/x-component", "next-action": aid,
            "content-type": "text/plain;charset=UTF-8",
        }
        r = client.s.post(consent_url, data=body, headers=headers, timeout=45)
        text = r.text or ""
        vlog(f"[OAUTH] action {aid[:18]}... status={r.status_code} len={len(text)}")
        if r.status_code == 404 or "Server action not found" in text:
            last = {"raw": text[:200], "action_id": aid, "status": r.status_code}
            continue
        parsed = parse_oauth_action_response(text)
        if parsed.get("code") or parsed.get("success") is True:
            global _discovered_action_id
            _discovered_action_id = aid
            return parsed
        last = parsed if isinstance(parsed, dict) else {"raw": str(parsed)[:500]}
    return last


def exchange_code(code: str, verifier: str) -> dict:
    form = urlencode({
        "grant_type": "authorization_code", "client_id": XAI_CLIENT_ID,
        "code": code, "redirect_uri": XAI_REDIRECT, "code_verifier": verifier,
    })
    r = plain.post(XAI_TOKEN_URL, data=form, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    data = r.json()
    expires_in = int(data.get("expires_in") or 21600)
    tokens = {
        "access_token": data.get("access_token"),
        "refresh_token": data.get("refresh_token"),
        "expires_at": datetime.fromtimestamp(time.time() + expires_in, timezone.utc).isoformat().replace("+00:00", "Z"),
        "expires_in": expires_in,
        "client_id": XAI_CLIENT_ID, "auth_mode": "oidc",
        "scope": data.get("scope") or XAI_SCOPE,
    }
    if data.get("id_token"): tokens["id_token"] = data["id_token"]
    return tokens


def obtain_oidc_tokens(client: XAIHttp, email: str) -> dict:
    verifier_raw = secrets.token_bytes(96)
    verifier = base64.urlsafe_b64encode(verifier_raw).decode("ascii").rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    state = secrets.token_urlsafe(16)
    nonce = secrets.token_hex(12)
    params = {
        "response_type": "code", "client_id": XAI_CLIENT_ID,
        "redirect_uri": XAI_REDIRECT, "scope": XAI_SCOPE,
        "code_challenge": challenge, "code_challenge_method": "S256",
        "state": state, "nonce": nonce,
        "plan": "generic", "referrer": "cli-proxy-api",
    }
    auth_url = f"{XAI_AUTHORIZE}?{urlencode(params)}"
    r1 = client.get(auth_url, allow_redirects=False)
    loc = r1.headers.get("location") or ""
    if loc.startswith("/"): loc = "https://auth.x.ai" + loc
    if not loc: raise RuntimeError("authorize did not redirect - sso cookie missing?")
    r2 = client.get(loc, allow_redirects=False)
    html = r2.text or ""
    consent_url = str(r2.url)
    user_id = ""
    m = re.search(r'"userId"\s*:\s*"([0-9a-f-]{36})"', html)
    if m: user_id = m.group(1)
    consent_payload = {
        "action": "allow", "clientId": XAI_CLIENT_ID, "redirectUri": XAI_REDIRECT,
        "scope": XAI_SCOPE, "state": state, "codeChallenge": challenge,
        "codeChallengeMethod": "S256", "nonce": nonce,
        "principalType": "User", "principalId": user_id or "",
        "referrer": "cli-proxy-api",
    }
    result = submit_oauth2_consent(client, consent_url, consent_payload, consent_html=html)
    code = result.get("code") if isinstance(result, dict) else None
    if not code: raise RuntimeError(f"consent failed: {result}")
    tokens = exchange_code(code, verifier)
    tokens["email"] = email
    return tokens


# ── Single account signup ────────────────────────────────────────────────────
def create_user_with_retries(attempt_num: int, client: XAIHttp, email: str, given: str, family: str, code: str, tries: int = 3, proxy: str | None = None) -> str:
    for retry in range(1, tries + 1):
        emit_progress(attempt_num, "turnstile", f"try {retry}/{tries}", email)
        turnstile = get_turnstile(f"{BASE}/sign-up", proxy=proxy)
        msg = msg_create_user_and_session(email=email, given=given, family=family, password=PASSWORD, code=code, turnstile=turnstile)
        emit_progress(attempt_num, "rpc_create_user", f"try {retry}/{tries}", email)
        r, p = client.rpc("CreateUserAndSession", msg)
        sc = extract_session_cookie(p)
        if sc: return sc
        vlog(f"[RPC] CreateUserAndSession no session retry={retry}/{tries}")
        if not client.ok(p, r.status_code):
            time.sleep(1.5 * retry)
            continue
        time.sleep(1.0)
    for retry in range(1, tries + 1):
        emit_progress(attempt_num, "rpc_login", f"fallback {retry}/{tries}", email)
        t2 = get_turnstile(f"{BASE}/sign-in", proxy=proxy)
        r2, p2 = client.rpc("CreateSession", msg_create_session_email_password(email, PASSWORD, turnstile=t2), referer=f"{BASE}/sign-in")
        sc = extract_session_cookie(p2)
        if sc: return sc
        vlog(f"[RPC] CreateSession fail retry={retry}/{tries}")
        time.sleep(1.5 * retry)
    raise RuntimeError(f"no session_cookie for {email}")


def run_signup(attempt_num: int, max_accounts: int) -> dict:
    emit_progress(attempt_num, "start", f"attempt {attempt_num}/{max_accounts}")

    emit_progress(attempt_num, "clearance", "getting clearance...")
    proxy = pick_proxy_sync()
    clr = get_clearance(f"{BASE}/sign-up", proxy=proxy)
    emit_progress(attempt_num, "clearance", f"ok {clr.get('elapsed_time')}s", "")

    client = XAIHttp(proxy)
    client.seed_clearance(clr)
    r = client.get(f"{BASE}/sign-up")
    blocked = "Attention Required" in (r.text or "")
    if r.status_code != 200 or blocked:
        vlog(f"[HTTP] CF blocked, retry with new proxy...")
        proxy = pick_proxy_sync(exclude={proxy})
        clr = get_clearance(f"{BASE}/sign-up", proxy=proxy)
        client = XAIHttp(proxy)
        client.seed_clearance(clr)
        r = client.get(f"{BASE}/sign-up")
        blocked = "Attention Required" in (r.text or "")
        if r.status_code != 200 or blocked:
            raise RuntimeError("CF still blocking after proxy rotate")

    email = _tempmail_create_mailbox_sync()
    emit_progress(attempt_num, "mail_create", email, email)

    given, family = random_name()

    emit_progress(attempt_num, "rpc_create_email", "CreateEmailValidationCode", email)
    r, p = client.rpc("CreateEmailValidationCode", pb_str(1, email))
    if not client.ok(p, r.status_code): raise RuntimeError("CreateEmailValidationCode failed")

    emit_progress(attempt_num, "mail_otp", "waiting...", email)
    code = wait_otp(email, GROK_OTP_TIMEOUT)
    emit_progress(attempt_num, "mail_otp", code, email)

    emit_progress(attempt_num, "rpc_verify_email", "VerifyEmailValidationCode", email)
    r, p = client.rpc("VerifyEmailValidationCode", pb_str(1, email) + pb_str(2, code))
    if not client.ok(p, r.status_code): raise RuntimeError(f"Verify failed")

    emit_progress(attempt_num, "rpc_validate", "ValidatePassword", email)
    r, p = client.rpc("ValidatePassword", pb_str(2, given) + pb_str(3, family) + pb_str(4, email) + pb_str(5, PASSWORD))

    session_cookie = create_user_with_retries(attempt_num, client, email, given, family, code, tries=3, proxy=proxy)
    client.set_sso(session_cookie)

    emit_progress(attempt_num, "oauth_authorize", "authorize...", email)
    tokens = obtain_oidc_tokens(client, email)

    emit_progress(attempt_num, "oauth_token", "tokens ok", email)

    result = {"email": email, "password": PASSWORD, "given": given, "family": family, "sso": session_cookie, "proxy": proxy, "tokens": tokens}
    return result


def login_existing_with_retries(
    attempt_num: int,
    client: "XAIHttp",
    email: str,
    password: str,
    tries: int = 3,
    proxy: str | None = None,
) -> str:
    """CreateSession for an existing xAI account (reauth path — no tempmail)."""
    for retry in range(1, tries + 1):
        emit_progress(attempt_num, "turnstile", f"reauth {retry}/{tries}", email)
        t = get_turnstile(f"{BASE}/sign-in", proxy=proxy)
        emit_progress(attempt_num, "rpc_login", f"reauth {retry}/{tries}", email)
        r, p = client.rpc(
            "CreateSession",
            msg_create_session_email_password(email, password, turnstile=t),
            referer=f"{BASE}/sign-in",
        )
        sc = extract_session_cookie(p)
        if sc:
            return sc
        vlog(f"[RPC] CreateSession reauth fail retry={retry}/{tries}")
        time.sleep(1.5 * retry)
    raise RuntimeError(f"no session_cookie for reauth {email}")


def run_reauth(attempt_num: int, max_accounts: int, email: str, password: str) -> dict:
    """Login existing email+password → OIDC tokens (no mailbox / signup)."""
    email = (email or "").strip()
    password = password or ""
    if not email or not password:
        raise RuntimeError("email and password required for reauth")

    emit_progress(attempt_num, "start", f"reauth {attempt_num}/{max_accounts}", email)

    emit_progress(attempt_num, "clearance", "getting clearance...", email)
    proxy = pick_proxy_sync()
    clr = get_clearance(f"{BASE}/sign-in", proxy=proxy)
    emit_progress(attempt_num, "clearance", f"ok {clr.get('elapsed_time')}s", email)

    client = XAIHttp(proxy)
    client.seed_clearance(clr)
    r = client.get(f"{BASE}/sign-in")
    blocked = "Attention Required" in (r.text or "")
    if r.status_code != 200 or blocked:
        vlog("[HTTP] CF blocked on sign-in, retry with new proxy...")
        proxy = pick_proxy_sync(exclude={proxy})
        clr = get_clearance(f"{BASE}/sign-in", proxy=proxy)
        client = XAIHttp(proxy)
        client.seed_clearance(clr)
        r = client.get(f"{BASE}/sign-in")
        blocked = "Attention Required" in (r.text or "")
        if r.status_code != 200 or blocked:
            raise RuntimeError("CF still blocking after proxy rotate")

    session_cookie = login_existing_with_retries(
        attempt_num, client, email, password, tries=3, proxy=proxy
    )
    client.set_sso(session_cookie)

    emit_progress(attempt_num, "oauth_authorize", "authorize...", email)
    tokens = obtain_oidc_tokens(client, email)
    emit_progress(attempt_num, "oauth_token", "tokens ok", email)

    return {
        "email": email,
        "password": password,
        "sso": session_cookie,
        "proxy": proxy,
        "tokens": tokens,
    }


# ── Batch management ─────────────────────────────────────────────────────────
BATCH_ID = ""
BATCH_DIR: Path = RESULTS_ROOT
RESULTS_JSON: Path = RESULTS_ROOT / "accounts.json"
RESULTS_TXT: Path = RESULTS_ROOT / "accounts.txt"
FAILED_JSON: Path = RESULTS_ROOT / "failed.json"


def init_batch(max_accounts: int, concurrent: int) -> str:
    global BATCH_ID, BATCH_DIR, RESULTS_JSON, RESULTS_TXT, FAILED_JSON
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    short = secrets.token_hex(3)
    BATCH_ID = f"{stamp}_{short}"
    BATCH_DIR = RESULTS_ROOT / f"batch_{BATCH_ID}"
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_JSON = BATCH_DIR / "accounts.json"
    RESULTS_TXT = BATCH_DIR / "accounts.txt"
    FAILED_JSON = BATCH_DIR / "failed.json"
    RESULTS_JSON.write_text("[]\n", encoding="utf-8")
    RESULTS_TXT.write_text("", encoding="utf-8")
    FAILED_JSON.write_text("[]\n", encoding="utf-8")
    meta = {"batch_id": BATCH_ID, "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "max_accounts": max_accounts, "concurrent": concurrent}
    (BATCH_DIR / "batch_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"[BATCH] id={BATCH_ID}", flush=True)
    print(f"[BATCH] dir={BATCH_DIR}", flush=True)
    return BATCH_ID


def save_result(result: dict) -> None:
    rec = {"email": result["email"], "password": result["password"], "given": result.get("given"), "family": result.get("family"), "proxy": result.get("proxy"), "tokens": result.get("tokens"), "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    _persist_used_email(result["email"])
    accounts = json.loads(RESULTS_JSON.read_text(encoding="utf-8")) if RESULTS_JSON.exists() else []
    accounts.append(rec)
    RESULTS_JSON.write_text(json.dumps(accounts, indent=2) + "\n", encoding="utf-8")
    tok = result.get("tokens") or {}
    with open(RESULTS_TXT, "a", encoding="utf-8") as f:
        f.write(f"{result['email']}|{result['password']}|{(tok.get('access_token') or '')[:20]}...|{tok.get('refresh_token', '')}|{tok.get('expires_at', '')}\n")


def save_failure(error: str) -> None:
    failed = json.loads(FAILED_JSON.read_text(encoding="utf-8")) if FAILED_JSON.exists() else []
    failed.append({"error": error, "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})
    FAILED_JSON.write_text(json.dumps(failed, indent=2) + "\n", encoding="utf-8")


# ── Main ─────────────────────────────────────────────────────────────────────
def _prompt_int(text: str, default: int, min_v: int = 1, max_v: int = 1000) -> int:
    try: raw = input(f"  {text} [{default}]: ").strip()
    except EOFError: return default
    if not raw: return default
    try: return max(min_v, min(max_v, int(raw)))
    except ValueError: return default


def _prompt_yes_no(question: str, default: bool = True) -> bool:
    try: raw = input(f"  {question} [y/n]: ").strip().lower()
    except EOFError: return default
    if raw == "": return default
    return raw in ("y", "yes", "1", "true")


async def _worker(
    num: int,
    target: int,
    semaphore: asyncio.Semaphore,
    accounts: list,
    failures: list,
    push_failures: list,
    counter_lock: asyncio.Lock,
    push_on: bool,
    reauth_job: dict | None = None,
) -> None:
    async with semaphore:
        try:
            if reauth_job:
                result = await asyncio.to_thread(
                    run_reauth,
                    num,
                    target,
                    str(reauth_job.get("email") or ""),
                    str(reauth_job.get("password") or ""),
                )
            else:
                result = await asyncio.to_thread(run_signup, num, target)
            emit_success(num, result["email"], "ok")
            async with counter_lock: accounts.append(result)
            await asyncio.to_thread(save_result, result)
            if push_on and GROK_PUSH_MODE != "batch_end":
                try:
                    resp = await asyncio.to_thread(push_one_farm_result, result)
                    imported = int((resp or {}).get("imported") or 0) if isinstance(resp, dict) else 0
                    if imported < 1:
                        async with counter_lock:
                            push_failures.append({
                                "email": result.get("email"),
                                "error": f"imported={imported}",
                                "resp": resp,
                            })
                except Exception as pe:
                    async with counter_lock:
                        push_failures.append({"email": result.get("email"), "error": str(pe)})
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            emit_failed(num, err)
            async with counter_lock: failures.append(err)
            await asyncio.to_thread(save_failure, err)


async def main():
    args, no_push_flag = parse_push_cli_flags(sys.argv[1:])
    push_on = push_enabled_from_env(no_push_flag=no_push_flag)

    arg_count: int | None = None
    arg_conc: int | None = None
    skip_prompt = False
    reauth_file: str | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-n", "--count", "--max") and i + 1 < len(args): arg_count = int(args[i + 1]); i += 2; continue
        if a in ("-c", "--concurrent") and i + 1 < len(args): arg_conc = int(args[i + 1]); i += 2; continue
        if a in ("-y", "--yes", "--non-interactive"): skip_prompt = True; i += 1; continue
        if a == "--reauth-file" and i + 1 < len(args):
            reauth_file = args[i + 1]
            i += 2
            continue
        if a in ("-h", "--help"):
            print(
                "Usage: http_farm.py [-n COUNT] [-c CONCURRENT] [-y] [--no-push|--push]\n"
                "       http_farm.py --reauth-file PATH [-c CONCURRENT] [-y] [--push]\n"
                "  -n/--count       accounts this batch (signup mode)\n"
                "  -c/--concurrent  parallel workers\n"
                "  -y/--yes         non-interactive\n"
                "  --reauth-file    JSON list [{email,password}, ...] — login existing, no tempmail\n"
                "  --no-push        skip etteum import push\n"
                "  --push           enable etteum import push (default)\n"
            )
            sys.exit(0)
        i += 1

    reauth_jobs: list[dict] = []
    if reauth_file:
        p = Path(reauth_file)
        if not p.is_file():
            print(f"ERROR: --reauth-file not found: {reauth_file}", flush=True)
            sys.exit(2)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"ERROR: invalid reauth JSON: {e}", flush=True)
            sys.exit(2)
        if not isinstance(raw, list) or not raw:
            print("ERROR: --reauth-file must be a non-empty JSON array", flush=True)
            sys.exit(2)
        for row in raw:
            if not isinstance(row, dict):
                continue
            em = str(row.get("email") or "").strip()
            pw = str(row.get("password") or "").strip()
            if em and pw:
                reauth_jobs.append({"email": em, "password": pw})
        if not reauth_jobs:
            print("ERROR: no valid {email,password} entries in reauth file", flush=True)
            sys.exit(2)
        # Reauth does not need tempmail.
    elif not MAIL_KEY:
        print("ERROR: set GROK_TEMPMAIL_API_KEY in .env", flush=True)
        sys.exit(2)

    if push_on:
        ok, msg = preflight_etteum(ETTEUM_URL, ETTEUM_API_KEY)
        if not ok:
            print(f"ERROR: etteum preflight failed: {msg}", flush=True)
            sys.exit(2)

    _bi = __builtins__
    _orig_p = _bi.print
    _bi.print = lambda *a, **k: None
    try: _load_used_emails()
    finally: _bi.print = _orig_p

    if reauth_jobs:
        max_accounts = len(reauth_jobs)
        concurrent = arg_conc if arg_conc is not None else CONCURRENT
        skip_prompt = True
    elif skip_prompt:
        max_accounts = arg_count if arg_count is not None else MAX_ACCOUNTS
        concurrent = arg_conc if arg_conc is not None else CONCURRENT
    else:
        max_accounts = arg_count if arg_count is not None else _prompt_int("Total accounts", MAX_ACCOUNTS)
        concurrent = arg_conc if arg_conc is not None else _prompt_int("Total concurrency", CONCURRENT)
        if not _prompt_yes_no(f"Start {max_accounts} accounts with {concurrent} concurrency", True):
            print("Cancelled."); sys.exit(0)
        sys.stdout.write("\033[3A")
        for _ in range(3): sys.stdout.write("\033[2K\n")
        sys.stdout.write("\033[3A")
        sys.stdout.flush()

    max_accounts = max(1, min(1000, int(max_accounts)))
    concurrent = max(1, min(20, int(concurrent)))

    _bi.print = lambda *a, **k: None
    try: init_batch(max_accounts, concurrent)
    finally: _bi.print = _orig_p

    log_path = BATCH_DIR / "farm.log"
    HUD.open_log(log_path)
    HUD.start(max_accounts, batch_id=BATCH_ID, batch_dir=str(BATCH_DIR))

    _orig_print2 = _orig_p
    if HUD.enabled and not VERBOSE:
        _orig_print2 = _bi.print
        def _quiet_print(*_a, **_k):
            sep = _k.get("sep", " ")
            msg = sep.join(str(x) for x in _a)
            HUD.log_line(msg)
        _bi.print = _quiet_print

    accounts: list = []
    failures: list = []
    push_failures: list = []
    semaphore = asyncio.Semaphore(concurrent)
    counter_lock = asyncio.Lock()
    started = time.time()
    tick = asyncio.create_task(HUD.ticker())

    try:
        tasks = []
        for num in range(1, max_accounts + 1):
            if SPAWN_DELAY > 0 and num > 1: await asyncio.sleep(SPAWN_DELAY)
            job = reauth_jobs[num - 1] if reauth_jobs else None
            t = asyncio.create_task(
                _worker(
                    num,
                    max_accounts,
                    semaphore,
                    accounts,
                    failures,
                    push_failures,
                    counter_lock,
                    push_on,
                    reauth_job=job,
                )
            )
            tasks.append(t)
        await asyncio.gather(*tasks)
    except KeyboardInterrupt:
        print("\nInterrupted.", flush=True)
    finally:
        tick.cancel()
        try: await tick
        except (asyncio.CancelledError, Exception): pass
        _bi.print = _orig_print2 if HUD.enabled else _orig_p
        HUD.stop()
        HUD.close_log()

    if push_on and GROK_PUSH_MODE == "batch_end" and accounts:
        try:
            items = [account_to_import_item(a) for a in accounts]
            resp = push_accounts_to_etteum(items)
            imported = int((resp or {}).get("imported") or 0) if isinstance(resp, dict) else 0
            if imported < len(accounts):
                for a in accounts:
                    push_failures.append({
                        "email": a.get("email"),
                        "error": f"batch imported={imported}/{len(accounts)}",
                        "resp": resp,
                    })
        except Exception as pe:
            for a in accounts:
                push_failures.append({"email": a.get("email"), "error": str(pe)})

    if push_failures:
        (BATCH_DIR / "push_failed.json").write_text(
            json.dumps(push_failures, indent=2) + "\n", encoding="utf-8"
        )

    elapsed = int(time.time() - started)
    summary_data = {
        "batch_id": BATCH_ID,
        "target": max_accounts,
        "concurrent": concurrent,
        "success": len(accounts),
        "failed": len(failures),
        "elapsed_s": elapsed,
        "out_dir": str(BATCH_DIR),
        "push_enabled": push_on,
        "push_failures": len(push_failures),
    }
    (BATCH_DIR / "summary.json").write_text(json.dumps(summary_data, indent=2) + "\n", encoding="utf-8")
    meta_path = BATCH_DIR / "batch_meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["finished_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        meta["created"] = len(accounts); meta["failed"] = len(failures); meta["elapsed_s"] = elapsed
        meta["push_enabled"] = push_on; meta["push_failures"] = len(push_failures)
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(
        f"\n OK {len(accounts)}  FAIL {len(failures)}  PUSH_FAIL {len(push_failures)}  "
        f"TOTAL {max_accounts}  OUT {BATCH_DIR}",
        flush=True,
    )

    if max_accounts > 0 and len(accounts) == 0:
        sys.exit(1)
    if push_on and len(accounts) > 0 and len(push_failures) >= len(accounts):
        sys.exit(3)


if __name__ == "__main__":
    asyncio.run(main())
