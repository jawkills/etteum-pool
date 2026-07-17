#!/usr/bin/env bash
# HTTP farm entry (Linux/macOS) — prefers in-tree .venv
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "Created .env from .env.example — set GROK_TEMPMAIL_API_KEY and BOTERDROP_URL"
  else
    echo "Missing .env"
    exit 1
  fi
fi

if [[ -x .venv/bin/python ]]; then
  exec .venv/bin/python http_farm.py "$@"
fi

# Fallback: system python with deps
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c "import curl_cffi" 2>/dev/null; then
    exec "$py" http_farm.py "$@"
  fi
done

echo "No Python with curl_cffi found."
echo "  Re-run repo install.sh, or:"
echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
exit 1
