"""Etteum CodeBuddy import client for http_farm."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def push_enabled_from_env(*, no_push_flag: bool = False) -> bool:
    if no_push_flag:
        return False
    raw = (_env("CODEBUDDY_PUSH_ETTEUM", "true") or "true").lower()
    return raw not in ("0", "false", "no", "off")


def parse_push_cli_flags(argv: list[str]) -> tuple[list[str], bool]:
    rest: list[str] = []
    no_push = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-push":
            no_push = True
            i += 1
            continue
        if a == "--push":
            no_push = False
            i += 1
            continue
        rest.append(a)
        i += 1
    return rest, no_push


def result_to_github_item(result: dict[str, Any]) -> dict[str, Any]:
    """Map farm GH create → github inventory import item."""
    gh = result.get("github") if isinstance(result.get("github"), dict) else {}
    email = str(result.get("email") or gh.get("email") or "").strip()
    password = str(result.get("password") or gh.get("password") or "").strip()
    username = str(
        result.get("github_username") or gh.get("username") or result.get("username") or ""
    ).strip()
    if not email or not password:
        raise ValueError("email and password required for github inventory")
    item: dict[str, Any] = {
        "email": email,
        "password": password,
        "username": username or None,
        "proxy_country": result.get("proxy_country") or gh.get("proxy_country"),
        "proxy_sessid": result.get("proxy_sessid") or gh.get("proxy_sessid"),
        "proxy_url": result.get("proxy_url") or gh.get("proxy_url"),
        "proxy_ip": result.get("proxy_ip") or gh.get("proxy_ip"),
        "source": result.get("source") or "codebuddy-farm",
        "batch_id": result.get("batch_id"),
        "status": "active",
    }
    return {k: v for k, v in item.items() if v is not None and v != ""}


def result_to_import_item(result: dict[str, Any]) -> dict[str, Any]:
    """Map farm result → etteum codebuddy import item."""
    api_key = str(result.get("api_key") or "").strip()
    if not api_key.startswith("ck_"):
        raise ValueError("api_key must start with ck_")
    email = str(result.get("email") or "").strip()
    gh = result.get("github") if isinstance(result.get("github"), dict) else {}
    username = str(
        result.get("github_username")
        or gh.get("username")
        or result.get("username")
        or ""
    ).strip()
    if not email:
        email = f"cb-{username or 'account'}@farm.local"
    item: dict[str, Any] = {
        "email": email,
        "api_key": api_key,
        "github_username": username or None,
        "mode": result.get("mode") or "pure_http_sticky",
        "proxy_country": result.get("proxy_country")
        or (gh.get("proxy_country") if gh else None),
    }
    gh_id = result.get("github_account_id")
    if gh_id is not None:
        try:
            item["github_account_id"] = int(gh_id)
        except (TypeError, ValueError):
            pass
    pw = result.get("password") or gh.get("password")
    if pw:
        item["password"] = str(pw)
    return {k: v for k, v in item.items() if v is not None and v != ""}


def preflight_etteum(
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 10.0,
) -> tuple[bool, str]:
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
            if 200 <= code < 300:
                return True, f"ok {code}"
            return False, f"HTTP {code}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)


def _post_json(
    base: str,
    path: str,
    body: dict[str, Any],
    key: str,
    timeout: float,
) -> tuple[int, dict[str, Any] | None, str]:
    url = f"{base}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
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
            code = resp.getcode()
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except Exception:
            payload = {"raw": raw[:300]}
        return code, payload if isinstance(payload, dict) else None, raw
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        try:
            payload = json.loads(err_body) if err_body else None
        except Exception:
            payload = None
        return e.code, payload if isinstance(payload, dict) else None, err_body
    except Exception as e:
        return 0, None, str(e)


def push_github_inventory(
    result: dict[str, Any],
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 30.0,
) -> tuple[bool, str, int | None]:
    """POST /api/accounts/github/import. Returns (ok, message, account_id)."""
    base = (base_url or _env("ETTEUM_URL", "http://127.0.0.1:1930")).rstrip("/")
    key = api_key or _env("ETTEUM_API_KEY") or _env("API_KEY")
    if not key:
        return False, "missing API key", None
    try:
        item = result_to_github_item(result)
    except Exception as e:
        return False, str(e), None
    code, payload, raw = _post_json(
        base, "/api/accounts/github/import", {"accounts": [item]}, key, timeout
    )
    if 200 <= code < 300 and payload:
        results = payload.get("results") or []
        if isinstance(results, list) and results:
            first = results[0] if isinstance(results[0], dict) else {}
            if first.get("success") and first.get("id") is not None:
                try:
                    return True, "github import ok", int(first["id"])
                except (TypeError, ValueError):
                    return True, "github import ok", None
        if int(payload.get("imported") or payload.get("count") or 0) >= 1:
            return True, "github import ok", None
        return False, f"github import empty: {raw[:200]}", None
    return False, f"github import HTTP {code}: {raw[:200]}", None


def push_one_farm_result(
    result: dict[str, Any],
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout: float = 30.0,
) -> tuple[bool, str, dict[str, Any] | None]:
    """POST dedicated import or fall back to bulk apiKeys create.

    Returns (ok, message, response_json).
    """
    base = (base_url or _env("ETTEUM_URL", "http://127.0.0.1:1930")).rstrip("/")
    key = api_key or _env("ETTEUM_API_KEY") or _env("API_KEY")
    if not key:
        return False, "missing API key", None

    try:
        item = result_to_import_item(result)
    except Exception as e:
        return False, str(e), None

    for path, body in (
        ("/api/accounts/codebuddy/import", {"accounts": [item]}),
        (
            "/api/accounts",
            {
                "provider": "codebuddy",
                "apiKeys": item["api_key"],
                "email": item.get("email"),
            },
        ),
    ):
        code, payload, raw = _post_json(base, path, body, key, timeout)
        if code == 404:
            continue
        if 200 <= code < 300 and payload is not None:
            imported = payload.get("imported")
            count = payload.get("count")
            success = payload.get("success")
            if imported is not None and int(imported) < 1:
                continue
            if count is not None and int(count) < 1:
                continue
            if success is False:
                continue
            return True, f"{path} ok", payload
        if code == 0:
            return False, f"{path} error: {raw}", None
        return False, f"{path} HTTP {code}: {raw[:200]}", payload

    return False, "all import paths failed", None
