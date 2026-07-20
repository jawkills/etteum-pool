"""GitHub login helpers (sticky session + verified-device via HME)."""
from __future__ import annotations

import re
from typing import Any

from farm_env import IMPERSONATE, UA
from hme import wait_device_otp
from hud import vlog


def form_val(name: str, html: str) -> str:
    m = re.search(
        rf'name=["\']{re.escape(name)}["\'][^>]*value=["\']([^"\']*)["\']',
        html,
        re.I,
    )
    if m:
        return m.group(1)
    m = re.search(
        rf'value=["\']([^"\']*)["\'][^>]*name=["\']{re.escape(name)}["\']',
        html,
        re.I,
    )
    return m.group(1) if m else ""


def make_session(proxy_url: str | None = None):
    from curl_cffi import requests as creq

    s = creq.Session(impersonate=IMPERSONATE)
    s.headers.update(
        {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )
    if proxy_url:
        s.proxies = {"http": proxy_url, "https": proxy_url}
    return s


def gh_login(
    session,
    username: str,
    password: str,
    email: str | None = None,
) -> dict[str, Any]:
    """Login GH; solve verified-device via HME when needed."""
    info: dict[str, Any] = {"ok": False}
    html = session.get("https://github.com/login", timeout=40).text
    auth = form_val("authenticity_token", html)
    lr = session.post(
        "https://github.com/session",
        data={
            "authenticity_token": auth,
            "login": username,
            "password": password,
            "commit": "Sign in",
        },
        timeout=40,
        allow_redirects=True,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://github.com",
            "Referer": "https://github.com/login",
        },
    )
    info["login_url"] = str(lr.url)
    vlog(f"[gh-login] {lr.status_code} {lr.url}")

    if "suspended" in str(lr.url).lower():
        info["error"] = "suspended"
        return info

    if "verified-device" in str(lr.url):
        vlog("[gh-login] verified-device — HME OTP")
        tok = form_val("authenticity_token", lr.text)
        try:
            session.post(
                "https://github.com/sessions/verified-device/resend",
                data={"authenticity_token": tok},
                timeout=40,
                allow_redirects=True,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://github.com",
                    "Referer": str(lr.url),
                },
            )
        except Exception as e:
            vlog(f"[gh-login] resend err {e}")
        code = wait_device_otp(email or "", timeout=100) if email else None
        info["vd_otp"] = code
        vlog(f"[gh-login] vd_otp={code}")
        if not code:
            info["error"] = "verified-device no otp"
            return info
        html = session.get(
            "https://github.com/sessions/verified-device", timeout=40
        ).text
        if 'name="otp"' not in html:
            html = lr.text
        fields = {
            "authenticity_token": form_val("authenticity_token", html),
            "otp": code,
        }
        vd = session.post(
            "https://github.com/sessions/verified-device",
            data=fields,
            timeout=40,
            allow_redirects=True,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://github.com",
                "Referer": "https://github.com/sessions/verified-device",
            },
        )
        info["vd_url"] = str(vd.url)
        vlog(f"[gh-login] after vd {vd.url}")
        if "verified-device" in str(vd.url):
            info["error"] = "verified-device still blocked"
            return info
        if "suspended" in str(vd.url).lower():
            info["error"] = "suspended after vd"
            return info

    session.get("https://github.com/", timeout=40, allow_redirects=True)
    ck = (
        session.cookies.get_dict()
        if hasattr(session.cookies, "get_dict")
        else {}
    )
    info["user_session"] = bool(ck.get("user_session"))
    info["logged_in"] = ck.get("logged_in")
    sp = session.get(
        "https://github.com/_side-panels/user.json",
        timeout=20,
        headers={"Accept": "application/json"},
    )
    info["side_status"] = sp.status_code
    info["ok"] = bool(ck.get("user_session")) or ck.get("logged_in") == "yes"
    if not info["ok"]:
        info["error"] = info.get("error") or "no user_session"
    return info
