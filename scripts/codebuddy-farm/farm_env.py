"""Shared env/config for codebuddy-farm modules."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")


try:
    from dotenv import load_dotenv

    # Do not override parent-injected env (dashboard sets ETTEUM_*).
    load_dotenv(ROOT / ".env", override=False)
except ImportError:
    env_f = ROOT / ".env"
    if env_f.is_file():
        for line in env_f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)

# ── Mail / HME ───────────────────────────────────────────────────────────────
MAIL_BACKEND = _env("MAIL_BACKEND", "icloud_hme").lower()
HME_URL = _env("ICLOUD_HME_URL", "http://127.0.0.1:8081").rstrip("/")
HME_ACCOUNT = _env("ICLOUD_HME_ACCOUNT", "acc_main")
HME_GENERATE_PATH = _env("ICLOUD_HME_GENERATE_PATH", "/api/hme/generate")
HME_INBOX_PATH = _env("ICLOUD_HME_INBOX_PATH", "/api/inbox")
HME_HEALTH_PATH = _env("ICLOUD_HME_HEALTH_PATH", "/health")

# ── Captcha / proxy ──────────────────────────────────────────────────────────
CAPTCHA_SOLVER_URL = _env("CAPTCHA_SOLVER_URL", "http://127.0.0.1:8877").rstrip("/")
DI_LOGIN = _env("DI_LOGIN") or _env("DATAIMPULSE_LOGIN")
DI_PASSWORD = _env("DI_PASSWORD") or _env("DATAIMPULSE_PASSWORD")
DI_HOST = _env("DI_HOST", "gw.dataimpulse.com:823")
DI_COUNTRIES = [
    c.strip().lower()
    for c in _env("DI_COUNTRIES", "sg,us,de,nl,id,th,vn,jp").split(",")
    if c.strip()
]
DI_SESSTTL = int(_env("DI_SESSTTL", "15") or "15")
GH_PROXY = _env("GH_PROXY")

# ── GitHub ───────────────────────────────────────────────────────────────────
GH_CLIENT_VERSION = _env(
    "GH_CLIENT_VERSION", "9c975978430e9ad293956f2bbdaf153b1bd84a99"
)
GH_OCTOCAPTCHA_URL = _env(
    "GH_OCTOCAPTCHA_URL",
    "https://octocaptcha.com/datadome?origin_page=github_signup_redesign",
)
GH_REFERER = _env("GH_REFERER", "https://github.com/")
GH_COUNTRY_CODE = _env("GH_COUNTRY_CODE", "SG")
GH_OTP_TIMEOUT = int(_env("GH_OTP_TIMEOUT", "180") or "180")
GH_WARMUP = _env_bool("GH_WARMUP", True)
GH_WARM_STARS = int(_env("GH_WARM_STARS", "1") or "1")
GH_WARM_FOLLOWS = int(_env("GH_WARM_FOLLOWS", "0") or "0")
GH_WARM_FORKS = int(_env("GH_WARM_FORKS", "0") or "0")
GH_STAR_FIRST = _env_bool("GH_STAR_FIRST", True)
GH_PASSWORD = _env("GH_PASSWORD")  # optional fixed password

# ── CodeBuddy ────────────────────────────────────────────────────────────────
CODEBUDDY_BASE = _env("CODEBUDDY_BASE", "https://www.codebuddy.ai").rstrip("/")
OAUTH_CLIENT_ID = _env("CODEBUDDY_OAUTH_CLIENT_ID", "Iv23lijhQ5xyezqGSzfU")
HTTP_ONLY = _env_bool("CODEBUDDY_HTTP_ONLY", True)
IMPERSONATE = _env("CODEBUDDY_IMPERSONATE", "chrome131")
UA = _env(
    "CODEBUDDY_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
)

# ── Batch / push ─────────────────────────────────────────────────────────────
MAX_ACCOUNTS = int(_env("CODEBUDDY_MAX_ACCOUNTS", "1") or "1")
CONCURRENT = int(_env("CODEBUDDY_CONCURRENT", "1") or "1")
SPAWN_DELAY = float(_env("CODEBUDDY_SPAWN_DELAY", "4") or "4")

ETTEUM_URL = _env("ETTEUM_URL", "http://127.0.0.1:1930")
ETTEUM_API_KEY = _env("ETTEUM_API_KEY") or _env("API_KEY")
PUSH_ETTEUM = _env_bool("CODEBUDDY_PUSH_ETTEUM", True)
PUSH_MODE = _env("CODEBUDDY_PUSH_MODE", "per_success").lower()

RESULTS_ROOT = Path(_env("CODEBUDDY_RESULTS_DIR", str(ROOT / "results")))
RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
