"""Pure-HTTP CodeBuddy OAuth + region/trial + free key mint."""
from __future__ import annotations

import re
import time
from typing import Any

from farm_env import CODEBUDDY_BASE
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


def hidden_fields(html: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for hm in re.finditer(r"<input[^>]*>", html, re.I):
        tag = hm.group(0)
        nm = re.search(r'name=["\']([^"\']+)["\']', tag, re.I)
        if not nm:
            continue
        vm = re.search(r'value=["\']([^"\']*)["\']', tag, re.I)
        fields[nm.group(1)] = vm.group(1) if vm else ""
    return fields


def codebuddy_oauth_http(session) -> dict[str, Any]:
    """Pure-HTTP OAuth. Returns ok + final_url + mode notes."""
    out: dict[str, Any] = {"ok": False, "mode": "http"}
    try:
        session.get(f"{CODEBUDDY_BASE}/", timeout=40, allow_redirects=True)
    except Exception:
        pass

    auth_url = (
        f"{CODEBUDDY_BASE}/auth/realms/copilot/protocol/openid-connect/auth"
        "?client_id=console&response_type=code"
        "&redirect_uri=https%3A%2F%2Fwww.codebuddy.ai%2Flogin%2Fselect%3Fredirect_uri%3D"
        "https%253A%252F%252Fwww.codebuddy.ai%252Fprofile%252Fkeys"
        "&v=2210&product=codebuddy"
    )
    r1 = session.get(auth_url, timeout=40, allow_redirects=True)
    m = re.search(
        r'(/auth/realms/copilot/broker/github/login[^"\']+)', r1.text or ""
    )
    if not m:
        out["error"] = "no broker link"
        return out
    broker = CODEBUDDY_BASE + m.group(1).replace("&amp;", "&")
    br = session.get(broker, timeout=40, allow_redirects=False)
    authz = br.headers.get("Location")
    out["broker_status"] = br.status_code
    out["authorize_url"] = authz
    if not authz:
        out["error"] = "broker no Location"
        return out
    if authz.startswith("/"):
        authz = "https://github.com" + authz

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": f"{CODEBUDDY_BASE}/",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-User": "?1",
    }
    ar = session.get(authz, timeout=40, allow_redirects=False, headers=headers)
    loc = ar.headers.get("Location") or ""
    out["authorize_status"] = ar.status_code
    out["authorize_loc"] = loc
    vlog(
        f"[oauth-http] authorize {ar.status_code} loc={loc[:120] if loc else None}"
    )

    if "dashboard" in loc:
        out["error"] = "authorize_to_dashboard"
        return out

    if ar.status_code in (301, 302, 303, 307, 308) and "code=" in loc:
        if loc.startswith("/"):
            loc = (
                "https://github.com" + loc
                if "codebuddy" not in loc
                else CODEBUDDY_BASE + loc
            )
        fin = session.get(
            loc,
            timeout=40,
            allow_redirects=True,
            headers={"Referer": "https://github.com/"},
        )
        out["final_url"] = str(fin.url)
        if "codebuddy.ai" in str(fin.url):
            out["ok"] = True
        return out

    if ar.status_code == 200 and (
        "Authorize" in (ar.text or "") or "wants access" in (ar.text or "")
    ):
        fields = hidden_fields(ar.text)
        post = {}
        for k, v in fields.items():
            if k in (
                "authenticity_token",
                "client_id",
                "redirect_uri",
                "state",
                "scope",
                "response_type",
                "authorize",
            ) or k.startswith("oauth"):
                post[k] = v
        if "authenticity_token" not in post:
            post["authenticity_token"] = form_val("authenticity_token", ar.text)
        post["authorize"] = "1"
        am = re.search(r'<form[^>]+action=["\']([^"\']+)["\']', ar.text, re.I)
        action = am.group(1) if am else "/login/oauth/authorize"
        if action.startswith("/"):
            action = "https://github.com" + action
        pr = session.post(
            action,
            data=post,
            timeout=40,
            allow_redirects=False,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://github.com",
                "Referer": authz,
            },
        )
        loc2 = pr.headers.get("Location") or ""
        out["post_status"] = pr.status_code
        out["post_loc"] = loc2
        vlog(
            f"[oauth-http] post authorize {pr.status_code} {loc2[:120] if loc2 else ''}"
        )

        def _finish(url: str) -> dict[str, Any]:
            if url.startswith("/"):
                url = (
                    "https://github.com" + url
                    if "codebuddy" not in url
                    else CODEBUDDY_BASE + url
                )
            fin = session.get(
                url,
                timeout=40,
                allow_redirects=True,
                headers={"Referer": "https://github.com/"},
            )
            out["final_url"] = str(fin.url)
            out["ok"] = "codebuddy.ai" in str(fin.url)
            return out

        if loc2:
            if "dashboard" in loc2:
                out["error"] = "authorize_to_dashboard"
                return out
            return _finish(loc2)

        pr2 = session.post(
            action,
            data=post,
            timeout=40,
            allow_redirects=True,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://github.com",
                "Referer": authz,
            },
        )
        out["post_follow_url"] = str(pr2.url)
        if "codebuddy.ai" in str(pr2.url):
            out["final_url"] = str(pr2.url)
            out["ok"] = True
            return out
        fin = session.get(authz, timeout=40, allow_redirects=True, headers=headers)
        out["final_url"] = str(fin.url)
        if "codebuddy.ai" in str(fin.url):
            out["ok"] = True
            return out
        out["error"] = "authorize post no code"
        return out

    if "login" in loc and "oauth" not in loc:
        out["error"] = "authorize_to_login"
        return out

    fin = session.get(authz, timeout=40, allow_redirects=True, headers=headers)
    out["final_url"] = str(fin.url)
    if "codebuddy.ai" in str(fin.url) and "dashboard" not in str(fin.url):
        out["ok"] = True
    else:
        out["error"] = out.get("error") or f"unexpected final {fin.url}"
    return out


