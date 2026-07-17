# Grok HTTP Farm + Etteum Push Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HTTP-only Grok CLI farming the default automation path and **always** push successful CPA accounts into etteum-pool (`POST /api/accounts/grok-cli/import`) for internal runs; external runs may opt out with `--no-push`.

**Architecture:** Keep signup/OAuth logic in existing `http_farm.py` (no browser). Add a small pure module `etteum_push.py` for payload mapping + HTTP import client + preflight. Wire push into the worker after each successful signup (`per_success` default). Entry script `run-http.sh` / `run-http.ps1` loads venv, preflights Boterdrop + etteum (when push on), then runs `http_farm.py`. Do not embed farm inside etteum process.

**Tech Stack:** Python 3.10+, `curl_cffi`, `requests`, `python-dotenv`; existing etteum Hono API on port 1930; Boterdrop solver on `:8000`.

**Work roots:**
- Farm code: `C:\Users\Administrator\Documents\bot\grok-farm-share` (**no git repo** — do not invent commits there; leave files on disk; optional local git init only if user later asks)
- Plan/docs: `C:\Users\Administrator\etteum-pool\docs\superpowers\plans\` (commit plan in etteum-pool only if already tracking docs)

**Source of truth — import API (already live):**
- `POST {ETTEUM_URL}/api/accounts/grok-cli/import`
- Header: `Authorization: Bearer {ETTEUM_API_KEY}`
- Body: `{ "accounts": [ { "email": "...", "tokens": { "access_token", "refresh_token", ... } } ] }` or `{ "text": "<json>" }`
- Implemented in etteum: `src/api/accounts.ts` route `grok-cli/import`

**Defaults (internal automation):**
| Env | Default | Meaning |
|-----|---------|---------|
| `GROK_PUSH_ETTEUM` | `true` | Push on success |
| `GROK_PUSH_MODE` | `per_success` | Push each account after signup |
| `ETTEUM_URL` | `http://127.0.0.1:1930` | Etteum base |
| `ETTEUM_API_KEY` | (required if push) | Same as etteum `.env` `API_KEY` |
| `BOTERDROP_URL` | `http://127.0.0.1:8000` | Solver |
| `GROK_OTP_TIMEOUT` | `90` | OTP wait seconds |

**External only:** `--no-push` or `GROK_PUSH_ETTEUM=false` → skip etteum preflight + push; disk batch only.

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `grok-farm-share/etteum_push.py` | Create | Pure: map account→import item, push HTTP, preflight etteum |
| `grok-farm-share/test_etteum_push.py` | Create | Unit tests (no live network) for map + flags + payload |
| `grok-farm-share/http_farm.py` | Modify | CLI `--no-push`, preflight when push on, call push after success, exit codes, OTP timeout env |
| `grok-farm-share/run-http.ps1` | Create | Windows entry (this machine is win32) |
| `grok-farm-share/run-http.sh` | Create | Unix entry |
| `grok-farm-share/.env.example` | Modify | Document `ETTEUM_*`, `GROK_PUSH_*`, `GROK_OTP_TIMEOUT` |
| `grok-farm-share/README.md` | Modify | HTTP default pipeline + internal vs external |
| `grok-farm-share/requirements.txt` | Modify | Comment browser deps optional; HTTP core listed first |

**Do not modify:** `farm.py` browser flow (fallback only), etteum import route (already works).

---

### Task 1: Pure push helpers + unit tests (TDD)

**Files:**
- Create: `C:\Users\Administrator\Documents\bot\grok-farm-share\test_etteum_push.py`
- Create: `C:\Users\Administrator\Documents\bot\grok-farm-share\etteum_push.py`

- [ ] **Step 1: Write failing tests**

