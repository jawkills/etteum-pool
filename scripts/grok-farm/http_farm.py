#!/usr/bin/env python3
"""
HTTP-only xAI Grok account farmer (no browser / CloakBrowser).

Entry point for dashboard spawn (scripts/grok-farm/http_farm.py).
Implementation split across farm_env, proxy, hud, tempmail, captcha, pb, xai_http, flows.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from farm_env import (
    CONCURRENT,
    ETTEUM_API_KEY,
    ETTEUM_URL,
    GROK_PUSH_MODE,
    MAX_ACCOUNTS,
    PROXY_FILE,
    RESULTS_ROOT,
    ROOT,
    SPAWN_DELAY,
    _env,
    _env_bool,
)
from proxy import ProxyRotator, load_proxy_pool, pick_proxy_from_pool
from hud import HUD, UI_MODE, VERBOSE, emit_failed, emit_progress, emit_success, vlog
from tempmail import _load_used_emails, _persist_used_email
from flows import run_reauth, run_signup, set_proxy_picker
from etteum_push import (
    account_to_import_item,
    parse_push_cli_flags,
    preflight_etteum,
    push_accounts_to_etteum,
    push_enabled_from_env,
    push_one_farm_result,
)

_proxy_file = Path(PROXY_FILE)
if not _proxy_file.is_absolute():
    _proxy_file = (ROOT / _proxy_file).resolve()
PROXY_POOL, PROXY_SOURCE = load_proxy_pool(
    _proxy_file, shuffle=_env_bool("GROK_PROXY_SHUFFLE", False)
)
_proxy_rotator = ProxyRotator(PROXY_POOL, pinned=_env("GROK_HTTP_PROXY") or None)
_batch_io_lock = threading.Lock()


def pick_proxy_sync(exclude: set[str] | None = None) -> str | None:
    return _proxy_rotator.pick(exclude=exclude)


async def next_proxy(exclude: set[str] | None = None) -> str | None:
    return pick_proxy_sync(exclude=exclude)


set_proxy_picker(pick_proxy_sync)

import secrets  # batch id

BATCH_ID = ""
BATCH_DIR: Path = RESULTS_ROOT
RESULTS_JSON: Path = RESULTS_ROOT / "accounts.json"
RESULTS_TXT: Path = RESULTS_ROOT / "accounts.txt"
FAILED_JSON: Path = RESULTS_ROOT / "failed.json"

# Re-export pure helper for tests that still import from http_farm
__all__ = [
    "pick_proxy_from_pool",
    "pick_proxy_sync",
    "main",
]


def init_batch(max_accounts: int, concurrent: int) -> str:
    global BATCH_ID, BATCH_DIR, RESULTS_JSON, RESULTS_TXT, FAILED_JSON
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    short = secrets.token_hex(3)
    BATCH_ID = f"{stamp}_{short}"
    BATCH_DIR = RESULTS_ROOT / f"batch_{BATCH_ID}"
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_JSON = BATCH_DIR / "accounts.json"
    RESULTS_TXT = BATCH_DIR / "accounts.txt"
    FAILED_JSON = BATCH_DIR / "failed.json"
    RESULTS_JSON.write_text("[]\n", encoding="utf-8")
    RESULTS_TXT.write_text("", encoding="utf-8")
    FAILED_JSON.write_text("[]\n", encoding="utf-8")
    meta = {"batch_id": BATCH_ID, "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "max_accounts": max_accounts, "concurrent": concurrent}
    (BATCH_DIR / "batch_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"[BATCH] id={BATCH_ID}", flush=True)
    print(f"[BATCH] dir={BATCH_DIR}", flush=True)
    return BATCH_ID


def save_result(result: dict) -> None:
    """Append farmed account to batch files (disk recovery). Thread-safe RMW."""
    rec = {
        "email": result["email"],
        "password": result["password"],
        "given": result.get("given"),
        "family": result.get("family"),
        "proxy": result.get("proxy"),
        "tokens": result.get("tokens"),
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    with _batch_io_lock:
        _persist_used_email(result["email"])
        accounts = json.loads(RESULTS_JSON.read_text(encoding="utf-8")) if RESULTS_JSON.exists() else []
        accounts.append(rec)
        RESULTS_JSON.write_text(json.dumps(accounts, indent=2) + "\n", encoding="utf-8")
        tok = result.get("tokens") or {}
        with open(RESULTS_TXT, "a", encoding="utf-8") as f:
            f.write(
                f"{result['email']}|{result['password']}|"
                f"{(tok.get('access_token') or '')[:20]}...|"
                f"{tok.get('refresh_token', '')}|{tok.get('expires_at', '')}\n"
            )


def save_failure(error: str) -> None:
    """Append failure record. Thread-safe RMW."""
    with _batch_io_lock:
        failed = json.loads(FAILED_JSON.read_text(encoding="utf-8")) if FAILED_JSON.exists() else []
        failed.append(
            {
                "error": error,
                "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        FAILED_JSON.write_text(json.dumps(failed, indent=2) + "\n", encoding="utf-8")


# ── Main ─────────────────────────────────────────────────────────────────────
def _prompt_int(text: str, default: int, min_v: int = 1, max_v: int = 1000) -> int:
    try: raw = input(f"  {text} [{default}]: ").strip()
    except EOFError: return default
    if not raw: return default
    try: return max(min_v, min(max_v, int(raw)))
    except ValueError: return default


def _prompt_yes_no(question: str, default: bool = True) -> bool:
    try: raw = input(f"  {question} [y/n]: ").strip().lower()
    except EOFError: return default
    if raw == "": return default
    return raw in ("y", "yes", "1", "true")


async def _worker(
    num: int,
    target: int,
    semaphore: asyncio.Semaphore,
    accounts: list,
    failures: list,
    push_failures: list,
    counter_lock: asyncio.Lock,
    push_on: bool,
    reauth_job: dict | None = None,
    pending_batch: list | None = None,
) -> None:
    """Run one signup/reauth.

    Success semantics (dashboard uses per_success + --push):
      - Disk save always happens when tokens are obtained (recovery).
      - [OK] / accounts[] only after etteum import imported>=1 when push_on.
      - Push failure → [FAIL] PUSH:... (counts as failed, not success).
      - batch_end: defer [OK] until batch push in main (pending_batch).
      - push off (--no-push): [OK] means farmed tokens only.
    """
    async with semaphore:
        try:
            if reauth_job:
                result = await asyncio.to_thread(
                    run_reauth,
                    num,
                    target,
                    str(reauth_job.get("email") or ""),
                    str(reauth_job.get("password") or ""),
                )
            else:
                result = await asyncio.to_thread(run_signup, num, target)

            # Always persist tokens to batch dir for recovery (even if push fails).
            await asyncio.to_thread(save_result, result)

            if not push_on:
                emit_success(num, result["email"], "ok")
                async with counter_lock:
                    accounts.append(result)
                return

            if GROK_PUSH_MODE == "batch_end":
                # Defer success until batch push in main.
                async with counter_lock:
                    if pending_batch is not None:
                        pending_batch.append((num, result))
                    else:
                        accounts.append(result)
                return

            # per_success (default for dashboard): OK only after import.
            try:
                resp = await asyncio.to_thread(push_one_farm_result, result)
                imported = int((resp or {}).get("imported") or 0) if isinstance(resp, dict) else 0
                if imported < 1:
                    err = f"PUSH:imported={imported}"
                    emit_failed(num, err, err)
                    async with counter_lock:
                        failures.append(err)
                        push_failures.append(
                            {
                                "email": result.get("email"),
                                "error": f"imported={imported}",
                                "resp": resp,
                            }
                        )
                    return
                emit_success(num, result["email"], "imported")
                async with counter_lock:
                    accounts.append(result)
            except Exception as pe:
                err = f"PUSH:{pe}"
                emit_failed(num, err, err)
                async with counter_lock:
                    failures.append(err)
                    push_failures.append({"email": result.get("email"), "error": str(pe)})
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            emit_failed(num, err)
            async with counter_lock:
                failures.append(err)
            await asyncio.to_thread(save_failure, err)


async def main():
    args, no_push_flag = parse_push_cli_flags(sys.argv[1:])
    push_on = push_enabled_from_env(no_push_flag=no_push_flag)

    arg_count: int | None = None
    arg_conc: int | None = None
    skip_prompt = False
    reauth_file: str | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-n", "--count", "--max") and i + 1 < len(args): arg_count = int(args[i + 1]); i += 2; continue
        if a in ("-c", "--concurrent") and i + 1 < len(args): arg_conc = int(args[i + 1]); i += 2; continue
        if a in ("-y", "--yes", "--non-interactive"): skip_prompt = True; i += 1; continue
        if a == "--reauth-file" and i + 1 < len(args):
            reauth_file = args[i + 1]
            i += 2
            continue
        if a in ("-h", "--help"):
            print(
                "Usage: http_farm.py [-n COUNT] [-c CONCURRENT] [-y] [--no-push|--push]\n"
                "       http_farm.py --reauth-file PATH [-c CONCURRENT] [-y] [--push]\n"
                "  -n/--count       accounts this batch (signup mode)\n"
                "  -c/--concurrent  parallel workers\n"
                "  -y/--yes         non-interactive\n"
                "  --reauth-file    JSON list [{email,password}, ...] — login existing, no tempmail\n"
                "  --no-push        skip etteum import push\n"
                "  --push           enable etteum import push (default)\n"
            )
            sys.exit(0)
        i += 1

    reauth_jobs: list[dict] = []
    if reauth_file:
        p = Path(reauth_file)
        if not p.is_file():
            print(f"ERROR: --reauth-file not found: {reauth_file}", flush=True)
            sys.exit(2)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"ERROR: invalid reauth JSON: {e}", flush=True)
            sys.exit(2)
        if not isinstance(raw, list) or not raw:
            print("ERROR: --reauth-file must be a non-empty JSON array", flush=True)
            sys.exit(2)
        for row in raw:
            if not isinstance(row, dict):
                continue
            em = str(row.get("email") or "").strip()
            pw = str(row.get("password") or "").strip()
            if em and pw:
                reauth_jobs.append({"email": em, "password": pw})
        if not reauth_jobs:
            print("ERROR: no valid {email,password} entries in reauth file", flush=True)
            sys.exit(2)
        # Reauth does not need tempmail.
    elif not MAIL_KEY:
        print("ERROR: set GROK_TEMPMAIL_API_KEY in .env", flush=True)
        sys.exit(2)

    if push_on:
        ok, msg = preflight_etteum(ETTEUM_URL, ETTEUM_API_KEY)
        if not ok:
            print(f"ERROR: etteum preflight failed: {msg}", flush=True)
            sys.exit(2)

    _bi = __builtins__
    _orig_p = _bi.print
    _bi.print = lambda *a, **k: None
    try: _load_used_emails()
    finally: _bi.print = _orig_p

    if reauth_jobs:
        max_accounts = len(reauth_jobs)
        concurrent = arg_conc if arg_conc is not None else CONCURRENT
        skip_prompt = True
    elif skip_prompt:
        max_accounts = arg_count if arg_count is not None else MAX_ACCOUNTS
        concurrent = arg_conc if arg_conc is not None else CONCURRENT
    else:
        max_accounts = arg_count if arg_count is not None else _prompt_int("Total accounts", MAX_ACCOUNTS)
        concurrent = arg_conc if arg_conc is not None else _prompt_int("Total concurrency", CONCURRENT)
        if not _prompt_yes_no(f"Start {max_accounts} accounts with {concurrent} concurrency", True):
            print("Cancelled."); sys.exit(0)
        sys.stdout.write("\033[3A")
        for _ in range(3): sys.stdout.write("\033[2K\n")
        sys.stdout.write("\033[3A")
        sys.stdout.flush()

    max_accounts = max(1, min(1000, int(max_accounts)))
    concurrent = max(1, min(20, int(concurrent)))

    _bi.print = lambda *a, **k: None
    try: init_batch(max_accounts, concurrent)
    finally: _bi.print = _orig_p

    log_path = BATCH_DIR / "farm.log"
    HUD.open_log(log_path)
    HUD.start(max_accounts, batch_id=BATCH_ID, batch_dir=str(BATCH_DIR))

    _orig_print2 = _orig_p
    if HUD.enabled and not VERBOSE:
        _orig_print2 = _bi.print
        def _quiet_print(*_a, **_k):
            sep = _k.get("sep", " ")
            msg = sep.join(str(x) for x in _a)
            HUD.log_line(msg)
        _bi.print = _quiet_print

    accounts: list = []
    failures: list = []
    push_failures: list = []
    # (attempt_num, result) waiting for batch_end push before counting as success.
    pending_batch: list = []
    semaphore = asyncio.Semaphore(concurrent)
    counter_lock = asyncio.Lock()
    started = time.time()
    tick = asyncio.create_task(HUD.ticker())

    try:
        tasks = []
        for num in range(1, max_accounts + 1):
            if SPAWN_DELAY > 0 and num > 1: await asyncio.sleep(SPAWN_DELAY)
            job = reauth_jobs[num - 1] if reauth_jobs else None
            t = asyncio.create_task(
                _worker(
                    num,
                    max_accounts,
                    semaphore,
                    accounts,
                    failures,
                    push_failures,
                    counter_lock,
                    push_on,
                    reauth_job=job,
                    pending_batch=pending_batch,
                )
            )
            tasks.append(t)
        await asyncio.gather(*tasks)
    except KeyboardInterrupt:
        print("\nInterrupted.", flush=True)
    finally:
        tick.cancel()
        try: await tick
        except (asyncio.CancelledError, Exception): pass
        _bi.print = _orig_print2 if HUD.enabled else _orig_p
        HUD.stop()
        HUD.close_log()

    # batch_end: push all farmed tokens, then emit [OK]/[FAIL] so dashboard counters stay honest.
    if push_on and GROK_PUSH_MODE == "batch_end" and pending_batch:
        try:
            items = [account_to_import_item(r) for _, r in pending_batch]
            resp = push_accounts_to_etteum(items)
            imported = int((resp or {}).get("imported") or 0) if isinstance(resp, dict) else 0
            if imported >= len(pending_batch):
                for num, result in pending_batch:
                    emit_success(num, result["email"], "imported")
                    accounts.append(result)
            else:
                # Partial/zero batch import: treat all as push failures (no silent success).
                for num, result in pending_batch:
                    err = f"PUSH:batch imported={imported}/{len(pending_batch)}"
                    emit_failed(num, err, err)
                    failures.append(err)
                    push_failures.append(
                        {
                            "email": result.get("email"),
                            "error": f"batch imported={imported}/{len(pending_batch)}",
                            "resp": resp,
                        }
                    )
        except Exception as pe:
            for num, result in pending_batch:
                err = f"PUSH:{pe}"
                emit_failed(num, err, err)
                failures.append(err)
                push_failures.append({"email": result.get("email"), "error": str(pe)})

    if push_failures:
        (BATCH_DIR / "push_failed.json").write_text(
            json.dumps(push_failures, indent=2) + "\n", encoding="utf-8"
        )

    elapsed = int(time.time() - started)
    summary_data = {
        "batch_id": BATCH_ID,
        "target": max_accounts,
        "concurrent": concurrent,
        "success": len(accounts),
        "failed": len(failures),
        "elapsed_s": elapsed,
        "out_dir": str(BATCH_DIR),
        "push_enabled": push_on,
        "push_failures": len(push_failures),
    }
    (BATCH_DIR / "summary.json").write_text(json.dumps(summary_data, indent=2) + "\n", encoding="utf-8")
    meta_path = BATCH_DIR / "batch_meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["finished_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        meta["created"] = len(accounts); meta["failed"] = len(failures); meta["elapsed_s"] = elapsed
        meta["push_enabled"] = push_on; meta["push_failures"] = len(push_failures)
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(
        f"\n OK {len(accounts)}  FAIL {len(failures)}  PUSH_FAIL {len(push_failures)}  "
        f"TOTAL {max_accounts}  OUT {BATCH_DIR}",
        flush=True,
    )

    # Exit codes (see README):
    #   1 = zero pool successes (farm and/or push all failed)
    #   3 = push was on and every outcome was a push failure (tokens may still be on disk)
    if max_accounts > 0 and len(accounts) == 0:
        if (
            push_on
            and len(push_failures) > 0
            and len(push_failures) == len(failures)
        ):
            sys.exit(3)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
