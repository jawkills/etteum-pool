"""Etteum Grok-CLI import client for http_farm (internal automation)."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def push_enabled_from_env(env: dict[str, str] | None = None, *, no_push_flag: bool = False) -> bool:
    if no_push_flag:
        return False
    e = env if env is not None else os.environ
    raw = (e.get("GROK_PUSH_ETTEUM") or "true").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return True


def parse_push_cli_flags(argv: list[str]) -> tuple[list[str], bool]:
    """Strip --no-push / --push from argv; return (remaining, no_push)."""
    rest: list[str] = []
    no_push = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--no-push",):
            no_push = True
            i += 1
            continue
        if a in ("--push",):
            no_push = False
            i += 1
            continue
        rest.append(a)
        i += 1
    return rest, no_push


def account_to_import_item(result: dict[str, Any]) -> dict[str, Any]:
    """Map http_farm save_result-shaped dict to etteum import item.

    Includes password when present so the pool can reauth later without re-farm.
    """
    email = str(result.get("email") or "").strip()
    if not email:
        raise ValueError("email required")
    password = result.get("password") or result.get("xai_password")
    tokens = result.get("tokens")
    if isinstance(tokens, dict) and (tokens.get("access_token") or tokens.get("accessToken")):
        item: dict[str, Any] = {"email": email, "tokens": dict(tokens)}
        if password:
            item["password"] = str(password)
        return item
    access = result.get("access_token") or result.get("accessToken")
    refresh = result.get("refresh_token") or result.get("refreshToken")
    if not access or not refresh:
        raise ValueError("access_token and refresh_token required")
    item = {
        "email": email,
        "access_token": access,
        "refresh_token": refresh,
    }
    for k in ("id_token", "expires_at", "client_id", "team_id", "sub"):
        if result.get(k):
            item[k] = result[k]
    if password:
        item["password"] = str(password)
    return item


def build_import_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"accounts": items}


def preflight_etteum(
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 10.0,
) -> tuple[bool, str]:
    """GET /v1/models with bearer. Returns (ok, message)."""
    base = (base_url or _env("ETTEUM_URL", "http://127.0.0.1:1930")).rstrip("/")
    key = api_key or _env("ETTEUM_API_KEY") or _env("API_KEY")
    if not key:
        return False, "ETTEUM_API_KEY (or API_KEY) not set"
    url = f"{base}/v1/models"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            if code == 200:
                return True, f"etteum ok {base}"
            return False, f"etteum HTTP {code}"
    except Exception as e:
        return False, f"etteum unreachable: {e}"


def push_accounts_to_etteum(
    items: list[dict[str, Any]],
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 60.0,
    retries: int = 3,
) -> dict[str, Any]:
    """POST /api/accounts/grok-cli/import. Returns parsed JSON or raises."""
    if not items:
        return {"imported": 0, "failed": 0, "results": []}
    base = (base_url or _env("ETTEUM_URL", "http://127.0.0.1:1930")).rstrip("/")
    key = api_key or _env("ETTEUM_API_KEY") or _env("API_KEY")
    if not key:
        raise RuntimeError("ETTEUM_API_KEY not set")
    url = f"{base}/api/accounts/grok-cli/import"
    body = json.dumps(build_import_payload(items)).encode("utf-8")
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                data = json.loads(raw) if raw else {}
                return data
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace") if e.fp else ""
            last_err = RuntimeError(f"HTTP {e.code}: {err_body[:300]}")
            if e.code in (400, 401, 403, 404):
                raise last_err
        except Exception as e:
            last_err = e
        time.sleep(min(2.0 * attempt, 6.0))
    raise RuntimeError(f"push failed after {retries}: {last_err}")


def push_one_farm_result(result: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    item = account_to_import_item(result)
    return push_accounts_to_etteum([item], **kwargs)
