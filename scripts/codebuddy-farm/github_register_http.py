"""GitHub pure-HTTP register with iCloud HME + sticky DataImpulse + DataDome solver."""
from __future__ import annotations

import json
import os
import random
import re
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from farm_env import (
    CAPTCHA_SOLVER_URL,
    GH_CLIENT_VERSION,
    GH_COUNTRY_CODE,
    GH_OCTOCAPTCHA_URL,
    GH_OTP_TIMEOUT,
    GH_PASSWORD,
    GH_REFERER,
    GH_WARM_STARS,
    GH_WARMUP,
    IMPERSONATE,
    MAIL_BACKEND,
    RESULTS_ROOT,
    UA,
)
from hme import generate_alias, wait_signup_otp
from hud import vlog
from proxy_di import build_sticky_proxy, probe_proxy_ip

RESULTS = RESULTS_ROOT
RESULTS.mkdir(parents=True, exist_ok=True)


def log(m: str) -> None:
    vlog(m) if m.startswith("[") else vlog(f"[gh] {m}")


def rand_user() -> str:
    # GH login: 1-39, alphanumeric/hyphen, no consecutive hyphens start/end
    base = random.choice(
        ["alex", "jordan", "taylor", "morgan", "casey", "riley", "quinn", "avery"]
    )
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{base}-{suffix}"[:39]


def rand_pass(n: int = 16) -> str:
    if GH_PASSWORD:
        return GH_PASSWORD
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    # ensure mix
    chars = [
        random.choice(string.ascii_uppercase),
        random.choice(string.ascii_lowercase),
        random.choice(string.digits),
        random.choice("!@#$%^&*"),
    ]
    chars += [random.choice(alphabet) for _ in range(max(0, n - 4))]
    random.shuffle(chars)
    return "".join(chars)


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


def cookie_dict(session) -> dict:
    if hasattr(session.cookies, "get_dict"):
        return session.cookies.get_dict()
    try:
        return dict(session.cookies)
    except Exception:
        return {}


def mail_create() -> tuple[str, str]:
    if MAIL_BACKEND not in ("icloud_hme", "hme", "icloud"):
        raise RuntimeError(
            f"MAIL_BACKEND={MAIL_BACKEND!r} not supported; use icloud_hme"
        )
    email = generate_alias(label="codebuddy-farm")
    log(f"[mail] hme {email}")
    # inbox token not used for HME; return email as token placeholder
    return email, email


def mail_otp(alias: str, timeout: int | None = None) -> str:
    return wait_signup_otp(alias, timeout=timeout or GH_OTP_TIMEOUT)


def waguri_datadome(proxy: str | None = None) -> dict:
    from curl_cffi import requests as creq

    body: dict[str, Any] = {
        "type": "datadome",
        "url": GH_OCTOCAPTCHA_URL,
        "referer": GH_REFERER,
    }
    if proxy:
        body["proxy"] = proxy
    r = creq.post(
        f"{CAPTCHA_SOLVER_URL}/solve",
        json=body,
        timeout=90,
        impersonate=IMPERSONATE,
    )
    data = r.json()
    log(
        f"[waguri] solved={data.get('solved')} cookie_len={len(data.get('datadome_cookie') or '')} "
        f"elapsed={data.get('elapsed')} err={data.get('error')}"
    )
    return data


def _warm_stars(session, n: int = 1) -> None:
    if n <= 0:
        return
    # lightweight: open explore; actual star is best-effort
    try:
        session.get("https://github.com/explore", timeout=30, allow_redirects=True)
        # star a popular public repo (best effort)
        targets = [
            "https://github.com/torvalds/linux",
            "https://github.com/microsoft/vscode",
        ]
        for url in targets[:n]:
            html = session.get(url, timeout=30).text
            tok = form_val("authenticity_token", html)
            # find star button action if present
            m = re.search(
                r'action="(/[^"]+/star)"[^>]*>',
                html,
            ) or re.search(r'data-hydro-click[^>]+star', html)
            if tok and m and isinstance(m.group(1) if m.lastindex else "", str):
                action = m.group(1)
                if action.startswith("/"):
                    action = "https://github.com" + action
                session.post(
                    action,
                    data={"authenticity_token": tok},
                    timeout=20,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Origin": "https://github.com",
                        "Referer": url,
                    },
                )
                log(f"[warm] star try {url}")
                break
    except Exception as e:
        log(f"[warm] skip {e}")


