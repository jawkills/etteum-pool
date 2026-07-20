# CodeBuddy Farm (iCloud HME → GitHub → ck_) Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an in-tree CodeBuddy GLOBAL free-key farm (`scripts/codebuddy-farm`) that creates GitHub accounts via sticky residential IP + **iCloud HME**, runs pure-HTTP OAuth to CodeBuddy, mints `ck_` keys, auto-pushes them into etteum-pool (`provider=codebuddy`), and exposes dashboard start/stop/status mirroring Grok farm.

**Architecture:** Keep farm as a supervised Python child process (same pattern as `scripts/grok-farm` + `src/auth/grok-farm/*`). Do **not** embed browser automation in the etteum Node process. Vendor a self-contained GH HTTP signup module under the farm package (no external `GH_REGISTER_DIR`). Default path is **HTTP-only**; browser/Cloak is out of dashboard scope (CLI optional later). Success = farmed + imported (`imported >= 1`).

**Tech stack:** Python 3.10+, `curl_cffi`, `python-dotenv`; existing Hono API (`POST /api/accounts` bulk `apiKeys` or dedicated import); dashboard Accounts dialog + Bot Logs; external services: **iCloud HME** (`ICLOUD_HME_URL`) + **DataDome captcha solver** (`CAPTCHA_SOLVER_URL`) + **DataImpulse sticky proxy** (`DI_*`).

**Sources of truth (reference packs — copy/adapt, do not leave external path deps):**
- `C:\Users\Administrator\Downloads\Telegram Desktop\codebuddy-farm-windows\codebuddy-farm\codebuddy_farm.py`
- `C:\Users\Administrator\Downloads\Telegram Desktop\github-register-win\github_register_http.py`
- Docs: `FLOW.txt`, `docs/OAUTH_FINDINGS.md`, pack READMEs

**Critical gap to close during vendor:**
Windows `github_register_http.py` currently hard-requires Digitalin (`GROK_MAIL_API_KEY` + `/api/key/mailboxes`). CodeBuddy stable flow needs **iCloud HME**. We must add HME mail backend into the vendored GH register (`MAIL_BACKEND=icloud_hme`) and use HME for signup OTP + device OTP.

---

## Proven pipeline (product behavior)

```
HME generate alias
  → sticky DI proxy (1 account = 1 sessid)
  → DataDome harvest (same proxy/IP + UA)
  → GH pure-HTTP signup + HME OTP
  → GH login same sticky IP (+ device OTP from HME preview)
  → light warm (star max 1)
  → pure-HTTP CodeBuddy OAuth (Keycloak broker → GH authorize → code)
  → region SG + overseas register + trial
  → mint free key POST /console/api/client/v1/api-keys
       {name, expire_in_days:-1, user_enterprise_id:"personal-edition-user-id"}
  → push ck_ into etteum pool (provider=codebuddy)
```

GLOBAL only: `https://www.codebuddy.ai` (not CN).

---

## Defaults / env

| Env | Default | Meaning |
|-----|---------|---------|
| `MAIL_BACKEND` | `icloud_hme` | HME only (v1) |
| `ICLOUD_HME_URL` | `http://127.0.0.1:8081` | xiaozhou26 HME service |
| `ICLOUD_HME_ACCOUNT` | `acc_main` | HME account id |
| `CAPTCHA_SOLVER_URL` | `http://127.0.0.1:8877` | waguri DataDome solver |
| `DI_LOGIN` / `DI_PASSWORD` | (required) | DataImpulse |
| `DI_HOST` | `gw.dataimpulse.com:823` | |
| `DI_COUNTRIES` | `sg,us,de,nl,id,th,vn,jp` | sticky country pool |
| `DI_SESSTTL` | `15` | minutes |
| `GH_WARM_STARS` | `1` | |
| `CODEBUDDY_BASE` | `https://www.codebuddy.ai` | |
| `CODEBUDDY_PUSH_ETTEUM` | `true` | push on success |
| `CODEBUDDY_PUSH_MODE` | `per_success` | |
| `ETTEUM_URL` | injected by dashboard | |
| `ETTEUM_API_KEY` | injected by dashboard | |
| `CODEBUDDY_UI` | `log` | force line logs for parser |
| `CODEBUDDY_HTTP_ONLY` | `true` | dashboard default |

