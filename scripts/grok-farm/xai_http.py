"""xAI HTTP session + OAuth token obtain."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import requests as plain
from curl_cffi import requests as creq

from farm_env import (
    AUTH,
    BASE,
    IMPERSONATE,
    SERVER_ACTION_ID,
    XAI_AUTHORIZE,
    XAI_CLIENT_ID,
    XAI_REDIRECT,
    XAI_SCOPE,
    XAI_TOKEN_URL,
)
from hud import vlog
from pb import extract_session_cookie, grpc_web_frame, parse_grpc_web


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
