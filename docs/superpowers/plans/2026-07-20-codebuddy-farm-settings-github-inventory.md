# CodeBuddy Farm Settings + GitHub Inventory Plan

> **For agentic workers:** implement task-by-task. Checkboxes track progress.

**Goal:** (1) Configure CodeBuddy farm from dashboard Settings (no mandatory hand-edit of `.env` for daily use). (2) Persist every farmed **GitHub account** as a first-class **inventory** row (`provider=github`) so credentials can be listed, exported, and reused by CodeBuddy farm and future features.

**Architecture:**
- **Settings** live in existing `settings` table (`key`/`value`). Dashboard Settings section edits them. On farm spawn, TS reads settings → injects into child `process.env` (wins over `scripts/codebuddy-farm/.env` because Python uses `load_dotenv(override=False)`).
- **GitHub inventory** reuses `accounts` table with `provider = "github"`. Not a model/proxy provider: **do not** add to `src/proxy/providers/registry.ts` or `config.providers` routing list. Appear only in Accounts UI + dedicated API. Password encrypted with existing `encrypt()`. Core fields in columns + `tokens`/`metadata` JSON for username/proxy.
- **Farm write path:** after successful GH create (even if OAuth/mint fails later), upsert GitHub inventory. On CodeBuddy mint success, create/import CodeBuddy account and store `github_account_id` in its tokens/metadata for traceability.

**Tech stack:** existing Hono API, drizzle `accounts` + `settings`, dashboard Settings + Accounts, Python farm push client.

---

## Ya, maksudmu

```
[Farm] HME + sticky
   → create GitHub
   → SIMPAN inventory provider=github  ← reusable asset
   → OAuth CodeBuddy + mint ck_
   → SIMPAN provider=codebuddy (link ke github_account_id)
```

GitHub bukan “sampah side-effect CodeBuddy”, tapi **akun tersimpan** yang nanti bisa dipakai farm lain / re-mint / export.

---

## Data model (GitHub inventory)

`accounts` row:

| Column | Value |
|--------|--------|
| `provider` | `"github"` |
| `email` | HME / signup email (unique with provider) |
| `password` | encrypted GH password |
| `status` | `active` (usable) / `error` / `suspended` / `used` (optional later) |
| `enabled` | true |
| `tokens` | JSON (not OAuth for routing): see below |
| `metadata` | optional extra |
| `quotaLimit/Remaining` | `-1` or `0` (N/A) |

`tokens` shape (v1 core credentials):

```json
{
  "username": "alex-xxxxxxxx",
  "proxy_country": "sg",
  "proxy_sessid": "cb…",
  "proxy_url": "http://…",          // optional; may omit password-bearing URL in list API
  "proxy_ip": "x.x.x.x",
  "source": "codebuddy-farm",
  "batch_id": "…",
  "farm_mode": "pure_http_sticky"
}
```

**List API must not return decrypted password.** Optional reveal endpoint (same pattern as BYOK reveal) later; v1 export can include password only via authenticated export with explicit flag.

Link from CodeBuddy account `tokens`:

```json
{
  "api_key": "ck_…",
  "github_username": "…",
  "github_account_id": 123,
  "farm_mode": "pure_http_sticky"
}
```

---

## Settings keys (CodeBuddy farm)

Prefix: `codebuddy_farm.`

| Key | Env injected | Notes |
|-----|--------------|--------|
| `codebuddy_farm.hme_url` | `ICLOUD_HME_URL` | |
| `codebuddy_farm.hme_account` | `ICLOUD_HME_ACCOUNT` | |
| `codebuddy_farm.hme_generate_path` | `ICLOUD_HME_GENERATE_PATH` | optional |
| `codebuddy_farm.captcha_solver_url` | `CAPTCHA_SOLVER_URL` | |
| `codebuddy_farm.di_login` | `DI_LOGIN` | secret |
| `codebuddy_farm.di_password` | `DI_PASSWORD` | secret — store encrypted or accept plaintext in settings like other secrets; prefer encrypt-at-rest helper if available |
| `codebuddy_farm.di_host` | `DI_HOST` | default host |
| `codebuddy_farm.di_countries` | `DI_COUNTRIES` | |
| `codebuddy_farm.di_sessttl` | `DI_SESSTTL` | |
| `codebuddy_farm.default_count` | UI only | default dialog count |
| `codebuddy_farm.default_concurrent` | UI only | default concurrent |
| `codebuddy_farm.http_only` | `CODEBUDDY_HTTP_ONLY` | default true |

Resolve order at spawn:

1. Non-empty settings values  
2. Existing `process.env`  
3. Farm package `.env` (Python fallback)

Preflight API (optional P1): `GET /api/accounts/codebuddy/farm/preflight` → HME/solver/DI configured + optional TCP/HTTP reachability.

---

## File map