```python
# test_etteum_push.py
import unittest
from etteum_push import (
    account_to_import_item,
    build_import_payload,
    push_enabled_from_env,
    parse_push_cli_flags,
)


class TestAccountToImportItem(unittest.TestCase):
    def test_nested_tokens_from_farm_result(self):
        result = {
            "email": "a@x.com",
            "password": "pw",
            "tokens": {
                "access_token": "at",
                "refresh_token": "rt",
                "id_token": "idt",
                "expires_at": "2026-07-17T12:00:00Z",
                "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
            },
        }
        item = account_to_import_item(result)
        self.assertEqual(item["email"], "a@x.com")
        self.assertEqual(item["tokens"]["access_token"], "at")
        self.assertEqual(item["tokens"]["refresh_token"], "rt")
        self.assertNotIn("password", item)

    def test_flat_tokens_still_works(self):
        result = {
            "email": "b@x.com",
            "access_token": "at2",
            "refresh_token": "rt2",
        }
        item = account_to_import_item(result)
        self.assertEqual(item["access_token"], "at2")
        self.assertEqual(item["refresh_token"], "rt2")


class TestBuildPayload(unittest.TestCase):
    def test_wraps_list(self):
        items = [{"email": "a@x.com", "access_token": "a", "refresh_token": "r"}]
        body = build_import_payload(items)
        self.assertEqual(body["accounts"], items)


class TestFlags(unittest.TestCase):
    def test_default_push_on(self):
        self.assertTrue(push_enabled_from_env({}, no_push_flag=False))

    def test_env_false(self):
        self.assertFalse(push_enabled_from_env({"GROK_PUSH_ETTEUM": "false"}, no_push_flag=False))

    def test_cli_no_push_wins(self):
        self.assertFalse(push_enabled_from_env({"GROK_PUSH_ETTEUM": "true"}, no_push_flag=True))

    def test_parse_cli(self):
        rest, no_push = parse_push_cli_flags(["-n", "2", "--no-push", "-y"])
        self.assertTrue(no_push)
        self.assertEqual(rest, ["-n", "2", "-y"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests — expect FAIL**

```powershell
cd C:\Users\Administrator\Documents\bot\grok-farm-share
python -m unittest test_etteum_push.py -v
```

Expected: `ModuleNotFoundError: etteum_push` or import errors.

- [ ] **Step 3: Implement `etteum_push.py`**

```python
# etteum_push.py
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


def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")


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
    """Map http_farm save_result-shaped dict to etteum import item."""
    email = str(result.get("email") or "").strip()
    if not email:
        raise ValueError("email required")
    tokens = result.get("tokens")
    if isinstance(tokens, dict) and (tokens.get("access_token") or tokens.get("accessToken")):
        # Nested harvest format (preferred)
        out: dict[str, Any] = {"email": email, "tokens": dict(tokens)}
        return out
    # Flat
    access = result.get("access_token") or result.get("accessToken")
    refresh = result.get("refresh_token") or result.get("refreshToken")
    if not access or not refresh:
        raise ValueError("access_token and refresh_token required")
    item: dict[str, Any] = {
        "email": email,
        "access_token": access,
        "refresh_token": refresh,
    }
    for k in ("id_token", "expires_at", "client_id", "team_id", "sub"):
        if result.get(k):
            item[k] = result[k]
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
    """
    POST /api/accounts/grok-cli/import
    Returns parsed JSON: { imported, failed, results } or raises.
    """
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
```

- [ ] **Step 4: Run tests — expect PASS**

```powershell
cd C:\Users\Administrator\Documents\bot\grok-farm-share
python -m unittest test_etteum_push.py -v
```

Expected: all OK.

- [ ] **Step 5: Note**

No git in farm-share — skip commit, or only commit plan later in etteum-pool.

---

### Task 2: Wire push + CLI into `http_farm.py`

**Files:**
- Modify: `C:\Users\Administrator\Documents\bot\grok-farm-share\http_farm.py`

- [ ] **Step 1: Add env + imports near config section (after existing `_env` helpers ~line 47–90)**

```python
# After existing config constants:
ETTEUM_URL = _env("ETTEUM_URL", "http://127.0.0.1:1930")
ETTEUM_API_KEY = _env("ETTEUM_API_KEY") or _env("API_KEY")
GROK_PUSH_ETTEUM = _env_bool("GROK_PUSH_ETTEUM", True)
GROK_PUSH_MODE = _env("GROK_PUSH_MODE", "per_success").lower()  # per_success | batch_end
GROK_OTP_TIMEOUT = int(_env("GROK_OTP_TIMEOUT", "90") or "90")
```

Import at top of usable section (lazy ok):

```python
from etteum_push import (
    parse_push_cli_flags,
    push_enabled_from_env,
    preflight_etteum,
    push_one_farm_result,
    push_accounts_to_etteum,
    account_to_import_item,
)
```

- [ ] **Step 2: OTP timeout**

Find `wait_otp(email, 30)` in `run_signup` and change to:

```python
code = wait_otp(email, GROK_OTP_TIMEOUT)
```

- [ ] **Step 3: CLI flags in `main()`**

Before existing arg parse loop, strip push flags:

```python
args = sys.argv[1:]
args, no_push_flag = parse_push_cli_flags(args)
push_on = push_enabled_from_env(no_push_flag=no_push_flag)
```

Use `args` instead of `sys.argv[1:]` in the existing while-loop.

Update help string:

```
Usage: http_farm.py [-n COUNT] [-c CONCURRENT] [-y] [--no-push|--push]
  --no-push   external only: do not import to etteum
  --push      force push (default internal)
