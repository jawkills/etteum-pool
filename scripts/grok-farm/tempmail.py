"""Tempmail OTP helpers for http_farm."""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import string
import time
from pathlib import Path
from typing import Any

import requests as plain

from farm_env import (
    EMAIL_LOCAL_LEN,
    FIRST_NAMES,
    LAST_NAMES,
    MAIL_API,
    MAIL_KEY,
    RESULTS_ROOT,
    USED_EMAILS_FILE,
)
from hud import vlog

_ALPHANUM = string.ascii_lowercase + string.digits
_used_emails: set[str] = set()
_emails_lock = asyncio.Lock()
_tempmail_seen_ids: set[str] = set()


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