def register_http(
    email: str | None = None,
    inbox: str | None = None,
    password: str | None = None,
    username: str | None = None,
    proxy: str | dict | None = None,
) -> dict:
    from curl_cffi import requests as creq

    t0 = time.time()
    out: dict[str, Any] = {
        "ok": False,
        "mode": "http_pure_hme",
        "started": datetime.now(timezone.utc).isoformat(),
    }

    if not email or not inbox:
        try:
            email, inbox = mail_create()
        except Exception as e:
            out["error"] = f"mail_create: {e}"
            return out
    password = password or rand_pass()
    username = username or rand_user()
    out.update(email=email, password=password, username=username, inbox_token=inbox)

    # --- Proxy ---
    proxy_info: dict[str, Any] | None = None
    if isinstance(proxy, dict):
        proxy_info = proxy
        proxy_url = proxy_info.get("url") or ""
    else:
        proxy_url = proxy or ""
        if proxy_url or DI_LOGIN_present():
            proxy_info = build_sticky_proxy(base=proxy_url or None)
            proxy_url = proxy_info.get("url") or proxy_url
    if proxy_info:
        out["proxy_country"] = proxy_info.get("country")
        out["proxy_sessid"] = proxy_info.get("sessid")
        out["proxy_sticky"] = proxy_info.get("sticky")
    out["proxy_url"] = proxy_url
    if proxy_url:
        ip = probe_proxy_ip(proxy_url)
        out["proxy_ip"] = ip
        log(f"[proxy] ip={ip} cc={out.get('proxy_country')} sess={out.get('proxy_sessid')}")

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

    # --- DataDome ---
    dd = waguri_datadome(proxy_url or None)
    cookie = (dd.get("datadome_cookie") or "").strip()
    if not cookie or not dd.get("solved"):
        out["error"] = f"datadome fail: {dd.get('error') or dd}"
        out["elapsed_s"] = round(time.time() - t0, 1)
        return out
    try:
        s.cookies.set("datadome", cookie, domain=".github.com")
    except Exception:
        s.cookies.set("datadome", cookie)

    # --- GET signup ---
    auth = ""
    ts = ""
    tss = ""
    hp = None
    for attempt in range(1, 4):
        r1 = s.get(
            "https://github.com/signup",
            timeout=40,
            allow_redirects=True,
            headers={"Referer": "https://github.com/"},
        )
        html = r1.text or ""
        auth = form_val("authenticity_token", html)
        ts_m = re.search(r'name=["\']timestamp["\'][^>]*value=["\']([^"\']*)', html)
        tss_m = re.search(
            r'name=["\']timestamp_secret["\'][^>]*value=["\']([^"\']*)', html
        )
        ts = ts_m.group(1) if ts_m else str(int(time.time() * 1000))
        tss = tss_m.group(1) if tss_m else ""
        hp = re.search(r'name=["\'](required_field_[^"\']+)["\']', html)
        if auth:
            break
        # re-harvest DD
        dd = waguri_datadome(proxy_url or None)
        cookie = (dd.get("datadome_cookie") or "").strip()
        if cookie:
            try:
                s.cookies.set("datadome", cookie, domain=".github.com")
            except Exception:
                s.cookies.set("datadome", cookie)
        time.sleep(1.5)
    if not auth:
        out["error"] = "no authenticity_token on /signup (datadome interstitial?)"
        out["elapsed_s"] = round(time.time() - t0, 1)
        return out

    payload: list[tuple[str, str]] = [
        ("authenticity_token", auth),
        ("return_to", ""),
        ("invitation_token", ""),
        ("repo_invitation_token", ""),
        ("user[email]", email),
        ("user[password]", password),
        ("user[login]", username),
        ("user_signup[country]", GH_COUNTRY_CODE),
        ("filter", ""),
        ("user_signup[copilot_opt_in]", "0"),
        ("user_signup[copilot_opt_in]", "1"),
        ("user_signup[marketing_consent]", "0"),
        ("octocaptcha-token", cookie),
        ("timestamp", ts),
        ("timestamp_secret", tss),
    ]
    if hp:
        payload.append((hp.group(1), ""))

    r2 = s.post(
        "https://github.com/signup?social=false",
        data=payload,
        timeout=45,
        allow_redirects=True,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://github.com",
            "Referer": "https://github.com/signup",
        },
    )
    out["signup_status"] = r2.status_code
    out["signup_url"] = str(r2.url)
    log(f"[signup] {r2.status_code} {r2.url}")

    if "account_verifications" not in str(r2.url) and "Confirm your email" not in (
        r2.text or ""
    ):
        out["error"] = f"create did not reach verify: {r2.url}"
        return out
    out["stage"] = "email_verify"

    try:
        otp = mail_otp(email, timeout=GH_OTP_TIMEOUT)
    except Exception as e:
        out["error"] = f"otp wait: {e}"
        return out
    out["otp"] = otp

    r3 = s.get(
        "https://github.com/account_verifications",
        timeout=30,
        headers={"Referer": "https://github.com/signup"},
    )
    vhtml = r3.text
    nonce_m = re.search(
        r'name=["\']fetch-nonce["\']\s+content=["\']([^"\']+)', vhtml
    ) or re.search(r'content=["\']([^"\']+)["\']\s+name=["\']fetch-nonce["\']', vhtml)
    nonce = nonce_m.group(1) if nonce_m else ""
    client_ver = GH_CLIENT_VERSION
    cv2 = re.search(
        r'x-github-client-version["\']?\s*[:=]\s*["\']([a-f0-9]{40})', vhtml, re.I
    )
    if cv2:
        client_ver = cv2.group(1)
    out["fetch_nonce"] = nonce
    out["client_ver"] = client_ver

    pairs: list[tuple[str, str]] = [
        ("return_to", ""),
        ("invitation_token", ""),
        ("repo_invitation_token", ""),
        ("plan", ""),
        ("verification", ""),
        ("setup_organization", ""),
        ("trial_acquisition_channel", ""),
    ]
    for ch in re.sub(r"\D", "", otp):
        pairs.append(("launch_code[]", ch))

    headers_otp = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://github.com",
        "Referer": "https://github.com/account_verifications",
        "Accept": "text/html, application/xhtml+xml",
        "X-Requested-With": "XMLHttpRequest",
        "github-verified-fetch": "true",
        "x-github-client-version": client_ver,
    }
    if nonce:
        headers_otp["x-fetch-nonce"] = nonce

    r4 = s.post(
        "https://github.com/account_verifications",
        data=pairs,
        timeout=30,
        allow_redirects=False,
        headers=headers_otp,
    )
    loc = r4.headers.get("location") or ""
    out["otp_status"] = r4.status_code
    out["otp_location"] = loc
    log(f"[otp] POST {r4.status_code} loc={loc}")

    created = r4.status_code in (301, 302, 303, 307, 308) and (
        "dashboard" in loc or "login" in loc or "github.com" in loc
    )
    if created or "created successfully" in (r4.text or "").lower():
        out["stage"] = "created"
        if loc:
            s.get(
                loc if loc.startswith("http") else f"https://github.com{loc}",
                timeout=30,
                allow_redirects=True,
                headers={"Referer": "https://github.com/account_verifications"},
            )
    else:
        out["error"] = (
            f"otp HTTP {r4.status_code} body={(r4.text or '')[:180]!r} "
            f"(need fetch-nonce? {bool(nonce)})"
        )
        out["elapsed_s"] = round(time.time() - t0, 1)
        return out

    ck = cookie_dict(s)
    if ck.get("logged_in") != "yes" and "user_session" not in ck:
        login_html = s.get("https://github.com/login", timeout=30).text
        la = form_val("authenticity_token", login_html)
        lr = s.post(
            "https://github.com/session",
            data={
                "authenticity_token": la,
                "login": email,
                "password": password,
                "commit": "Sign in",
            },
            timeout=30,
            allow_redirects=True,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://github.com",
                "Referer": "https://github.com/login",
            },
        )
        out["login_status"] = lr.status_code
        out["login_url"] = str(lr.url)
        log(f"[login] {lr.status_code} {lr.url}")
        ck = cookie_dict(s)

    if GH_WARMUP and (ck.get("logged_in") == "yes" or "user_session" in ck):
        _warm_stars(s, GH_WARM_STARS)

    out["cookies"] = {
        k: (v[:16] + "…" if len(v) > 16 else v)
        for k, v in ck.items()
        if k
        in (
            "logged_in",
            "user_session",
            "dotcom_user",
            "_gh_sess",
            "datadome",
        )
    }
    out["ok"] = ck.get("logged_in") == "yes" or "user_session" in ck
    out["status"] = "registered" if out["ok"] else "created_need_login"
    out["elapsed_s"] = round(time.time() - t0, 1)
    out["finished"] = datetime.now(timezone.utc).isoformat()

    path = RESULTS / f"http_reg_{int(time.time())}_{username}.json"
    # strip long cookies from disk dump noise
    dump = {k: v for k, v in out.items() if k != "cookies"}
    path.write_text(json.dumps(dump, indent=2, default=str), encoding="utf-8")
    log(f"[save] {path}")
    return out


def DI_LOGIN_present() -> bool:
    from farm_env import DI_LOGIN, DI_PASSWORD

    return bool(DI_LOGIN and DI_PASSWORD)