```

- [ ] **Step 4: Preflight when push_on**

After MAIL_KEY check, before batch:

```python
if push_on:
    ok, msg = preflight_etteum(ETTEUM_URL, ETTEUM_API_KEY)
    if not ok:
        print(f"ERROR: etteum preflight failed: {msg}", flush=True)
        print("  Set ETTEUM_URL + ETTEUM_API_KEY, start etteum, or use --no-push", flush=True)
        sys.exit(2)
    print(f"[ETTEUM] {msg} push_mode={GROK_PUSH_MODE}", flush=True)
else:
    print("[ETTEUM] push disabled (external mode)", flush=True)
```

- [ ] **Step 5: Push in worker (`per_success`)**

Extend `_worker` signature to accept `push_on: bool` and a shared list `push_failures: list`.

After `save_result(result)`:

```python
if push_on and GROK_PUSH_MODE != "batch_end":
    try:
        resp = await asyncio.to_thread(push_one_farm_result, result)
        imported = int(resp.get("imported") or 0)
        if imported < 1:
            raise RuntimeError(f"import returned imported={imported}: {resp}")
        emit_progress(num, "etteum_push", f"imported {result['email']}", result["email"])
    except Exception as pe:
        async with counter_lock:
            push_failures.append(f"{result.get('email')}: {pe}")
        emit_failed(num, f"push fail: {pe}")
```

- [ ] **Step 6: `batch_end` push + exit codes**

After `gather` workers, if `push_on and GROK_PUSH_MODE == "batch_end"` and `accounts`:

```python
items = [account_to_import_item(a) for a in accounts]
resp = push_accounts_to_etteum(items)
# log imported/failed
```

Write `BATCH_DIR / "push_failed.json"` if any push failures.

Exit:

```python
if max_accounts > 0 and len(accounts) == 0:
    sys.exit(1)
if push_on and len(accounts) > 0:
    # per_success: fail if every push failed
    if GROK_PUSH_MODE != "batch_end" and len(push_failures) >= len(accounts):
        print("ERROR: all etteum pushes failed", flush=True)
        sys.exit(3)
    if GROK_PUSH_MODE == "batch_end":
        # if batch push raised, already exited; if imported 0:
        ...
sys.exit(0)
```

Keep summary.json fields: add `push_failures`, `push_enabled`.

- [ ] **Step 7: Smoke unit path still works**

```powershell
python -m unittest test_etteum_push.py -v
python http_farm.py --help
```

Expected: help shows `--no-push`.

---

### Task 3: Entry scripts Windows + Unix

**Files:**
- Create: `grok-farm-share/run-http.ps1`
- Create: `grok-farm-share/run-http.sh`

- [ ] **Step 1: `run-http.ps1`**

```powershell
# run-http.ps1 — HTTP farm entry (Windows)
param([Parameter(ValueFromRemainingArguments = $true)]$Args)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Missing .venv — create: python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
  exit 1
}
if (-not (Test-Path ".env")) {
  Write-Host "Missing .env — copy .env.example"
  exit 1
}

& "$Root\.venv\Scripts\python.exe" "$Root\http_farm.py" @Args
exit $LASTEXITCODE
```

- [ ] **Step 2: `run-http.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ ! -d .venv ]]; then echo "Missing .venv — run ./install.sh"; exit 1; fi
# shellcheck disable=SC1091
source .venv/bin/activate
if [[ ! -f .env ]]; then echo "Missing .env"; exit 1; fi
exec python http_farm.py "$@"
```

- [ ] **Step 3: chmod on Unix when available**

```bash
chmod +x run-http.sh
```

---

### Task 4: Env example + requirements comments + README

**Files:**
- Modify: `.env.example`
- Modify: `requirements.txt`
- Modify: `README.md`

- [ ] **Step 1: Append to `.env.example`**

```env
# --- Etteum push (internal automation; default ON) ---
# ETTEUM_URL=http://127.0.0.1:1930
# ETTEUM_API_KEY=same-as-etteum-API_KEY
# GROK_PUSH_ETTEUM=true
# GROK_PUSH_MODE=per_success
# GROK_OTP_TIMEOUT=90
# External share-only: GROK_PUSH_ETTEUM=false  or  python http_farm.py --no-push
```

- [ ] **Step 2: `requirements.txt` reorder comments**

```text
# HTTP farm (required)
python-dotenv>=1.0.0
curl_cffi>=0.7.0
requests>=2.31.0