| Path | Action |
|------|--------|
| `src/auth/codebuddy-farm/settings.ts` | Create — load farm settings from DB, map → env |
| `src/auth/codebuddy-farm/spawn.ts` | Edit — merge settings into `codebuddyFarmChildEnv` |
| `src/api/accounts/github.ts` | Create — import / list helpers / export |
| `src/api/accounts/codebuddy-farm.ts` | Edit — after farm push path already imports CB; ensure GH upsert route used by Python |
| `src/api/accounts/index.ts` | Edit — register github routes |
| `scripts/codebuddy-farm/etteum_push.py` | Edit — `push_github_account` + call from farm |
| `scripts/codebuddy-farm/http_farm.py` | Edit — after GH create success → push GH inventory; keep mint→CB |
| `dashboard/src/pages/Settings.tsx` | Edit — section CodeBuddy Farm |
| `dashboard/src/pages/Accounts.tsx` | Edit — provider `github` in list; Farm dialog defaults from settings; preflight hints |
| `dashboard/src/lib/api.ts` | Edit — settings keys helpers if needed; github export API |
| `dashboard/src/pages/AccountList.tsx` | Edit — label + columns for github inventory |
| `src/config.ts` | Edit only if needed for inventory UI flags — **do not** add github to proxy `providers` list |

---

## API

### GitHub inventory

- `POST /api/accounts/github/import`  
  Body: `{ accounts: [{ email, password, username, proxy_country?, proxy_sessid?, proxy_url?, proxy_ip?, source?, batch_id? }] }`  
  Upsert by `(provider=github, email)`.

- `GET /api/accounts?provider=github` — existing list (ensure provider filter works).

- `GET /api/accounts/github/export?format=txt|json&include_password=0|1`  
  - txt default: `email|username|password?|country|sessid`  
  - password only if `include_password=1` + auth (same API key as dashboard).

### CodeBuddy farm settings

- Reuse `GET/PUT /api/settings` bulk. No new table.
- Optional: `GET /api/accounts/codebuddy/farm/preflight` for dialog badge.

### Farm Python push

Extend `etteum_push.py`:

1. `push_github_inventory(result)` → `POST /api/accounts/github/import`
2. Existing `push_one_farm_result` for `ck_` (include `github_account_id` if import returned id)

Success semantics update (important):

- GH create OK but mint fail → still inventory success for github; CodeBuddy attempt `[FAIL]`.
- Full OK → both rows exist; CB tokens reference `github_account_id`.

---

## Dashboard

### Settings → “CodeBuddy Farm”

Fields matching settings keys; password inputs for DI; Save via existing `updateSettings`.

Help text: external deps HME + solver + DI; `.env` still works as fallback.

### Accounts

- Add **`github`** to provider chips/list (inventory only — no Farm for github v1 unless “import”).
- Card: count active inventory; actions: Export, (optional) bulk delete.
- AccountList: show username from tokens; hide quota; show country badge.
- CodeBuddy Add dialog: load `default_count/concurrent` from settings; short “configured?” line (DI/HME set).

### Do **not**

- Add github to model router / warmup toggles / proxy pool selection.
- Auto-warmup github.

---

## Implementation tasks

### Task 1: GitHub inventory API

- [ ] `src/api/accounts/github.ts` — import upsert, export
- [ ] Register on accounts router
- [ ] Unit/integration smoke: import then list; password not in list JSON

### Task 2: Farm writes GitHub inventory

- [ ] Python `push_github_account` + wire in `run_one` after GH create
- [ ] On CB import, pass `github_account_id` when known
- [ ] Disk batch still keeps full dump

### Task 3: Settings load + spawn inject

- [ ] `settings.ts` load keys from DB
- [ ] `spawn.ts` merge into child env (secrets included)
- [ ] Empty settings → fall through to env/.env

### Task 4: Settings UI

- [ ] Settings.tsx section + form defaults
- [ ] Save/load via existing APIs
- [ ] Mask DI password when re-displaying (show placeholder if set)

### Task 5: Accounts UI inventory + export

- [ ] Provider `github` in Accounts.tsx / AccountList
- [ ] Export button → download txt/json
- [ ] Labels: “GitHub (inventory)”

### Task 6: Farm dialog polish

- [ ] Defaults from settings
- [ ] Optional preflight endpoint + red/green hints

### Task 7: Tests + docs

- [ ] TS tests for settings→env map
- [ ] Python test for github import payload map
- [ ] Update `scripts/codebuddy-farm/README.md` (settings override + inventory)
- [ ] Update plan note in farm plan if needed

---

## Non-goals (v1)

- Re-mint CodeBuddy from existing GH (next feature)
- Storing GH session cookies
- github as proxy model provider
- Multi-user ACL beyond API key

---

## Risks

| Risk | Mitigation |
|------|------------|
| github appears in routing | Never register in `providers` registry; stats already filter `config.providers` |
| Secrets in settings table | Same trust model as API_KEY/BYOK; optional encrypt DI password value |
| List leaks password | Never put decrypted password in list; export opt-in |
| Duplicate emails | Upsert on provider+email; GH create always unique HME alias usually |
| Partial farm failure | Persist GH even if OAuth fails |

---

## Suggested order

1. GitHub import API + Python push after create  
2. Settings inject  
3. Settings UI + Accounts inventory/export  
4. Preflight polish  

---

## Acceptance

1. Save DI/HME/solver in Settings → start farm without editing `.env` (if settings filled).  
2. One successful GH create → row `provider=github` in Accounts.  
3. Full farm success → codebuddy row + github row; CB tokens include `github_account_id`.  
4. Export downloads credentials file.  
5. List accounts API does not include plaintext password.  
6. Proxy/model routing unchanged (no github models).
