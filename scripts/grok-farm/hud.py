"""Farm HUD / log emitters for http_farm (dashboard uses GROK_UI=log)."""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

def _env(key: str, default: str = "") -> str:
    import os
    return (os.environ.get(key) or default).strip()

def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")

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

    def _emit_ndjson(self, payload: dict[str, Any]) -> None:
        """Machine-readable event for etteum parser (preferred over regex)."""
        try:
            line = "GROK_EVENT " + json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        except Exception:
            return
        self._write_log_file(line)
        # Always print NDJSON even in HUD mode so supervisors can parse stdout.
        try:
            print(line, flush=True, file=sys.stderr if self.enabled else sys.stdout)
        except Exception:
            pass

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
        # Structured twin of the human line.
        t = {"STEP": "step", "OK": "ok", "FAIL": "fail"}.get(result, "progress")
        payload: dict[str, Any] = {"t": t, "attempt": attempt}
        if em:
            payload["email"] = em
        if det:
            if t == "step":
                payload["step"] = det
            else:
                payload["detail"] = det
        self._emit_ndjson(payload)

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