# Browser farm.py only (optional if you only use http_farm)
cloakbrowser[geoip]>=0.4.8
playwright==1.58.0
```

- [ ] **Step 3: README section near top after Quick install**

Add:

```markdown
## HTTP farm (recommended, no browser)

Faster/lighter path: Boterdrop solver + curl_cffi + Digitalin OTP + OAuth.

**Internal (default):** each success is pushed to etteum `POST /api/accounts/grok-cli/import`.

```bash
# Windows
.\run-http.ps1 -n 20 -c 3 -y

# Linux
./run-http.sh -n 20 -c 3 -y
```

**External (disk only):**

```bash
.\run-http.ps1 -n 20 -c 3 -y --no-push
```

Requires: `BOTERDROP_URL`, tempmail key, and for push: `ETTEUM_URL` + `ETTEUM_API_KEY` with etteum running.
```

- [ ] **Step 4: User `.env` (do not commit secrets)**

If local `.env` lacks keys, append (engineer fills real API key from etteum `.env`):

```
ETTEUM_URL=http://127.0.0.1:1930
ETTEUM_API_KEY=<from etteum API_KEY>
GROK_PUSH_ETTEUM=true
GROK_PUSH_MODE=per_success
GROK_OTP_TIMEOUT=90
```

---

### Task 5: Live smoke (manual; stop if infra missing)

**No code** unless bugs found.

- [ ] **Step 1: Preflight**

```powershell
# Boterdrop
try { Invoke-RestMethod http://127.0.0.1:8000/ -TimeoutSec 3 } catch { "solver: $($_.Exception.Message)" }
# Etteum
$key = (Select-String -Path C:\Users\Administrator\etteum-pool\.env -Pattern '^API_KEY=(.+)$').Matches.Groups[1].Value
Invoke-RestMethod http://127.0.0.1:1930/v1/models -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 5 | Out-Null
"etteum ok"
```

- [ ] **Step 2: Dry import unit already passed; optional 1-account farm**

```powershell
cd C:\Users\Administrator\Documents\bot\grok-farm-share
.\.venv\Scripts\python.exe http_farm.py -n 1 -c 1 -y
```

Expected: new `results/batch_*`, etteum has new grok-cli account if push on.

- [ ] **Step 3: If solver/etteum down**

Document failure mode; do not fake success. Unit tests still green = Task 1–4 complete; live smoke marked blocked with reason.

---

## Spec coverage

| Requirement | Task |
|-------------|------|
| HTTP no browser | existing `http_farm.py` + Task 2–3 entry |
| Push etteum **wajib** internal | Task 1–2 default push on |
| External opt-out | `--no-push` / `GROK_PUSH_ETTEUM=false` |
| Preflight abort if etteum down + push on | Task 2 |
| per_success default | Task 2 |
| OTP longer timeout | Task 2 `GROK_OTP_TIMEOUT` |
| run scripts | Task 3 |
| Docs | Task 4 |
| Live verify | Task 5 |

**Placeholder scan:** none intentional.

**Type consistency:** `account_to_import_item` → nested `tokens` preferred; etteum `normalizeGrokCliCpa` accepts both.

---

## Done definition

1. `python -m unittest test_etteum_push.py` all pass  
2. `http_farm.py --help` shows `--no-push`  
3. Internal default: push path called after success (code review)  
4. Push-on + etteum down → exit 2 before farm  
5. README documents internal vs external  
6. Live 1-account smoke if Boterdrop+etteum available  

---

## Execution notes (Windows)

```powershell
cd C:\Users\Administrator\Documents\bot\grok-farm-share
.\.venv\Scripts\python.exe -m unittest test_etteum_push.py -v
.\run-http.ps1 -n 1 -c 1 -y
```

Etteum API key: `C:\Users\Administrator\etteum-pool\.env` → `API_KEY=...`
)