def codebuddy_mint_http(session) -> dict[str, Any]:
    """Region SG + overseas register + trial + mint free ck_ key."""
    out: dict[str, Any] = {"ok": False}
    api = {
        "Accept": "application/json",
        "Referer": f"{CODEBUDDY_BASE}/profile/keys",
        "Origin": CODEBUDDY_BASE,
    }
    acc = session.get(
        f"{CODEBUDDY_BASE}/console/accounts",
        headers=api,
        timeout=40,
    )
    out["accounts_status"] = acc.status_code
    if acc.status_code != 200:
        out["error"] = f"accounts HTTP {acc.status_code}"
        out["accounts_head"] = (acc.text or "")[:200]
        return out
    try:
        j = acc.json()
        uid = j["data"]["accounts"][0]["uid"]
        out["areaInfoComplete"] = j["data"]["accounts"][0].get("areaInfoComplete")
    except Exception as e:
        out["error"] = f"accounts parse: {e}"
        return out
    out["uid"] = uid

    session.post(
        f"{CODEBUDDY_BASE}/console/login/account",
        headers={**api, "Content-Type": "application/json"},
        json={
            "attributes": {
                "countryCode": ["65"],
                "countryFullName": ["Singapore"],
                "countryName": ["SG"],
            }
        },
        timeout=40,
    )
    session.get(
        f"{CODEBUDDY_BASE}/auth/realms/copilot/overseas/user/register?userId={uid}",
        headers=api,
        timeout=40,
    )
    session.post(
        f"{CODEBUDDY_BASE}/billing/ide/trial",
        headers={**api, "Content-Type": "application/json"},
        data="{}",
        timeout=40,
    )
    body = {
        "name": f"key-{int(time.time())}",
        "expire_in_days": -1,
        "user_enterprise_id": "personal-edition-user-id",
    }
    ckey = session.post(
        f"{CODEBUDDY_BASE}/console/api/client/v1/api-keys",
        headers={**api, "Content-Type": "application/json"},
        json=body,
        timeout=40,
    )
    out["create_status"] = ckey.status_code
    try:
        payload = ckey.json()
        out["create"] = payload
        key = ((payload.get("data") or {}).get("key")) or ""
        out["api_key"] = key or None
        out["ok"] = bool(key)
        if not key:
            out["error"] = f"mint no key: {payload}"
    except Exception as e:
        out["error"] = f"mint parse: {e} body={(ckey.text or '')[:200]}"
    return out
