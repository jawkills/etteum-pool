"""Shared env/config for grok-farm modules."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# ── Env ──────────────────────────────────────────────────────────────────────
def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()

def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")

try:
    from dotenv import load_dotenv
    # Do not override parent-injected env (dashboard sets ETTEUM_API_KEY / ETTEUM_URL).
    # Stale keys in scripts/grok-farm/.env must not clobber a live API key.
    load_dotenv(ROOT / ".env", override=False)
except ImportError:
    env_f = ROOT / ".env"
    if env_f.is_file():
        for line in env_f.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)

# ── Config ───────────────────────────────────────────────────────────────────
SOLVER = _env("BOTERDROP_URL", "http://127.0.0.1:8000").rstrip("/")
MAIL_API = _env("GROK_TEMPMAIL_API_URL", "https://digitalin-id-mail-api.halimcakep45.workers.dev").rstrip("/")
MAIL_KEY = _env("GROK_TEMPMAIL_API_KEY")
PASSWORD = _env("GROK_PASSWORD", "ChangeMe123!")
SITEKEY = "0x4AAAAAAAhr9JGVDZbrZOo0"
BASE = "https://accounts.x.ai"
AUTH = f"{BASE}/auth_mgmt.AuthManagement"
IMPERSONATE = _env("GROK_IMPERSONATE", "firefox135")
PROXY_FILE = _env("GROK_PROXY_FILE", str(ROOT / "proxies.txt"))

XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token"
XAI_AUTHORIZE = "https://auth.x.ai/oauth2/authorize"
XAI_REDIRECT = "http://127.0.0.1:56121/callback"
XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
SERVER_ACTION_ID = _env("GROK_SERVER_ACTION_ID", "401b73e22a5e68737d0037e1aa449fef82cd1b35fb")

MAX_ACCOUNTS = int(_env("GROK_MAX_ACCOUNTS", "1") or "1")
CONCURRENT = int(_env("GROK_CONCURRENT", "1") or "1")
SPAWN_DELAY = float(_env("GROK_SPAWN_DELAY", "2") or "2")
EMAIL_LOCAL_LEN = max(10, min(32, int(_env("GROK_EMAIL_LOCAL_LEN", "16") or "16")))

ETTEUM_URL = _env("ETTEUM_URL", "http://127.0.0.1:1930")
ETTEUM_API_KEY = _env("ETTEUM_API_KEY") or _env("API_KEY")
GROK_PUSH_ETTEUM = _env_bool("GROK_PUSH_ETTEUM", True)
GROK_PUSH_MODE = _env("GROK_PUSH_MODE", "per_success").lower()
GROK_OTP_TIMEOUT = int(_env("GROK_OTP_TIMEOUT", "90") or "90")

RESULTS_ROOT = Path(_env("GROK_RESULTS_DIR", str(ROOT / "results")))
USED_EMAILS_FILE = Path(_env("GROK_USED_EMAILS_FILE", str(RESULTS_ROOT / "used_emails.txt")))
RESULTS_ROOT.mkdir(parents=True, exist_ok=True)

FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Avery", "Parker", "Sage", "River", "Skyler", "Dakota", "Reese", "Finley", "Rowan", "Charlie", "Emerson", "Hayden", "Jamie"]
LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris"]
