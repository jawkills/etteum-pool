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

## Layout

| Path | Role |
|------|------|
| `http_farm.py` | Signup + OAuth + batch |
| `etteum_push.py` | Import client |
| `requirements.txt` | HTTP deps only (no browser) |
| `.env` | Secrets (gitignored) |
| `results/` | Batch output (gitignored) |
