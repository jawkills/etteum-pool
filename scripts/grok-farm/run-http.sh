#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ ! -d .venv ]]; then echo "Missing .venv — run ./install.sh"; exit 1; fi
# shellcheck disable=SC1091
source .venv/bin/activate
if [[ ! -f .env ]]; then echo "Missing .env"; exit 1; fi
exec python http_farm.py "$@"