**External only (not shipped):** HME service, captcha solver, residential proxy credentials.

---

## File map

| Path | Action | Responsibility |
|------|--------|----------------|
| `scripts/codebuddy-farm/http_farm.py` | Create | Entry + batch worker/main (dashboard spawn) |
| `scripts/codebuddy-farm/farm_env.py` | Create | Env/config constants |
| `scripts/codebuddy-farm/proxy_di.py` | Create | DataImpulse sticky session builder + probe |
| `scripts/codebuddy-farm/hme.py` | Create | HME create alias + inbox OTP (signup + device) |
| `scripts/codebuddy-farm/github_register_http.py` | Create (vendor+adapt) | Pure HTTP GH signup (HME backend) |
| `scripts/codebuddy-farm/github_session.py` | Create | GH login + verified-device OTP |
| `scripts/codebuddy-farm/codebuddy_oauth.py` | Create | Pure-HTTP OAuth + region/trial + mint |
| `scripts/codebuddy-farm/etteum_push.py` | Create | Preflight + push `ck_` keys to pool |
| `scripts/codebuddy-farm/hud.py` | Create | Log contract (`[STEP]/[OK]`/`[FAIL]`/`[BATCH]`) |
| `scripts/codebuddy-farm/requirements.txt` | Create | `curl_cffi`, `python-dotenv` (no browser) |
| `scripts/codebuddy-farm/.env.example` | Create | Secrets template |
| `scripts/codebuddy-farm/README.md` | Create | Setup + external deps + exit codes |
| `scripts/codebuddy-farm/run-http.ps1` / `run-http.sh` | Create | CLI runners |
| `scripts/codebuddy-farm/tests/*` | Create | Unit tests (proxy, HME URL build, push map, oauth parse fixtures) |
| `src/auth/codebuddy-farm/*` | Create | TS supervisor (spawn/process/farm-queue/log) |
| `src/api/accounts/codebuddy-farm.ts` or extend `codebuddy.ts` | Create/Edit | Routes `/api/accounts/codebuddy/farm` |
| `src/api/accounts/index.ts` | Edit | Register farm routes |
| `src/config.ts` | Edit | `codebuddyFarmDir` / python overrides |
| `dashboard/src/lib/api.ts` | Edit | `startCodeBuddyFarm` / status / stop |
| `dashboard/src/pages/Accounts.tsx` | Edit | Farm UI when provider=codebuddy |
| `install.ps1` / `install.sh` | Edit | venv + `.env` bootstrap for codebuddy-farm |
| `docs/superpowers/plans/2026-07-20-codebuddy-farm-hme-github.md` | Create | This plan |

---

## Log contract (dashboard parser)

Mirror Grok style so Bot Logs + progress banner work:

```
[BATCH] id=...
[BATCH] dir=...
12:34:56  [STEP]  #1  START
12:34:56  [STEP]  #1  HME
12:34:56  [STEP]  #1  user@privaterelay.appleid.com  GH_CREATE
12:34:56  [STEP]  #1  user@...  GH_LOGIN
12:34:56  [STEP]  #1  user@...  OAUTH
12:34:56  [STEP]  #1  user@...  MINT
12:34:56  [OK]  #1  user@...  imported
12:34:56  [FAIL]  #2  other@...  OAUTH:authorize→dashboard
 OK 1  FAIL 1  PUSH_FAIL 0  TOTAL 2  OUT ...
```

TS parser: `src/auth/codebuddy-farm/log.ts` (can start as copy of grok log parser with provider rename).

Exit codes:
| Code | Meaning |
|------|---------|
| 0 | ≥1 success |
| 1 | zero successes |
| 2 | config/preflight (missing HME/DI/solver/key) |
| 3 | all successes failed push only |

---

## Import / push API

Prefer reusing existing bulk create path already in `src/api/accounts/codebuddy.ts`:

- `POST /api/accounts` body `{ provider: "codebuddy", apiKeys: "ck_...\nck_..." }`  
  OR dedicated farm-friendly:

- `POST /api/accounts/codebuddy/import` body:
  ```json
  {
    "accounts": [
      {
        "email": "hme-alias@...",
        "api_key": "ck_...",
        "github_username": "...",
        "password": "...",
        "proxy_country": "sg",
        "mode": "pure_http_sticky"
      }
    ]
  }
  ```

Recommendation: **add dedicated import** that stores richer metadata (email = HME alias or `cb-{ghuser}`, password encrypted optional, tokens `{ api_key, github_username, mode }`) while still creating active pool accounts. Falls back to bulk `apiKeys` if needed for v1 speed.

Success semantics (dashboard default `--push`):
- Disk `results/batch_*/` always written when key minted (recovery).
- `[OK]` only after import `imported >= 1`.
- Push failure → `[FAIL] PUSH:...`.

---

## Implementation tasks

### Task 1: Scaffold Python package + env

- [ ] Create `scripts/codebuddy-farm/` layout + `requirements.txt` + `.env.example` + `README.md`
- [ ] `farm_env.py`: load dotenv (override=False), export all config knobs
- [ ] `proxy_di.py`: port sticky builder from github-register (`build_sticky_proxy`, `probe_proxy_ip`)
- [ ] Unit test sticky URL format (no network)

### Task 2: HME client

- [ ] Implement `hme.py`:
  - create/generate alias (match real HME service endpoints used by your xiaozhou26 instance — verify against live `ICLOUD_HME_URL` OpenAPI or existing working client if available)
  - `wait_signup_otp(alias)`
  - `wait_device_otp(alias)` (subject contains `verify your device`; code from `preview`)
- [ ] Preflight: `GET {ICLOUD_HME_URL}/health` or lightweight inbox probe
- [ ] **Manual verification required:** confirm HME create-alias path against the running service before wiring GH create

> Note: reference `codebuddy_farm.py` only shows inbox poll for device OTP. Alias generation currently lives (or should live) inside GH register HME backend — implement both create + poll here as the single mail module.

### Task 3: Vendor + adapt GH pure-HTTP register (HME)

- [ ] Copy `github_register_http.py` into farm package
- [ ] Replace Digitalin-only mail with backend switch:
  - v1: **only** `icloud_hme` (fail fast if other)
  - `mail_create()` → HME generate alias
  - `mail_otp()` → HME inbox
- [ ] Keep DataDome via `CAPTCHA_SOLVER_URL` + same sticky proxy
- [ ] Keep sticky DI sessid/country on result (`proxy_url`, `proxy_country`, `proxy_sessid`)
- [ ] Optional light warm (star 1) after create if `GH_WARMUP=1`
- [ ] Unit tests with fixture HTML for form_val / payload assembly where cheap

### Task 4: GH login + CodeBuddy OAuth/mint

- [ ] Port `gh_login` + device OTP from `codebuddy_farm.py` → `github_session.py`
- [ ] Port pure-HTTP OAuth + mint → `codebuddy_oauth.py`
  - Client id: `Iv23lijhQ5xyezqGSzfU`
  - Detect soft-fail `authorize → /dashboard` as hard error in HTTP-only mode
  - Region SG + overseas register + trial + mint `expire_in_days:-1`
- [ ] Fixture-based tests for authorize redirect parsing / mint JSON extract

### Task 5: Batch entry + etteum push

- [ ] `http_farm.py` main:
  - CLI: `-n/--count`, `-c/--concurrent` (default 1 — GH sticky safer serial), `-y`, `--push/--no-push`, `--http-only`
  - preflight: HME up, captcha solver up, DI creds present, etteum key when push
  - concurrent workers with semaphore (recommend default concurrent=1; cap ≤3)
  - batch dir under `results/batch_*`
  - structured logs for TS parser
- [ ] `etteum_push.py`: map result → import payload; preflight `/v1/models`; push per success
- [ ] Exit codes 0/1/2/3 as above

### Task 6: TS supervisor + API routes

