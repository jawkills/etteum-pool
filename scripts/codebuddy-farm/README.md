# CodeBuddy farm (in-tree)

HTTP-only CodeBuddy GLOBAL free-key farm:

**iCloud HME → sticky GitHub create → pure-HTTP OAuth → mint `ck_` → push to etteum**

## External dependencies (not bundled)

| Service | Env | Notes |
|---------|-----|--------|
| iCloud HME | `ICLOUD_HME_URL` | xiaozhou26-style; generate alias + inbox OTP |
| DataDome solver | `CAPTCHA_SOLVER_URL` | waguri `/solve` type=datadome; **same sticky proxy/IP** as signup |
| DataImpulse | `DI_LOGIN` / `DI_PASSWORD` | 1 account = 1 sticky sessid |

## Setup

Installer creates `.venv` and copies `.env.example` → `.env` when missing.

**Preferred config:** Dashboard **Settings → CodeBuddy Farm** (saved in DB, injected on spawn).

**Fallback:** `scripts/codebuddy-farm/.env` (used when a setting is empty).

```powershell
cd scripts\codebuddy-farm
# optional local .env — DI_* + HME + CAPTCHA_SOLVER_URL
.\.venv\Scripts\python.exe -u http_farm.py -n 1 -c 1 -y --push
```

## Dashboard

Accounts → CodeBuddy → **Farm** (injects `ETTEUM_*` + Settings, forces log UI + push).

After GH create, credentials are upserted to inventory **`provider=github`** (Accounts → GitHub → Export).
Full success also imports CodeBuddy `ck_` with `github_account_id` link.

### Env resolve order (spawn)

1. Dashboard Settings (`codebuddy_farm.*` → injected env)
2. Process / root etteum env
3. `scripts/codebuddy-farm/.env` (python-dotenv `override=False`)

## Success semantics

With push on (default):

- `[OK]` = key minted **and** imported into pool
- Disk `results/batch_*/` always keeps keys for recovery
- Push fail → `[FAIL] PUSH:…`

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | ≥1 success |
| 1 | zero successes |
| 2 | config / preflight |
| 3 | all outcomes were push failures |

## Layout

| File | Role |
|------|------|
| `http_farm.py` | Entry + batch workers |
| `farm_env.py` | Config |
| `hme.py` | HME alias + OTP |
| `proxy_di.py` | Sticky DI proxy |
| `github_register_http.py` | GH pure-HTTP signup |
| `github_session.py` | GH login + device OTP |
| `codebuddy_oauth.py` | OAuth + mint |
| `etteum_push.py` | Import client |
| `hud.py` | Log contract |
