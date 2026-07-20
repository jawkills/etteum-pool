#!/usr/bin/env python3
"""
HTTP-only CodeBuddy free-key farm (iCloud HME → GitHub → ck_).

Entry point for dashboard spawn (scripts/codebuddy-farm/http_farm.py).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from farm_env import (
    CAPTCHA_SOLVER_URL,
    CONCURRENT,
    DI_LOGIN,
    DI_PASSWORD,
    ETTEUM_API_KEY,
    ETTEUM_URL,
    HME_URL,
    MAIL_BACKEND,
    MAX_ACCOUNTS,
    PUSH_MODE,
    RESULTS_ROOT,
    ROOT,
    SPAWN_DELAY,
)
from github_register_http import register_http
from github_session import gh_login, make_session
from codebuddy_oauth import codebuddy_mint_http, codebuddy_oauth_http
from hme import preflight_hme
from hud import emit_failed, emit_progress, emit_success, open_log, vlog
from etteum_push import (
    parse_push_cli_flags,
    preflight_etteum,
    push_enabled_from_env,
    push_github_inventory,
    push_one_farm_result,
)
from proxy_di import build_sticky_proxy

_batch_io_lock = threading.Lock()
BATCH_ID = ""
BATCH_DIR: Path = RESULTS_ROOT
RESULTS_JSON: Path = RESULTS_ROOT / "accounts.json"
FAILED_JSON: Path = RESULTS_ROOT / "failed.json"
KEYS_TXT: Path = RESULTS_ROOT / "keys.txt"


def init_batch(max_accounts: int, concurrent: int) -> str:
    global BATCH_ID, BATCH_DIR, RESULTS_JSON, FAILED_JSON, KEYS_TXT
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    short = secrets.token_hex(3)
    BATCH_ID = f"{stamp}_{short}"
    BATCH_DIR = RESULTS_ROOT / f"batch_{BATCH_ID}"
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_JSON = BATCH_DIR / "accounts.json"
    FAILED_JSON = BATCH_DIR / "failed.json"
    KEYS_TXT = BATCH_DIR / "keys.txt"
    RESULTS_JSON.write_text("[]\n", encoding="utf-8")
    FAILED_JSON.write_text("[]\n", encoding="utf-8")
    KEYS_TXT.write_text("", encoding="utf-8")
    meta = {
        "batch_id": BATCH_ID,
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "max_accounts": max_accounts,
        "concurrent": concurrent,
    }
    (BATCH_DIR / "batch_meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[BATCH] id={BATCH_ID}", flush=True)
    print(f"[BATCH] dir={BATCH_DIR}", flush=True)
    return BATCH_ID


def save_result(result: dict[str, Any]) -> None:
    rec = {
        "email": result.get("email"),
        "password": result.get("password"),
        "github_username": result.get("github_username"),
        "api_key": result.get("api_key"),
        "uid": result.get("uid"),
        "mode": result.get("mode"),
        "proxy_country": result.get("proxy_country"),
        "proxy_sessid": result.get("proxy_sessid"),
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    with _batch_io_lock:
        accounts = (
            json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
            if RESULTS_JSON.exists()
            else []
        )
        accounts.append(rec)
        RESULTS_JSON.write_text(
            json.dumps(accounts, indent=2) + "\n", encoding="utf-8"
        )
        with open(KEYS_TXT, "a", encoding="utf-8") as f:
            f.write(
                f"{rec.get('email')}|{rec.get('github_username')}|{rec.get('api_key')}|"
                f"{rec.get('proxy_country')}|{rec.get('mode')}\n"
            )


def save_failure(error: str, email: str = "") -> None:
    with _batch_io_lock:
        failed = (
            json.loads(FAILED_JSON.read_text(encoding="utf-8"))
            if FAILED_JSON.exists()
            else []
        )
        failed.append(
            {
                "email": email,
                "error": error,
                "created_at": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
            }
        )
        FAILED_JSON.write_text(json.dumps(failed, indent=2) + "\n", encoding="utf-8")


def preflight_solver(timeout: float = 8.0) -> tuple[bool, str]:
    try:
        from curl_cffi import requests as creq

        r = creq.get(f"{CAPTCHA_SOLVER_URL}/health", timeout=timeout, impersonate="chrome131")
        if r.status_code < 500:
            return True, f"solver {r.status_code}"
    except Exception:
        pass
    try:
        from curl_cffi import requests as creq

        # some solvers have no /health — root probe
        r = creq.get(CAPTCHA_SOLVER_URL, timeout=timeout, impersonate="chrome131")
        if r.status_code < 500:
            return True, f"solver root {r.status_code}"
        return False, f"solver HTTP {r.status_code}"
    except Exception as e:
        return False, f"solver unreachable: {e}"


def run_one(attempt: int, target: int) -> dict[str, Any]:
    """Full pipeline for one account (blocking)."""
    result: dict[str, Any] = {"ok": False, "attempt": attempt}
    emit_progress(attempt, "START", f"{attempt}/{target}")

    emit_progress(attempt, "HME")
    sticky = build_sticky_proxy()
    if not sticky.get("url"):
        raise RuntimeError("sticky proxy missing — set DI_LOGIN/DI_PASSWORD or GH_PROXY")

    emit_progress(attempt, "GH_CREATE", f"cc={sticky.get('country')}")
    gh = register_http(proxy=sticky)
    result["github"] = {
        k: gh.get(k)
        for k in (
            "ok",
            "error",
            "email",
            "username",
            "password",
            "proxy_url",
            "proxy_country",
            "proxy_sessid",
            "proxy_ip",
        )
    }
    if not gh.get("ok"):
        raise RuntimeError(f"GH_CREATE:{gh.get('error') or 'failed'}")

    email = str(gh.get("email") or "")
    username = str(gh.get("username") or "")
    password = str(gh.get("password") or "")
    proxy_url = str(gh.get("proxy_url") or sticky.get("url") or "")
    result.update(
        {
            "email": email,
            "password": password,
            "github_username": username,
            "proxy_country": gh.get("proxy_country") or sticky.get("country"),
            "proxy_sessid": gh.get("proxy_sessid") or sticky.get("sessid"),
            "proxy_url": proxy_url,
            "proxy_ip": gh.get("proxy_ip"),
            "source": "codebuddy-farm",
            "batch_id": BATCH_ID,
        }
    )
    emit_progress(attempt, "GH_CREATE", "ok", email)

    # Persist GitHub inventory immediately (reusable even if OAuth/mint fails).
    try:
        ok_gh, msg_gh, gh_id = push_github_inventory(
            result, base_url=ETTEUM_URL, api_key=ETTEUM_API_KEY
        )
        if ok_gh:
            if gh_id is not None:
                result["github_account_id"] = gh_id
            emit_progress(attempt, "GH_SAVE", f"id={gh_id or 'ok'}", email)
        else:
            vlog(f"[gh-save] warn: {msg_gh}")
            emit_progress(attempt, "GH_SAVE", f"warn {msg_gh[:80]}", email)
    except Exception as e:
        vlog(f"[gh-save] exception: {e}")
        emit_progress(attempt, "GH_SAVE", f"err {e}", email)

    emit_progress(attempt, "GH_LOGIN", "", email)
    session = make_session(proxy_url or None)
    login_info = gh_login(session, username, password, email=email)
    result["gh_login"] = {
        k: login_info.get(k) for k in ("ok", "error", "login_url", "side_status")
    }
    if not login_info.get("ok"):
        raise RuntimeError(f"GH_LOGIN:{login_info.get('error') or 'failed'}")

    emit_progress(attempt, "OAUTH", "", email)
    oauth = codebuddy_oauth_http(session)
    result["oauth_http"] = {
        k: oauth.get(k)
        for k in (
            "ok",
            "error",
            "authorize_status",
            "authorize_loc",
            "final_url",
            "post_status",
            "post_loc",
        )
    }
    if not oauth.get("ok"):
        err = oauth.get("error") or "oauth failed"
        raise RuntimeError(f"OAUTH:{err}")

    emit_progress(attempt, "MINT", "", email)
    mint = codebuddy_mint_http(session)
    result["mint_http"] = {
        k: mint.get(k)
        for k in ("ok", "error", "uid", "api_key", "create_status", "accounts_status")
    }
    if not mint.get("ok") or not mint.get("api_key"):
        raise RuntimeError(f"MINT:{mint.get('error') or 'no key'}")

    result["api_key"] = mint.get("api_key")
    result["uid"] = mint.get("uid")
    result["mode"] = "pure_http_sticky"
    result["ok"] = True
    return result


async def _worker(
    num: int,
    target: int,
    semaphore: asyncio.Semaphore,
    accounts: list,
    failures: list,
    push_failures: list,
    counter_lock: asyncio.Lock,
    push_on: bool,
) -> None:
    async with semaphore:
        email = ""
        try:
            result = await asyncio.to_thread(run_one, num, target)
            email = str(result.get("email") or "")
            await asyncio.to_thread(save_result, result)

            if not push_on:
                emit_success(num, email, "ok")
                async with counter_lock:
                    accounts.append(result)
                return

            try:
                ok, msg, _payload = await asyncio.to_thread(
                    push_one_farm_result,
                    result,
                    base_url=ETTEUM_URL,
                    api_key=ETTEUM_API_KEY,
                )
            except Exception as e:
                ok, msg = False, str(e)

            if ok:
                emit_success(num, email, "imported")
                async with counter_lock:
                    accounts.append(result)
            else:
                detail = f"PUSH:{msg}"
                emit_failed(num, email, detail)
                await asyncio.to_thread(save_failure, detail, email)
                async with counter_lock:
                    failures.append(detail)
                    push_failures.append(detail)
        except Exception as e:
            detail = str(e)
            emit_failed(num, email or "-", detail[:200])
            await asyncio.to_thread(save_failure, detail, email)
            async with counter_lock:
                failures.append(detail)
        if SPAWN_DELAY > 0:
            await asyncio.sleep(SPAWN_DELAY)


async def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    argv, no_push = parse_push_cli_flags(argv)
    push_on = push_enabled_from_env(no_push_flag=no_push)

    p = argparse.ArgumentParser(description="CodeBuddy HTTP farm (HME → GH → ck_)")
    p.add_argument("-n", "--count", type=int, default=None)
    p.add_argument("-c", "--concurrent", type=int, default=None)
    p.add_argument("-y", "--yes", action="store_true")
    p.add_argument("--http-only", action="store_true", default=True)
    args = p.parse_args(argv)

    max_accounts = max(1, min(100, int(args.count if args.count is not None else MAX_ACCOUNTS)))
    concurrent = max(1, min(5, int(args.concurrent if args.concurrent is not None else CONCURRENT)))

    # Preflight
    if MAIL_BACKEND not in ("icloud_hme", "hme", "icloud"):
        print(f"ERROR: MAIL_BACKEND must be icloud_hme (got {MAIL_BACKEND})", flush=True)
        sys.exit(2)
    if not DI_LOGIN or not DI_PASSWORD:
        print("ERROR: set DI_LOGIN and DI_PASSWORD in scripts/codebuddy-farm/.env", flush=True)
        sys.exit(2)

    ok_h, msg_h = preflight_hme()
    if not ok_h:
        print(f"ERROR: HME preflight failed ({HME_URL}): {msg_h}", flush=True)
        sys.exit(2)

    ok_s, msg_s = preflight_solver()
    if not ok_s:
        print(f"ERROR: captcha solver preflight failed ({CAPTCHA_SOLVER_URL}): {msg_s}", flush=True)
        sys.exit(2)

    if push_on:
        ok_e, msg_e = preflight_etteum(ETTEUM_URL, ETTEUM_API_KEY)
        if not ok_e:
            print(f"ERROR: etteum preflight failed: {msg_e}", flush=True)
            sys.exit(2)

    init_batch(max_accounts, concurrent)
    open_log(BATCH_DIR / "farm.log")
    vlog(
        f"start CodeBuddy farm target={max_accounts} concurrent={concurrent} "
        f"push={push_on} mode={PUSH_MODE}"
    )

    accounts: list = []
    failures: list = []
    push_failures: list = []
    lock = asyncio.Lock()
    sem = asyncio.Semaphore(concurrent)
    t0 = time.time()

    tasks = [
        asyncio.create_task(
            _worker(i + 1, max_accounts, sem, accounts, failures, push_failures, lock, push_on)
        )
        for i in range(max_accounts)
    ]
    await asyncio.gather(*tasks)

    elapsed = round(time.time() - t0, 1)
    meta_path = BATCH_DIR / "batch_meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update(
            {
                "finished_at": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
                "created": len(accounts),
                "failed": len(failures),
                "push_failures": len(push_failures),
                "elapsed_s": elapsed,
                "push_enabled": push_on,
            }
        )
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(
        f"\n OK {len(accounts)}  FAIL {len(failures)}  PUSH_FAIL {len(push_failures)}  "
        f"TOTAL {max_accounts}  OUT {BATCH_DIR}",
        flush=True,
    )

    if max_accounts > 0 and len(accounts) == 0:
        if push_on and push_failures and len(push_failures) == len(failures):
            sys.exit(3)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
