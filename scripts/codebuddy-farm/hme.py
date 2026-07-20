"""iCloud Hide My Email client (xiaozhou26-style HME service)."""
from __future__ import annotations

import re
import time
from typing import Any

from farm_env import (
    HME_ACCOUNT,
    HME_GENERATE_PATH,
    HME_HEALTH_PATH,
    HME_INBOX_PATH,
    HME_URL,
    IMPERSONATE,
)


def _session():
    from curl_cffi import requests as creq

    return creq.Session(impersonate=IMPERSONATE)


def preflight_hme(timeout: float = 8.0) -> tuple[bool, str]:
    """Return (ok, message). Prefer /health; fall back to inbox probe."""
    s = _session()
    health = f"{HME_URL}{HME_HEALTH_PATH}"
    try:
        r = s.get(health, timeout=timeout)
        if r.status_code < 500:
            return True, f"health {r.status_code}"
    except Exception:
        pass
    try:
        r = s.get(
            f"{HME_URL}{HME_INBOX_PATH}",
            params={"account_id": HME_ACCOUNT, "limit": 1, "days": 1},
            timeout=timeout,
        )
        if r.status_code < 500:
            return True, f"inbox probe {r.status_code}"
        return False, f"inbox HTTP {r.status_code}"
    except Exception as e:
        return False, f"hme unreachable: {e}"


def generate_alias(label: str = "codebuddy-farm", timeout: float = 30.0) -> str:
    """Create a new HME alias. Returns email address.

    Endpoint shape is configurable via ICLOUD_HME_GENERATE_PATH.
    Accepts several common response envelopes.
    """
    s = _session()
    url = f"{HME_URL}{HME_GENERATE_PATH}"
    bodies = (
        {"account_id": HME_ACCOUNT, "label": label},
        {"accountId": HME_ACCOUNT, "label": label},
        {"account_id": HME_ACCOUNT, "note": label},
    )
    last_err = "no attempt"
    for body in bodies:
        try:
            r = s.post(url, json=body, timeout=timeout)
            data = r.json() if r.content else {}
        except Exception as e:
            last_err = str(e)
            continue
        email = _extract_email(data)
        if email:
            return email.lower().strip()
        last_err = f"HTTP {r.status_code}: {str(data)[:200]}"
        # 404 on path → stop trying same path with alt bodies only once more
        if r.status_code == 404:
            break
    # Alternate common paths if configured default fails
    for alt in ("/api/generate", "/api/aliases", "/api/hme/create", "/generate"):
        if alt == HME_GENERATE_PATH:
            continue
        try:
            r = s.post(
                f"{HME_URL}{alt}",
                json={"account_id": HME_ACCOUNT, "label": label},
                timeout=timeout,
            )
            data = r.json() if r.content else {}
            email = _extract_email(data)
            if email:
                return email.lower().strip()
            last_err = f"{alt} HTTP {r.status_code}: {str(data)[:160]}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"HME generate alias failed: {last_err}")


def _extract_email(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    for key in ("email", "alias", "hme", "address"):
        v = data.get(key)
        if isinstance(v, str) and "@" in v:
            return v
    for nest in ("data", "result", "hme"):
        inner = data.get(nest)
        if isinstance(inner, dict):
            e = _extract_email(inner)
            if e:
                return e
        if isinstance(inner, str) and "@" in inner:
            return inner
    return ""


def _inbox_messages(alias: str = "", limit: int = 20, days: int = 2) -> list[dict]:
    s = _session()
    params_list = []
    if alias:
        params_list.append(
            {"account_id": HME_ACCOUNT, "alias": alias, "limit": limit, "days": days}
        )
    params_list.append({"account_id": HME_ACCOUNT, "limit": limit, "days": days})
    for params in params_list:
        try:
            r = s.get(f"{HME_URL}{HME_INBOX_PATH}", params=params, timeout=30)
            data = r.json() if r.content else {}
        except Exception:
            continue
        msgs = (
            (data.get("data") or {}).get("messages")
            if isinstance(data.get("data"), dict)
            else None
        )
        if msgs is None:
            msgs = data.get("messages") or data.get("result") or []
        if isinstance(msgs, list) and msgs:
            return [m for m in msgs if isinstance(m, dict)]
    return []


def _codes_from_message(msg: dict) -> list[str]:
    parts = [
        str(msg.get("subject") or ""),
        str(msg.get("preview") or ""),
        str(msg.get("body") or ""),
        str(msg.get("text") or ""),
        str(msg.get("text_body") or ""),
        str(msg.get("html_body") or ""),
    ]
    blob = " ".join(parts)
    blob = blob.replace("=\r\n", "").replace("=\n", "")
    preferred = re.findall(
        r"(?:Verification code|launch code|code is)[:\s]*([0-9]{6,8})",
        blob,
        re.I,
    )
    if preferred:
        return preferred
    return re.findall(r"\b([0-9]{6,8})\b", blob)


def wait_otp(
    alias: str,
    *,
    kind: str = "signup",
    timeout: int = 180,
    poll: float = 3.0,
) -> str:
    """Poll HME inbox for a GitHub OTP.

    kind:
      - signup: launch/verification code (not device)
      - device: subject contains verify your device
    """
    alias = (alias or "").lower().strip()
    end = time.time() + timeout
    while time.time() < end:
        msgs = _inbox_messages(alias=alias)
        cands: list[tuple[str, str]] = []
        for m in msgs:
            subj = (m.get("subject") or "").lower()
            to = (m.get("to") or m.get("recipient") or "").lower()
            if alias and to and alias not in to:
                # still allow if API already filtered by alias
                pass
            is_device = "verify your device" in subj or "device verification" in subj
            if kind == "device" and not is_device:
                continue
            if kind == "signup" and is_device:
                continue
            # GitHub signup subjects often mention launch code / verify email
            if kind == "signup":
                if not any(
                    x in subj
                    for x in (
                        "github",
                        "launch",
                        "verify",
                        "confirmation",
                        "code",
                        "",
                    )
                ):
                    # keep — empty subject still scanned
                    pass
            codes = _codes_from_message(m)
            if codes:
                cands.append((str(m.get("date") or m.get("received_at") or ""), codes[0]))
        if cands:
            cands.sort(key=lambda x: x[0], reverse=True)
            return cands[0][1]
        time.sleep(poll)
    raise TimeoutError(f"HME OTP timeout kind={kind} alias={alias}")


def wait_signup_otp(alias: str, timeout: int = 180) -> str:
    return wait_otp(alias, kind="signup", timeout=timeout)


def wait_device_otp(alias: str, timeout: int = 100) -> str | None:
    try:
        return wait_otp(alias, kind="device", timeout=timeout)
    except TimeoutError:
        return None
