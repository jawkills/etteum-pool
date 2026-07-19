# Grok HTTP farm (in-tree)

HTTP-only xAI Grok CLI account farmer. **Ships inside etteum-pool** — no path outside the repo.

## After `git clone` / installer

The main installer (`install.sh` / `install.ps1`) automatically:

1. Creates `scripts/grok-farm/.venv`
2. Installs `requirements.txt` (`curl_cffi`, `requests`, `python-dotenv`)
3. Copies `.env.example` → `.env` if missing

You only need to:

1. **Edit** `scripts/grok-farm/.env` — set `GROK_TEMPMAIL_API_KEY` (and password if desired)
2. **Run Boterdrop** externally at `BOTERDROP_URL` (default `http://127.0.0.1:8000`)
3. Start etteum → **Accounts → Grok CLI → Farm**

## External dependency (only)

| Service | Env | Notes |
|---------|-----|--------|
| Boterdrop solver | `BOTERDROP_URL` | CF clearance + Turnstile — **not** bundled |

Everything else (farm code, push to etteum, OAuth) is in this package.

## Manual setup (if installer skipped)

```bash
cd scripts/grok-farm
python3 -m venv .venv
# Windows: .venv\Scripts\pip install -r requirements.txt
# Linux:   .venv/bin/pip install -r requirements.txt
cp .env.example .env   # then edit secrets
```

## CLI (optional)

```bash
# Windows
.\run-http.ps1 -n 5 -c 2 -y

# Linux
./run-http.sh -n 5 -c 2 -y
```

Dashboard injects `ETTEUM_URL` + `ETTEUM_API_KEY` and forces `--push` so accounts land in the pool.

## Success semantics (important)

With push enabled (dashboard default / `--push`):

- **`[OK]` means farmed + imported into the pool** (`imported >= 1`).
- Disk `results/.../accounts.json` is still written when tokens are obtained (recovery).
- Push/import failure emits **`[FAIL] … PUSH:…`** and counts as a farm failure (not success).
- Without push (`--no-push` / `GROK_PUSH_ETTEUM=false`), `[OK]` means tokens farmed only.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Finished with at least one success (or zero-target edge cases) |
| `1` | Zero accounts succeeded (all farm or push failed) |
| `2` | Config / preflight error (missing key, solver, etc.) |
| `3` | Push was on, some tokens farmed, but **every** success path failed push |

## Log contract (`GROK_UI=log`, dashboard)

```
[BATCH] dir=...
12:34:56  [STEP]  #1  user@x.com  OTP
12:34:56  [OK]  #1  user@x.com  imported
12:34:56  [FAIL]  #2  other@x.com  PUSH:imported=0
 OK 1  FAIL 1  PUSH_FAIL 1  TOTAL 2  OUT ...
```

TS parser: `src/auth/grok-farm-queue.ts` → `parseGrokFarmLogLine`.

## Layout

| Path | Role |
|------|------|
| `http_farm.py` | Entry + batch worker/main (dashboard spawn) |
| `farm_env.py` | Env/config constants |
| `proxy.py` | Proxy normalize + thread-safe rotation |
| `hud.py` | ANSI HUD + human log + NDJSON `GROK_EVENT` |
| `tempmail.py` | Mailbox + OTP |
| `captcha.py` | Boterdrop clearance/turnstile |
| `pb.py` | gRPC-Web / protobuf helpers |
| `xai_http.py` | XAI session + OAuth tokens |
| `flows.py` | `run_signup` / `run_reauth` |
| `etteum_push.py` | Import client |
| `fixtures/` | Golden CPA shapes shared with TS tests |
| `test_*.py` | Unit tests (proxy rotation, push map) |
| `requirements.txt` | HTTP deps only (no browser) |
| `.env` | Secrets (gitignored) |
| `results/` | Batch output (gitignored) |

## Tests

```bash
cd scripts/grok-farm
# with venv active:
python -m unittest discover -s tests -v
```
