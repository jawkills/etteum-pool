"""Signup + reauth attempt flows."""
from __future__ import annotations

import time
from typing import Any, Callable

from captcha import get_clearance, get_turnstile
from farm_env import BASE, GROK_OTP_TIMEOUT, PASSWORD
from hud import emit_progress, vlog
from pb import (
    extract_session_cookie,
    msg_create_session_email_password,
    msg_create_user_and_session,
    pb_str,
)
from tempmail import (
    _tempmail_create_mailbox_sync,
    random_name,
    wait_otp,
)
from xai_http import XAIHttp, obtain_oidc_tokens

# Injected by http_farm after proxy rotator is ready (avoids import cycle).
pick_proxy_sync: Callable[..., str | None] | None = None


def set_proxy_picker(fn: Callable[..., str | None]) -> None:
    global pick_proxy_sync
    pick_proxy_sync = fn


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