- [ ] `src/auth/codebuddy-farm/spawn.ts` — resolve venv python + script + child env inject (`ETTEUM_*`, `CODEBUDDY_UI=log`, `CODEBUDDY_HTTP_ONLY=true`)
- [ ] `process.ts` — spawn/kill/line buffer (copy grok pattern)
- [ ] `farm-queue.ts` — single-flight start/stop/status + WS broadcasts (`codebuddy_farm_*`)
- [ ] `log.ts` — parse `[STEP]/[OK]`/`[FAIL]`/`[BATCH]`
- [ ] Routes on accounts router:
  - `POST /api/accounts/codebuddy/farm` `{count, concurrent?}`
  - `GET  /api/accounts/codebuddy/farm`
  - `POST /api/accounts/codebuddy/farm/stop`
  - `POST /api/accounts/codebuddy/import` (if not reusing bulk create)
- [ ] `config.ts`: `codebuddyFarmDir`, optional python overrides
- [ ] Tests: log parser + queue latch (mirror `farm-queue.test.ts`)

### Task 7: Dashboard UI

- [ ] `dashboard/src/lib/api.ts`: `fetchCodeBuddyFarmStatus`, `startCodeBuddyFarm`, `stopCodeBuddyFarm`
- [ ] `Accounts.tsx`:
  - When add/provider = `codebuddy`, show Farm mode (count, concurrent) like Grok
  - Running banner + stop
  - Keep existing bulk `ck_` paste import as second mode
- [ ] WS listeners for `codebuddy_farm_status|started|complete|failed`
- [ ] Bot Logs: ensure provider filter accepts `codebuddy` farm events

### Task 8: Installer + docs

- [ ] `install.ps1` / `install.sh`: create `scripts/codebuddy-farm/.venv`, pip install requirements, copy `.env.example` → `.env` if missing
- [ ] README root blurb optional one-liner under providers/farm
- [ ] `scripts/codebuddy-farm/README.md`: external deps (HME, solver, DI), Windows run notes, no browser default

### Task 9: Smoke / acceptance

- [ ] Unit tests green (no network)
- [ ] Manual smoke (operator):
  1. HME service reachable
  2. Captcha solver reachable
  3. DI credentials set in `scripts/codebuddy-farm/.env`
  4. Dashboard → Accounts → CodeBuddy → Farm count=1 concurrent=1
  5. Expect `[OK] ... imported` and new active account with `ck_` in pool
- [ ] Failure paths: missing DI → exit 2; authorize dashboard soft-fail → `[FAIL]` not hang; push down → disk key retained + FAIL PUSH

---

## Non-goals (v1)

- CodeBuddy China farm
- Browser/Cloak OAuth fallback in dashboard
- Digitalin/tempmail backend
- Reauth queue for CodeBuddy (keys are static `ck_`)
- Shipping HME service or captcha solver binaries

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| GH authorize soft-fail → `/dashboard` | Sticky IP + fresh account + HTTP-only fail fast; concurrent=1 default |
| DataDome IP/UA bind | Solver must use **same** sticky proxy as signup |
| HME API shape unknown in-tree | Task 2 verifies live service before wiring; isolate in `hme.py` |
| Secrets in reference `.env` | Never commit real DI/HME secrets; only `.env.example` |
| Long runtime / timeouts | Generous per-account timeout; process supervisor kill on stop |
| Rate limits on GH | Spawn delay between accounts; low concurrent |

---

## Suggested implementation order

1. Scaffold + HME + vendored GH register (Tasks 1–3)  
2. OAuth/mint + batch entry + push (Tasks 4–5)  
3. TS API + dashboard + installer (Tasks 6–8)  
4. Smoke (Task 9)

---

## Open item for implementer (must resolve in Task 2)

Confirm exact HME HTTP endpoints on the running service (`ICLOUD_HME_URL`), especially **create alias**. Device OTP poll shape is already known from `codebuddy_farm.hme_device_otp` (`GET /api/inbox?account_id&alias&limit&days`). If create-alias path differs by HME fork, document it in `scripts/codebuddy-farm/README.md` and keep one adapter function.
