# Grok HTTP farm (in-tree)

HTTP-only xAI Grok CLI account farmer. **Lives inside etteum-pool** — no dependency on folders outside the repo.

**External only:** Boterdrop solver (`BOTERDROP_URL`, default `http://127.0.0.1:8000`).

## Setup

```bash
cd scripts/grok-farm
python -m venv .venv
# Windows: .venv\Scripts\pip install -r requirements.txt
# Linux:   .venv/bin/pip install -r requirements.txt
cp .env.example .env
# edit .env — tempmail key, optional proxies.txt
```

## Run (CLI)

```bash
# Windows
.\run-http.ps1 -n 5 -c 2 -y

# Linux
./run-http.sh -n 5 -c 2 -y
```

Dashboard: **Accounts → Grok CLI → Farm** spawns `http_farm.py` from this directory and pushes into the pool.

## Layout

| File | Role |
|------|------|
| `http_farm.py` | Signup + OAuth + batch |
| `etteum_push.py` | Import client to etteum |
| `requirements.txt` | curl_cffi, requests, dotenv (no browser) |
| `results/` | batch_* outputs (gitignored) |
